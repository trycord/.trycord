// Membership lifecycle: the authoritative record of who belongs to a server.
// Join/leave/kick/ban/timeout go through here — never raw INSERTs in routes.
const db = require('../db');
const { now, uuid } = require('../util');
const webhooks = require('./webhooks');
const roles = require('./roles');
const events = require('./events');
const cases = require('./cases');
const auditTrail = require('./audit');
const notifications = require('./notifications');

const DEFAULT_MODERATION_SETTINGS = {
  warningExpiryDays: 14,
  defaultTimeoutMinutes: 60,
  notifyOnReport: true,
};

function moderationSettings(row) {
  if (!row || !row.moderation_settings) return { ...DEFAULT_MODERATION_SETTINGS };
  try {
    const parsed = JSON.parse(row.moderation_settings);
    return {
      warningExpiryDays: Number(parsed.warningExpiryDays) > 0 && Number(parsed.warningExpiryDays) <= 365
        ? Number(parsed.warningExpiryDays) : DEFAULT_MODERATION_SETTINGS.warningExpiryDays,
      defaultTimeoutMinutes: Number(parsed.defaultTimeoutMinutes) > 0 && Number(parsed.defaultTimeoutMinutes) <= 40320
        ? Number(parsed.defaultTimeoutMinutes) : DEFAULT_MODERATION_SETTINGS.defaultTimeoutMinutes,
      notifyOnReport: parsed.notifyOnReport !== false,
    };
  } catch {
    return { ...DEFAULT_MODERATION_SETTINGS };
  }
}

async function getModerationSettings(serverId) {
  const row = await db.get('SELECT moderation_settings FROM servers WHERE id = ?', [serverId]);
  return moderationSettings(row);
}

async function setModerationSettings(serverId, input, actorId) {
  const current = await getModerationSettings(serverId);
  const next = { ...current };
  if (input.warningExpiryDays !== undefined) {
    const days = Number(input.warningExpiryDays);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      throw { code: 'VALIDATION_ERROR', message: 'warningExpiryDays must be between 1 and 365.' };
    }
    next.warningExpiryDays = days;
  }
  if (input.defaultTimeoutMinutes !== undefined) {
    const minutes = Number(input.defaultTimeoutMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 40320) {
      throw { code: 'VALIDATION_ERROR', message: 'defaultTimeoutMinutes must be between 1 and 40320.' };
    }
    next.defaultTimeoutMinutes = minutes;
  }
  if (input.notifyOnReport !== undefined) next.notifyOnReport = !!input.notifyOnReport;
  await db.run('UPDATE servers SET moderation_settings = ? WHERE id = ?', [JSON.stringify(next), serverId]);
  await auditTrail.record(actorId, 'COMMUNITY_MODERATION_SETTINGS_UPDATED', 'server', serverId,
    JSON.stringify(next), { serverId, metadata: { settings: next } });
  return next;
}

function expiresAt(minutes) {
  if (minutes == null) return null;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) throw { code: 'VALIDATION_ERROR', message: 'Minutes must be a non-negative number.' };
  if (m === 0) return null;
  if (m > 40320) throw { code: 'VALIDATION_ERROR', message: 'A timeout or ban cannot exceed 28 days.' };
  return new Date(Date.now() + m * 60000).toISOString();
}

function isActive(row) {
  if (!row) return false;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).getTime() > Date.now();
}

