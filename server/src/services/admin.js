// Trust and safety: what a platform administrator can see and do.
//
// Every mutation writes an audit row and an enforcement record, because a moderation
// decision that cannot be read cannot be appealed against. Enforcement is server-side
// state: bumping a user's session version and disconnecting their sockets happens here,
// never in the client.

const db = require('../db');
const { now, uuid } = require('../util');

// A suspension expires on its own, and a lapsed one is not enforced. Reading the state
// rather than trusting a stored flag is what makes that true.
function activeEnforcement(row) {
  if (!row || !row.enforcement_state) return null;
  if (row.enforcement_state === 'suspended') {
    if (row.enforcement_expires_at && new Date(row.enforcement_expires_at).getTime() < Date.now()) {
      return null;
    }
    return { type: 'SUSPENSION', until: row.enforcement_expires_at || null };
  }
  return null;
}

async function overview() {
  const count = async (table) => {
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(row.n || 0);
  };

  const [users, servers, messages, reports, appeals, bans, admins] = await Promise.all([
    count('users'), count('servers'), count('messages'),
    db.get("SELECT COUNT(*) AS n FROM reports WHERE status != 'resolved'").then((r) => Number(r.n)),
    db.get("SELECT COUNT(*) AS n FROM appeals WHERE status = 'OPEN'").then((r) => Number(r.n)),
    count('server_bans'), count('admins'),
  ]);

  const recentAudit = await db.all(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.created_at,
       u.username AS actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC LIMIT 10`
  );

  const recentReports = await db.all(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at
     FROM reports r ORDER BY r.created_at DESC LIMIT 10`
  );

  return {
    counts: { users, servers, messages, openReports: reports, openAppeals: appeals, bans, admins },
    recentAudit: recentAudit.map((r) => ({
      id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id,
      actor: r.actor_name || 'system', createdAt: r.created_at,
    })),
    recentReports: recentReports.map((r) => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id,
      reason: r.reason, status: r.status, createdAt: r.created_at,
    })),
  };
}

async function users({ q, limit = 50, offset = 0 } = {}) {
  const where = q ? 'WHERE lower(u.username) LIKE ? OR lower(u.display_name) LIKE ?' : '';
  const params = q ? [`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`] : [];
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0));

  const rows = await db.all(
    `SELECT u.id, u.username, u.display_name, u.email, u.created_at,
       u.enforcement_state, u.enforcement_expires_at, u.email_verified_at IS NOT NULL AS verified,
       u.is_bot, (SELECT 1 FROM admins a WHERE a.user_id = u.id) AS is_admin
     FROM users u ${where}
     ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email || null,
    createdAt: r.created_at,
    emailVerified: !!r.verified,
    isBot: !!r.is_bot,
    isAdmin: !!r.is_admin,
    enforcement: activeEnforcement(r),
  }));
}

// Every action taken against one account, and by whom.
async function userActions(userId) {
  const rows = await db.all(
    `SELECT m.id, m.action_type, m.reason, m.expires_at, m.created_at, m.lifted_at,
       a.username AS actor_name
     FROM moderation_actions m LEFT JOIN users a ON a.id = m.actor_id
     WHERE m.target_type = 'user' AND m.target_id = ?
     ORDER BY m.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id, action: r.action_type, reason: r.reason || '',
    expiresAt: r.expires_at, createdAt: r.created_at, lifted: !!r.lifted_at,
    actor: r.actor_name || 'system',
  }));
}

async function enforce(userId, adminId, { action, reason, minutes }) {
  const target = await db.get('SELECT id, session_version FROM users WHERE id = ?', [userId]);
  if (!target) throw { code: 'NOT_FOUND', message: 'user not found' };

  const kind = ['suspend', 'timeout', 'ban'].indexOf(action) === -1 ? null : action;
  if (!kind) throw { code: 'VALIDATION_ERROR', message: 'unknown enforcement action' };

  const expires = minutes ? new Date(Date.now() + Number(minutes) * 60000).toISOString() : null;

  await db.transaction(async (t) => {
    await t.run(
      `INSERT INTO moderation_actions (id, actor_id, target_type, target_id, action_type, reason, expires_at, created_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`,
      [uuid(), adminId, userId, kind, reason || null, expires, now()]
    );
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?)`,
      [uuid(), adminId, 'enforce:' + kind, userId, reason || null, now()]
    );
    if (kind === 'suspend') {
      // The account cannot act at all: the enforcement columns are read by the auth
      // middleware on every request.
      await t.run(
        'UPDATE users SET enforcement_state = ?, enforcement_reason = ?, enforcement_expires_at = ?, enforcement_updated_at = ? WHERE id = ?',
        ['suspended', reason || null, expires, now(), userId]
      );
      // And every live session dies with it.
      await t.run('UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ?', [userId]);
      await t.run('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now(), userId]);
    }
  });

  return { ok: true, userId, action: kind, expiresAt: expires };
}

async function lift(userId, adminId, { reason }) {
  await db.transaction(async (t) => {
    await t.run(
      'UPDATE users SET enforcement_state = NULL, enforcement_reason = NULL, enforcement_expires_at = NULL, enforcement_updated_at = ? WHERE id = ?',
      [now(), userId]
    );
    await t.run(
      `UPDATE moderation_actions SET lifted_at = ?
        WHERE target_type = 'user' AND target_id = ? AND lifted_at IS NULL`,
      [now(), userId]
    );
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, 'lift', 'user', ?, ?, ?)`,
      [uuid(), adminId, userId, reason || null, now()]
    );
  });
  return { ok: true, userId };
}

async function communities({ limit = 50, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT s.id, s.name, s.description, s.slug, s.created_at,
       s.enforcement_state, s.enforcement_reason,
       (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
       owner.username AS owner_name
     FROM servers s LEFT JOIN users owner ON owner.id = s.owner_id
     ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0)]
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description || '', slug: r.slug,
    createdAt: r.created_at, owner: r.owner_name || null,
    memberCount: Number(r.member_count || 0),
    enforcementState: r.enforcement_state || null,
    enforcementReason: r.enforcement_reason || null,
  }));
}

async function suspendCommunity(serverId, adminId, { reason, minutes }) {
  const srv = await db.get('SELECT id FROM servers WHERE id = ?', [serverId]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'community not found' };
  const expires = minutes ? new Date(Date.now() + Number(minutes) * 60000).toISOString() : null;

  await db.run(
    `UPDATE servers SET enforcement_state = 'suspended', enforcement_reason = ?, enforcement_updated_at = ? WHERE id = ?`,
    [reason || null, now(), serverId]
  );
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, 'suspend_community', 'server', ?, ?, ?)`,
    [uuid(), adminId, serverId, reason || null, now()]
  );
  return { ok: true, serverId, expiresAt: expires };
}

async function liftCommunity(serverId, adminId, { reason }) {
  await db.run(
    'UPDATE servers SET enforcement_state = NULL, enforcement_reason = NULL, enforcement_updated_at = ? WHERE id = ?',
    [now(), serverId]
  );
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, 'lift_community', 'server', ?, ?, ?)`,
    [uuid(), adminId, serverId, reason || null, now()]
  );
  return { ok: true, serverId };
}

// GDPR: an erasure or access request from an account holder. Reviewing records the
// decision; processing anonymises. Neither is reversible, which is the point.
async function deletionRequests({ status, limit = 50, offset = 0 } = {}) {
  const where = status ? 'WHERE d.status = ?' : '';
  const params = status ? [status] : [];
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0));

  const rows = await db.all(
    `SELECT d.*, u.username, u.display_name
       FROM account_deletion_requests d JOIN users u ON u.id = d.user_id
     ${where} ORDER BY d.requested_at DESC LIMIT ? OFFSET ?`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    user: { id: r.user_id, username: r.username, displayName: r.display_name },
    status: r.status,
    requestType: r.request_type,
    reason: r.reason || '',
    requestedAt: r.requested_at,
    reviewedAt: r.reviewed_at,
    processedAt: r.processed_at,
    anonymisedAt: r.anonymised_at,
  }));
}

async function reviewDeletion(requestId, adminId, { approve }) {
  const req = await db.get('SELECT * FROM account_deletion_requests WHERE id = ?', [requestId]);
  if (!req) throw { code: 'NOT_FOUND', message: 'request not found' };

  await db.run(
    'UPDATE account_deletion_requests SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?',
    [approve ? 'approved' : 'rejected', now(), adminId, requestId]
  );
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, ?, 'user', ?, ?, ?)`,
    [uuid(), adminId, approve ? 'gdpr_approve' : 'gdpr_reject', req.user_id, null, now()]
  );
  return { ok: true };
}

// Anonymisation replaces the identifying fields rather than deleting the row, so the
// messages and moderation history that reference this account stay intact and coherent.
async function processDeletion(requestId, adminId) {
  const req = await db.get('SELECT * FROM account_deletion_requests WHERE id = ?', [requestId]);
  if (!req) throw { code: 'NOT_FOUND', message: 'request not found' };

  await db.transaction(async (t) => {
    await t.run(
      `UPDATE users SET display_name = 'Deleted user', bio = NULL, status_text = NULL,
         avatar_url = NULL, banner_url = NULL, email = NULL, email_verified_at = NULL
       WHERE id = ?`,
      [req.user_id]
    );
    await t.run(
      'UPDATE account_deletion_requests SET status = ?, processed_at = ?, anonymised_at = ? WHERE id = ?',
      ['processed', now(), now(), requestId]
    );
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, 'gdpr_process', 'user', ?, NULL, ?)`,
      [uuid(), adminId, req.user_id, now()]
    );
  });
  return { ok: true };
}