async function get(serverId, userId, conn = db) {
  return conn.get('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
}

// Roster paging. The owner must always be in the first page, so they are
// fetched separately and merged in rather than being subject to the page
// window - otherwise an owner on a large community could scroll off their
// own roster.
async function list(serverId, { limit = null, offset = 0, search = '' } = {}) {
  // Member rows and their roles are independent queries — run together.
  const q = String(search || '').trim();
  const like = '%' + q + '%';
  const cap = limit === null || limit === undefined
    ? null
    : Math.min(Math.max(parseInt(limit, 10) || 0, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  // Without a cap this returned the entire roster for any member, and the
  // role query returned every role assignment in the community regardless of
  // which page was asked for. Both are unbounded on a large community.
  const where = q ? 'AND (u.username LIKE ? OR u.display_name LIKE ? OR m.nickname LIKE ?)' : '';
  const args = q ? [serverId, like, like, like] : [serverId];

  const [members, roleRows] = await Promise.all([
    cap === null
      ? db.all(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status_text,
          u.is_bot, m.nickname, m.joined_at, m.timeout_expires_at,
          CASE WHEN u.id = s.owner_id THEN 1 ELSE 0 END AS is_owner
        FROM server_members m
        JOIN users u ON u.id = m.user_id
        JOIN servers s ON s.id = m.server_id
        WHERE m.server_id = ? ${where}
        ORDER BY is_owner DESC, m.joined_at ASC`,
        args
      )
      : db.all(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status_text,
          u.is_bot, m.nickname, m.joined_at, m.timeout_expires_at,
          CASE WHEN u.id = s.owner_id THEN 1 ELSE 0 END AS is_owner
        FROM server_members m
        JOIN users u ON u.id = m.user_id
        JOIN servers s ON s.id = m.server_id
        WHERE m.server_id = ? ${where}
        ORDER BY (u.id = s.owner_id) DESC, m.joined_at ASC
        LIMIT ${cap} OFFSET ${off}`,
        args
      ),
    // Scope the role lookup to the page actually returned, otherwise this
    // still reads every assignment in the community.
    (cap === null
      ? db.all(
        `SELECT mr.user_id, r.id, r.name, r.color, r.position FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.server_id = ? ORDER BY r.position DESC`,
        [serverId]
      )
      : (async () => {
        const page = await db.all(
          `SELECT u.id FROM server_members m JOIN users u ON u.id = m.user_id
           JOIN servers s ON s.id = m.server_id
           WHERE m.server_id = ? ${where}
           ORDER BY (u.id = s.owner_id) DESC, m.joined_at ASC
           LIMIT ${cap} OFFSET ${off}`,
          args
        );
        if (!page.length) return [];
        const ids = page.map((p) => p.id);
        return db.all(
          `SELECT mr.user_id, r.id, r.name, r.color, r.position FROM member_roles mr
           JOIN roles r ON r.id = mr.role_id
           WHERE mr.server_id = ? AND mr.user_id IN (${ids.map(() => '?').join(',')})
           ORDER BY r.position DESC`,
          [serverId].concat(ids)
        );
      })()),
  ]);

  const byUser = {};
  for (const r of roleRows) {
    (byUser[r.user_id] = byUser[r.user_id] || []).push({ id: r.id, name: r.name, color: r.color || null });
  }

  // The roster is paged, so a bare array cannot answer "how many members are
  // there" or "is there another page" - and a `total` property hung off an
  // array would be dropped by JSON.stringify, which is precisely the bug that
  // made the count unknowable to a client. The response is an envelope:
  //   { items, total, hasMore, limit, offset }
  // `total` counts everything matching the same filter, not just the page, so
  // a filtered roster reports the filtered total.
  const totalRow = await db.get(
    `SELECT COUNT(*) AS n FROM server_members m JOIN users u ON u.id = m.user_id
     WHERE m.server_id = ? ${q ? 'AND (u.username LIKE ? OR u.display_name LIKE ? OR m.nickname LIKE ?)' : ''}`,
    q ? [serverId, like, like, like] : [serverId]
  );
  const total = totalRow ? parseInt(totalRow.n, 10) : members.length;

  return {
    items: members.map((m) => ({
      ...m,
      is_owner: !!m.is_owner,
      is_bot: !!m.is_bot,
      roles: byUser[m.id] || [],
    })),
    total,
    hasMore: cap === null ? false : (off + members.length) < total,
    limit: cap,
    offset: off,
  };
}

async function joinInner(serverId, userId, username, conn, { restore = false } = {}) {
  const srv = await conn.get('SELECT id, enforcement_state FROM servers WHERE id = ?', [serverId]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'Server not found' };
  // Trust & Safety: suspended servers are closed to new members. Existing
  // members are handled by the access chain (resolveServer).
  if (srv.enforcement_state === 'suspended' && !restore) {
    throw { code: 'SERVER_SUSPENDED', message: 'Server is suspended' };
  }
  if (await get(serverId, userId, conn)) throw { code: 'ALREADY_MEMBER', message: 'Already a member' };
  const ban = await conn.get('SELECT * FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  if (isActive(ban)) throw { code: 'BANNED', message: 'You are banned from this community.' };
  if (ban) await conn.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  try {
    await conn.run(
      'INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)',
      [uuid(), userId, serverId, username, now()]
    );
  } catch (error) {
    // Two joins at once - a double tap on the join button - raced the check
    // above, and the second insert was refused by the uniqueness that keeps
    // one membership per person. The membership the first one made is the
    // membership, so the answer is the same refusal a second join gives.
    if (db.isUniqueViolation(error) && (await get(serverId, userId, conn))) {
      throw { code: 'ALREADY_MEMBER', message: 'Already a member' };
    }
    throw error;
  }
  await roles.ensureBaseline(serverId, userId, conn);
  await recordEvent(serverId, userId, 'joined', null, conn);
  // Best-effort: a community's webhook endpoint being down must not stop someone
  // joining.
  if (!conn) {
    webhooks.emit(serverId, 'member.joined', { serverId, userId }).catch(() => {});
  }
  return { serverId };
}

// The gateway memoises a community's member ids for a moment so a burst of
// structural events costs one query instead of one per event. A membership
// change has to clear it, or a removed member keeps receiving events until the
// window expires.
function invalidateMembership(serverId) {
  try { events.invalidateMembership(serverId); } catch { /* gateway not wired */ }
}

async function join(serverId, user) {
  const out = await db.transaction((t) => joinInner(serverId, user.id, user.username, t));
  afterJoin(serverId);
  return out;
}

// Run after a membership transaction commits.
function afterJoin(serverId) {
  invalidateMembership(serverId);
  announceKeyChange(serverId, 'joined');
}

// A membership change means the conversation's key has to move.
//
// The devices sealed at the current epoch no longer match the member devices,
// so the epoch moves and the key is resealed for the new membership. The
// devices that are still members have to be told, or they keep using a key
// the group no longer shares.
function announceKeyChange(serverId, reason) {
  try {
    const e2ee = require('./e2ee');
    if (typeof e2ee.announceKeyChange !== 'function') return;
    e2ee.announceKeyChange(serverId, reason).catch(() => {
      /* the membership change itself has already happened */
    });
  } catch { /* the encryption subsystem is not part of this build */ }
}

async function joinByCode(code, user) {
  const srv = await db.get('SELECT id FROM servers WHERE join_code = ?', [String(code).toLowerCase().trim()]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'Server not found' };
  return join(srv.id, user);
}

// Exposed for invite consumption inside the invite transaction.
async function joinIn(serverId, user, conn) {
  return joinInner(serverId, user.id, user.username, conn);
}

// Restore a membership that belonged to an application already installed
// before bot accounts existed. It is not a route for new community joins.
async function restoreIn(serverId, user, conn) {
  return joinInner(serverId, user.id, user.username, conn, { restore: true });
}

// Set or clear a member's per-community nickname. The route gates who may
// call this (self = anyone; others = staff with KICK_MEMBERS). NULL clears.
async function setNickname(serverId, targetId, nickname, conn = db) {
  const clean = String(nickname == null ? '' : nickname).trim();
  if (clean && (clean.length < 2 || clean.length > 32)) {
    const e = new Error('nickname must be 2-32 characters');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  if (!(await get(serverId, targetId, conn))) {
    const e = new Error('not a member');
    e.code = 'NOT_A_MEMBER'; throw e;
  }
  await conn.run(
    'UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?',
    [clean || null, serverId, targetId]
  );
  return { serverId, userId: targetId, nickname: clean || null };
}

// Shared manageability rule: the owner is untouchable, nobody can act on
// themselves, and everyone else can only act on members ranked strictly
// below their own top role. Used by kick/ban/timeout alike.
async function assertManageable(serverId, actorId, targetId, verb, conn = db) {
  const srv = await conn.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'Server not found' };
  if (String(targetId) === String(srv.owner_id)) {
    throw { code: 'VALIDATION_ERROR', message: 'The owner cannot be ' + verb };
  }
  if (String(targetId) === String(actorId)) {
    throw { code: 'VALIDATION_ERROR', message: 'You cannot ' + verb + ' yourself' };
  }
  if (String(actorId) !== String(srv.owner_id)) {
    const [actorTop, targetTop] = await Promise.all([
      roles.topPosition(serverId, actorId, conn),
      roles.topPosition(serverId, targetId, conn),
    ]);
    if (actorTop <= targetTop) throw { code: 'PERMISSION_DENIED', message: 'Target outranks you' };
  }
  return srv;
}

async function removeMembership(serverId, targetId, conn, reason) {
  await conn.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
  await conn.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
  // Written before the row goes, so churn is still answerable afterwards.
  await recordEvent(serverId, targetId, 'left', reason || null, conn);
  invalidateMembership(serverId);
  if (!conn) {
    webhooks.emit(serverId, 'member.left', { serverId, userId: targetId, reason: reason || null }).catch(() => {});
  }
}

// Churn history. Separate from server_members because a departure deletes that
// row, and "how many people left" has to survive the deletion.
async function recordEvent(serverId, userId, kind, reason, conn) {
  const q = conn || db;
  try {
    await q.run(
      'INSERT INTO server_membership_events (id, server_id, user_id, kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), serverId, userId, kind, reason, now()]
    );
  } catch { /* history is never worth failing a membership change */ }
}

// Moderation trail. server_membership_events answers churn; this answers "who
// did what to whom, and why". It writes through the hash-chained audit service
// so a community action is as verifiable as a platform one.
async function recordModeration(serverId, actorId, action, targetId, reason, options = {}) {
  try {
    await auditTrail.record(actorId, action, 'user', targetId, reason, {
      serverId,
      caseId: options.caseId || null,
      reportId: options.reportId || null,
      metadata: options.metadata || null,
    });
  } catch { /* the action has already happened; the next verification reports the gap */ }
}

// Record a community moderation action and attach it to a case.
//
// The case is what makes the action visible in the community's history, in
// the member's own record, and in the platform's enforcement timeline. A
// report-scoped action reuses the report's case; a standalone warning or
// timeout opens a case of its own.
async function recordCommunityAction(serverId, actorId, targetId, actionType, reason, options = {}) {
  const srv = await db.get('SELECT name, owner_id FROM servers WHERE id = ?', [serverId]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'Server not found' };
  const target = await db.get('SELECT id, username FROM users WHERE id = ?', [targetId]);
  let caseId = options.caseId || null;
  let report = null;
  if (!caseId && options.reportId) {
    report = await db.get('SELECT * FROM reports WHERE id = ? AND server_id = ?',
      [options.reportId, serverId]);
    caseId = report ? report.case_id : null;
  }
  if (!caseId) {
    const created = await cases.create({
      scope: 'community',
      serverId,
      subjectType: 'user',
      subjectId: targetId,
      title: String(actionType).replace(/_/g, ' ').toLowerCase()
        + (target ? ' for @' + target.username : ''),
      category: options.category || 'OTHER',
      severity: options.severity || 'MEDIUM',
      priority: options.priority || 'NORMAL',
      status: 'RESOLVED',
      summary: reason,
      reporterId: options.reporterId || null,
      reportId: options.reportId || null,
      actorId,
    });
    caseId = created.id;
  }
  const ts = now();
  const actionId = uuid();
  await db.run(
    `INSERT INTO moderation_actions
       (id, case_id, server_id, actor_id, target_type, target_id, action_type, reason,
        expires_at, status, report_id, metadata, updated_at, created_at)
     VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
    [actionId, caseId, serverId, actorId, targetId, actionType, reason,
      options.expiresAt || null, options.reportId || null,
      options.metadata == null ? null : JSON.stringify(options.metadata), ts, ts]
  );
  await cases.linkAction(caseId, actionId);
  await cases.addEvent(caseId, actorId, 'COMMUNITY_' + String(actionType).replace('COMMUNITY_', ''),
    reason, { actionId, actionType, expiresAt: options.expiresAt || null, targetId });
  if (options.reportId) {
    await db.run(
      `UPDATE reports SET status = 'RESOLVED', resolution = 'RESOLVED',
         resolution_note = COALESCE(resolution_note, ?), resolved_at = COALESCE(resolved_at, ?),
         updated_at = ?, last_activity_at = ? WHERE id = ? AND server_id = ?`,
      [reason, ts, ts, ts, options.reportId, serverId]
    );
    await cases.update(caseId, actorId, {
      status: 'RESOLVED', resolution: reason, note: 'Resolved by community moderation: ' + reason,
    }, { scope: 'community', serverId });
  }
  await recordModeration(serverId, actorId, actionType, targetId, reason, {
    caseId, reportId: options.reportId || null,
    metadata: { actionId, expiresAt: options.expiresAt || null },
  });
  try {
    await notifications.create(targetId, 'community_moderation', actorId, actionId, {
      detail: options.detail || ('A community moderation action was applied in ' + srv.name + '.'),
      dedupeKey: 'community-action:' + actionId,
    });
  } catch { /* the action is already durable */ }
  return { actionId, caseId, serverId, targetId, actionType, expiresAt: options.expiresAt || null };
}

async function kick(serverId, actorId, targetId, { reason } = {}) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length > 500) {
    throw { code: 'VALIDATION_ERROR', message: 'A reason (<=500 characters) is required to kick a member.' };
  }
  const out = await db.transaction(async (t) => {
    await assertManageable(serverId, actorId, targetId, 'kicked', t);
    if (!(await get(serverId, targetId, t))) throw { code: 'NOT_A_MEMBER', message: 'User is not a member' };
    await removeMembership(serverId, targetId, t, 'kicked');
    return { ok: true };
  });
  events.emit(serverId, 'member_kicked', { userId: String(targetId) });
  events.evict(serverId, targetId, 'kicked from server');
  const record = await recordCommunityAction(serverId, actorId, targetId, 'COMMUNITY_KICK',
    cleanReason, { detail: 'You were removed from a community by its moderators.' });
  return { ...out, ...record };
}

async function leave(serverId, userId) {
  const out = await db.transaction(async (t) => {
    const srv = await t.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
    if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'Server not found' };
    if (!(await get(serverId, userId, t))) throw { code: 'NOT_A_MEMBER', message: 'Not a member' };
    if (srv.owner_id === userId) {
      throw { code: 'OWNER_CANNOT_LEAVE', message: 'The owner cannot leave. Transfer ownership or delete the community.' };
    }
    await removeMembership(serverId, userId, t, 'left');
    return { ok: true };
  });
  events.emit(serverId, 'member_left', { userId: String(userId) });
  events.evict(serverId, userId, 'left server');
  announceKeyChange(serverId, 'left');
  return out;
}

// Ban: persistent per-server ban state. The target is removed immediately
// (like a kick) and cannot rejoin until unbanned or the ban expires.
// minutes null/omitted = permanent.
async function ban(serverId, actorId, targetId, { reason, minutes, reportId } = {}) {
  const target = await db.get('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target) throw { code: 'NOT_FOUND', message: 'User not found' };
  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length > 500) {
    throw { code: 'VALIDATION_ERROR', message: 'A reason (<=500 characters) is required to ban a member.' };
  }
  const out = await db.transaction(async (t) => {
    await assertManageable(serverId, actorId, targetId, 'banned', t);
    await removeMembership(serverId, targetId, t, 'banned');
    await t.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
    const exp = expiresAt(minutes);
    await t.run(
      'INSERT INTO server_bans (id, server_id, user_id, actor_id, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), serverId, targetId, actorId, cleanReason, exp, now()]
    );
    await t.run(
      `UPDATE moderation_actions SET status = 'SUPERSEDED', updated_at = ?
       WHERE server_id = ? AND target_type = 'user' AND target_id = ?
         AND action_type = 'COMMUNITY_BAN' AND status = 'ACTIVE'`,
      [now(), serverId, targetId]
    );
    return { ok: true, expiresAt: exp };
  });
  events.emit(serverId, 'member_banned', { userId: String(targetId) });
  events.evict(serverId, targetId, 'banned from server');
  const record = await recordCommunityAction(serverId, actorId, targetId, 'COMMUNITY_BAN',
    cleanReason, {
      expiresAt: out.expiresAt,
      reportId: reportId || null,
      detail: 'You were banned from a community. You can appeal this decision in Safety.',
    });
  return { ...out, ...record };
}

async function unban(serverId, actorId, targetId, reason = null) {
  const row = await db.get('SELECT id FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'That ban does not exist' };
  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length > 500) {
    throw { code: 'VALIDATION_ERROR', message: 'A reason (<=500 characters) is required to unban a member.' };
  }
  const active = await db.get(
    `SELECT * FROM moderation_actions WHERE server_id = ? AND target_type = 'user'
       AND target_id = ? AND action_type = 'COMMUNITY_BAN' AND status = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1`,
    [serverId, targetId]
  );
  await db.transaction(async (t) => {
    await t.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
    await t.run(
      `UPDATE moderation_actions SET status = 'LIFTED', lifted_at = ?, lifted_by = ?, updated_at = ?
       WHERE server_id = ? AND target_type = 'user' AND target_id = ?
         AND action_type = 'COMMUNITY_BAN' AND status = 'ACTIVE'`,
      [now(), actorId, now(), serverId, targetId]
    );
    // The lift puts the person back where the ban removed them from. The ban
    // took the member's place (and only their place: the roles the ban also
    // took are granted again on purpose, by the operator) when it was
    // applied, so a lift that left the place gone would turn every lifted
    // ban into an invite-only return - and an approved appeal would restore
    // nothing at all. Only a ban's own removal is undone: somebody who
    // already came back by invite is left exactly as they are.
    const userRow = await t.get('SELECT username FROM users WHERE id = ?', [targetId]);
    const present = await get(serverId, targetId, t);
    if (userRow && !present) {
      await t.run(
        'INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)',
        [uuid(), targetId, serverId, userRow.username, now()]
      );
      invalidateMembership(serverId);
    }
  });
  events.emit(serverId, 'member_unbanned', { userId: String(targetId) });
  const record = await recordCommunityAction(serverId, actorId, targetId, 'COMMUNITY_UNBAN',
    cleanReason, {
      caseId: active ? active.case_id : null,
      detail: 'Your ban from a community was lifted.',
    });
  return { ok: true, ...record, liftedActionId: active ? active.id : null };
}

async function listBans(serverId) {
  const rows = await db.all(
    `SELECT b.user_id, b.reason, b.expires_at, b.created_at, u.username, u.display_name,
       a.username AS actor_name
     FROM server_bans b
     JOIN users u ON u.id = b.user_id
     LEFT JOIN users a ON a.id = b.actor_id
     WHERE b.server_id = ? ORDER BY b.created_at DESC`,
    [serverId]
  );
  const nowMs = Date.now();
  return rows
    .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > nowMs)
    .map((r) => ({
      userId: r.user_id, username: r.username, displayName: r.display_name,
      reason: r.reason, expiresAt: r.expires_at, createdAt: r.created_at,
      actorName: r.actor_name || null,
    }));
}

// Timeout: the member stays, but cannot post until it lapses. minutes
// null/0 clears. Enforced server-side on every message send.
async function timeout(serverId, actorId, targetId, minutes, { reason, reportId } = {}) {
  const cleanReason = String(reason || '').trim();
  const isClear = minutes === 0 || minutes === '0';
  if (!isClear && (!cleanReason || cleanReason.length > 500)) {
    throw { code: 'VALIDATION_ERROR', message: 'A reason (<=500 characters) is required to time out a member.' };
  }
  const out = await db.transaction(async (t) => {
    await assertManageable(serverId, actorId, targetId, 'timed out', t);
    if (!(await get(serverId, targetId, t))) throw { code: 'NOT_A_MEMBER', message: 'User is not a member' };
    const exp = expiresAt(minutes);
    await t.run('UPDATE server_members SET timeout_expires_at = ? WHERE server_id = ? AND user_id = ?',
      [exp, serverId, targetId]);
    if (!isClear) {
      await t.run(
        `UPDATE moderation_actions SET status = 'SUPERSEDED', updated_at = ?
         WHERE server_id = ? AND target_type = 'user' AND target_id = ?
           AND action_type = 'COMMUNITY_TIMEOUT' AND status = 'ACTIVE'`,
        [now(), serverId, targetId]
      );
    } else {
      await t.run(
        `UPDATE moderation_actions SET status = 'LIFTED', lifted_at = ?, lifted_by = ?, updated_at = ?
         WHERE server_id = ? AND target_type = 'user' AND target_id = ?
           AND action_type = 'COMMUNITY_TIMEOUT' AND status = 'ACTIVE'`,
        [now(), actorId, now(), serverId, targetId]
      );
    }
    return { ok: true, expiresAt: exp };
  });
  events.emit(serverId, 'member_timeout', { userId: String(targetId), expiresAt: out.expiresAt });
  if (isClear) {
    const active = await db.get(
      `SELECT * FROM moderation_actions WHERE server_id = ? AND target_type = 'user'
         AND target_id = ? AND action_type = 'COMMUNITY_TIMEOUT' ORDER BY created_at DESC LIMIT 1`,
      [serverId, targetId]
    );
    const record = await recordCommunityAction(serverId, actorId, targetId, 'COMMUNITY_TIMEOUT_CLEARED',
      cleanReason || 'Timeout cleared', {
        caseId: active ? active.case_id : null,
        detail: 'A timeout on your account in a community was lifted.',
      });
    return { ...out, ...record };
  }
  const record = await recordCommunityAction(serverId, actorId, targetId, 'COMMUNITY_TIMEOUT',
    cleanReason, {
      expiresAt: out.expiresAt,
      reportId: reportId || null,
      detail: 'You were timed out in a community. You can appeal this decision in Safety.',
    });
  return { ...out, ...record };
}

async function warn(serverId, actorId, targetId, { reason, minutes, expiresInDays, reportId, category, severity } = {}) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length > 500) {
    throw { code: 'VALIDATION_ERROR', message: 'A reason (<=500 characters) is required to warn a member.' };
  }
  const srv = await db.get('SELECT moderation_settings FROM servers WHERE id = ?', [serverId]);
  const settings = moderationSettings(srv);
  let exp = null;
  if (expiresInDays !== undefined || minutes !== undefined) {
    const days = expiresInDays !== undefined ? Number(expiresInDays) : Number(minutes) / 1440;
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      throw { code: 'VALIDATION_ERROR', message: 'A warning lasts between 1 and 365 days.' };
    }
    exp = new Date(Date.now() + days * 86400e3).toISOString();
  } else {
    exp = new Date(Date.now() + settings.warningExpiryDays * 86400e3).toISOString();
  }
  if (!(await get(serverId, targetId))) {
    throw { code: 'NOT_A_MEMBER', message: 'User is not a member' };
  }
  await assertManageable(serverId, actorId, targetId, 'warned');
  const record = await recordCommunityAction(serverId, actorId, targetId, 'COMMUNITY_WARNING',
    cleanReason, {
      expiresAt: exp,
      reportId: reportId || null,
      category: category || 'OTHER',
      severity: severity || 'MEDIUM',
      detail: 'A warning was added to your account in a community. You can appeal this decision in Safety.',
    });
  return { ok: true, expiresAt: exp, ...record };
}

async function liftWarning(serverId, actorId, actionId, reason) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length > 500) {
    throw { code: 'VALIDATION_ERROR', message: 'A reason (<=500 characters) is required to remove a warning.' };
  }
  const action = await db.get(
    `SELECT * FROM moderation_actions WHERE id = ? AND server_id = ?
       AND action_type = 'COMMUNITY_WARNING'`,
    [actionId, serverId]
  );
  if (!action) throw { code: 'NOT_FOUND', message: 'Warning not found' };
  if (action.status !== 'ACTIVE') throw { code: 'CONFLICT', message: 'That warning is no longer active' };
  const ts = now();
  await db.run(
    `UPDATE moderation_actions SET status = 'LIFTED', lifted_at = ?, lifted_by = ?, updated_at = ? WHERE id = ?`,
    [ts, actorId, ts, actionId]
  );
  await cases.addEvent(action.case_id, actorId, 'COMMUNITY_WARNING_LIFTED', cleanReason, {
    actionId, previousStatus: action.status,
  });
  await recordModeration(serverId, actorId, 'COMMUNITY_WARNING_LIFTED', action.target_id, cleanReason,
    { caseId: action.case_id });
  try {
    await notifications.create(action.target_id, 'moderation_lift', actorId, actionId, {
      detail: 'A warning on your account in a community was lifted.',
      dedupeKey: 'community-warning-lift:' + actionId,
    });
  } catch { /* the lift is already durable */ }
  return { ok: true, actionId, caseId: action.case_id, targetId: action.target_id };
}

async function isTimedOut(serverId, userId, conn = db) {
  const row = await conn.get('SELECT timeout_expires_at FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  return !!(row && row.timeout_expires_at && new Date(row.timeout_expires_at).getTime() > Date.now());
}

module.exports = {
  get, list, join, joinByCode, joinIn, restoreIn, afterJoin, leave, kick, setNickname,
  ban, unban, listBans, timeout, isTimedOut, warn, liftWarning,
  recordCommunityAction, recordModeration,
  moderationSettings, getModerationSettings, setModerationSettings,
  DEFAULT_MODERATION_SETTINGS,
};