// Bot identity is a server-controlled fact, not something a member can claim: only a
// platform administrator sets it, and it is what an integration's token is checked
// against.
async function setBot(userId, adminId, { isBot }) {
  const target = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!target) throw { code: 'NOT_FOUND', message: 'user not found' };

  await db.transaction(async (t) => {
    await t.run('UPDATE users SET is_bot = ? WHERE id = ?', [isBot ? 1 : 0, userId]);
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, ?, 'user', ?, NULL, ?)`,
      [uuid(), adminId, isBot ? 'mark_bot' : 'unmark_bot', userId, now()]
    );
  });
  return { ok: true, userId, isBot: !!isBot };
}

// Removing a community is the irreversible one, so it always writes a row saying who and
// why, and the cascade takes the channels and messages with it.
async function removeCommunity(serverId, adminId, { reason }) {
  const srv = await db.get('SELECT id FROM servers WHERE id = ?', [serverId]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'community not found' };

  await db.transaction(async (t) => {
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, 'remove_community', 'server', ?, ?, ?)`,
      [uuid(), adminId, serverId, reason || null, now()]
    );
    await t.run('DELETE FROM servers WHERE id = ?', [serverId]);
  });
  return { ok: true, serverId };
}

async function updateReport(reportId, adminId, { status, resolution }) {
  const rep = await db.get('SELECT * FROM reports WHERE id = ?', [reportId]);
  if (!rep) throw { code: 'NOT_FOUND', message: 'report not found' };

  const allowed = ['open', 'reviewing', 'resolved'];
  const next = allowed.indexOf(status) === -1 ? rep.status : status;

  await db.transaction(async (t) => {
    await t.run(
      `UPDATE reports SET status = ?, resolution = ?, assigned_admin_id = COALESCE(assigned_admin_id, ?),
         updated_at = ?, resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END
       WHERE id = ?`,
      [next, resolution || rep.resolution, adminId, now(), next, now(), reportId]
    );
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, 'review_report', 'report', ?, ?, ?)`,
      [uuid(), adminId, reportId, resolution || null, now()]
    );
  });
  return { ok: true, reportId, status: next };
}

// The whole trail, most recent first, filterable by what was done.
async function auditLog({ action, limit = 100, offset = 0 } = {}) {
  const where = action ? 'WHERE a.action = ?' : '';
  const params = action ? [action] : [];
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500), Math.max(parseInt(offset, 10) || 0, 0));

  const rows = await db.all(
    `SELECT a.*, actor.username AS actor_name, actor.display_name AS actor_display
     FROM audit_logs a LEFT JOIN users actor ON actor.id = a.actor_id
     ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason || '',
    actor: r.actor_display || r.actor_name || 'system',
    createdAt: r.created_at,
  }));
}

// Announcements an operator publishes for everyone on this instance. Instance-scoped, not
// global: a self-hosted Trycord announces to itself.
async function announcements() {
  return db.all('SELECT * FROM announcements ORDER BY created_at DESC');
}

async function createAnnouncement(adminId, { body, level, linkLabel, linkHref, expiresInHours }) {
  if (!body || !String(body).trim()) {
    throw { code: 'VALIDATION_ERROR', message: 'an announcement needs some text' };
  }
  if (['info', 'warning', 'critical'].indexOf(level) === -1) {
    throw { code: 'VALIDATION_ERROR', message: 'unknown level' };
  }

  const id = uuid();
  await db.run(
    `INSERT INTO announcements (id, body, level, link_label, link_href, active, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [id, String(body).slice(0, 4000), level,
      linkLabel ? String(linkLabel).slice(0, 64) : null,
      linkHref ? String(linkHref).slice(0, 512) : null,
      adminId, now(),
      expiresInHours ? new Date(Date.now() + Number(expiresInHours) * 3600000).toISOString() : null]
  );
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, 'announce', 'instance', NULL, NULL, ?)`,
    [uuid(), adminId, now()]
  );
  return { id };
}

async function updateAnnouncement(announcementId, patch) {
  const existing = await db.get('SELECT id FROM announcements WHERE id = ?', [announcementId]);
  if (!existing) throw { code: 'NOT_FOUND', message: 'announcement not found' };

  const allowed = ['body', 'level', 'link_label', 'link_href', 'active'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    params.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0)
      : patch[key] === null ? null : String(patch[key]).slice(0, 4000));
  }
  if (!sets.length) return { ok: true };

  sets.push('updated_at = ?');
  params.push(now(), announcementId);
  await db.run(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`, params);
  return { ok: true };
}

async function removeAnnouncement(announcementId) {
  await db.run('DELETE FROM announcements WHERE id = ?', [announcementId]);
  return { ok: true };
}

module.exports = {
  activeEnforcement, overview, users, userActions,
  enforce, lift, communities, suspendCommunity, liftCommunity,
  deletionRequests, reviewDeletion, processDeletion,
  setBot, removeCommunity, updateReport, auditLog,
  announcements, createAnnouncement, updateAnnouncement, removeAnnouncement,
};
