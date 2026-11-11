// Trust & Safety: platform enforcement is applied here and only here.
//
// The persistent moderation_actions row is the record of what happened; the
// live users/servers columns are the fast path used by authentication and
// community access. Every action is attached to a moderation case and to the
// hash-chained audit trail. Notifications carry the decision, never the
// investigation.
const db = require('../db');
const { now, uuid } = require('../util');
const cases = require('./cases');
const auditTrail = require('./audit');
const notifications = require('./notifications');
const platformRoles = require('./platformRoles');

const USER_ACTIONS = new Set(['WARNING', 'SUSPENSION', 'ACCOUNT_BAN', 'RESTRICTION']);
const SERVER_ACTIONS = new Set(['SERVER_SUSPENSION', 'SERVER_REMOVAL']);
const LIFT_ACTION = 'ENFORCEMENT_LIFTED';

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function describeEffective(row) {
  if (!row) return null;
  const state = row.enforcement_state;
  if (!state) return null;
  if (state === 'banned') return { type: 'ACCOUNT_BAN' };
  if (state === 'suspended') {
    const exp = row.enforcement_expires_at;
    if (exp && new Date(exp).getTime() < Date.now()) return null;
    return { type: 'SUSPENSION', until: exp };
  }
  return null;
}

function describeServer(row) {
  if (!row || !row.enforcement_state) return null;
  if (row.enforcement_state === 'removed') return { type: 'SERVER_REMOVAL' };
  if (row.enforcement_state === 'suspended') {
    if (row.enforcement_expires_at && new Date(row.enforcement_expires_at).getTime() < Date.now()) return null;
    return { type: 'SERVER_SUSPENSION', until: row.enforcement_expires_at || null };
  }
  return null;
}

async function activeAccountAction(userId) {
  const row = await db.get(
    `SELECT * FROM moderation_actions
     WHERE target_type = 'user' AND target_id = ?
       AND action_type IN ('SUSPENSION', 'ACCOUNT_BAN')
       AND status = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!row) return null;
  const u = await db.get('SELECT enforcement_state, enforcement_expires_at FROM users WHERE id = ?', [userId]);
  return describeEffective(u) ? row : null;
}

function validateActionType(type, bucket) {
  return typeof type === 'string' && bucket.has(type.toUpperCase());
}

function cleanReason(input) {
  const reason = String((input && input.reason) || '').trim();
  if (!reason || reason.length > 2000) bad('a reason (<=2000 chars) is required');
  return reason;
}

function expiryFromHours(value, label, { required = false, max = 8760 } = {}) {
  if (value == null || value === '') {
    if (required) bad(label + ' requires a duration in hours');
    return null;
  }
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > max) {
    bad(label + ' must be between 1 and ' + max + ' hours');
  }
  return new Date(Date.now() + hours * 3600e3).toISOString();
}

// --- notifications ---------------------------------------------------------

async function notifyTarget(userId, type, actorId, referenceId, detail, dedupeKey) {
  if (!userId || String(userId) === String(actorId)) return null;
  try {
    return await notifications.create(userId, type, actorId || null, referenceId, {
      detail,
      dedupeKey: dedupeKey || null,
    });
  } catch {
    // The enforcement has happened. A notification failure must not turn a
    // successful ban into a 500 the caller might retry, duplicating the ban.
    return null;
  }
}

// --- account enforcement ---------------------------------------------------

async function applyUserAction(actorId, targetUserId, input) {
  const type = String((input && input.actionType) || '').toUpperCase();
  if (!validateActionType(type, USER_ACTIONS)) bad('invalid action type for user target');
  const reason = cleanReason(input);
  if (String(actorId) === String(targetUserId)) bad('you cannot moderate your own account');
  if (type === 'ACCOUNT_BAN' && !input.confirm) bad('account bans require explicit confirmation');

  const target = await db.get('SELECT id, username, enforcement_state FROM users WHERE id = ?', [targetUserId]);
  if (!target) { const e = new Error('user not found'); e.code = 'NOT_FOUND'; throw e; }

  const ts = now();
  const actionId = uuid();
  let expiresAt = null;
  let restrictionKind = null;
  let detail = '';
  let actionType = type;

  if (type === 'SUSPENSION') {
    expiresAt = expiryFromHours(input.expiresInHours, 'a suspension', { required: true });
    detail = 'A temporary suspension was applied to your account. You can appeal this decision.';
  } else if (type === 'ACCOUNT_BAN') {
    detail = 'Your account was permanently banned. You can appeal this decision.';
  } else if (type === 'WARNING') {
    if (input.expiresInDays != null) {
      const days = Number(input.expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 365) bad('a warning lasts between 1 and 365 days');
      expiresAt = new Date(Date.now() + days * 86400e3).toISOString();
    }
    detail = 'A warning was added to your account.';
  } else if (type === 'RESTRICTION') {
    restrictionKind = String(input.restrictionType || '').toUpperCase();
    if (!cases.RESTRICTION_KINDS.includes(restrictionKind)) bad('unknown restriction type');
    expiresAt = expiryFromHours(input.expiresInHours, 'a restriction', { required: false });
    detail = 'A restriction was applied to part of your account. You can see and appeal it in Safety.';
  }

  let createdCase = null;
  if (input.reportId) {
    const report = await db.get('SELECT case_id FROM reports WHERE id = ?', [input.reportId]);
    if (report && report.case_id) createdCase = await cases.get(report.case_id);
  }
  if (!createdCase) {
    createdCase = await cases.create({
      scope: 'platform',
      subjectType: 'user',
      subjectId: targetUserId,
      title: (type === 'RESTRICTION' ? restrictionKind.replace(/_/g, ' ').toLowerCase() : type.replace(/_/g, ' ').toLowerCase())
        + ' for @' + target.username,
      category: 'OTHER',
      severity: type === 'ACCOUNT_BAN' ? 'HIGH' : 'MEDIUM',
      priority: type === 'ACCOUNT_BAN' ? 'HIGH' : 'NORMAL',
      status: 'RESOLVED',
      summary: reason,
      actorId,
    });
  }
  if (input.reportId) await cases.linkReport(createdCase.id, input.reportId);

  await db.run(
    `INSERT INTO moderation_actions
       (id, case_id, server_id, actor_id, target_type, target_id, action_type, reason,
        expires_at, status, report_id, metadata, updated_at, created_at)
     VALUES (?, ?, NULL, ?, 'user', ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
    [actionId, createdCase.id, actorId, targetUserId, actionType, reason, expiresAt,
      input.reportId || null,
      restrictionKind ? JSON.stringify({ restrictionType: restrictionKind }) : null,
      ts, ts]
  );
  await cases.linkAction(createdCase.id, actionId);

  if (type === 'SUSPENSION' || type === 'ACCOUNT_BAN') {
    const state = type === 'ACCOUNT_BAN' ? 'banned' : 'suspended';
    await db.run(
      `UPDATE users SET
         enforcement_state = ?, enforcement_expires_at = ?, enforcement_reason = ?, enforcement_updated_at = ?,
         sessions_invalidated_at = ?
       WHERE id = ?`,
      [state, expiresAt, reason, ts, ts, targetUserId]
    );
    // A ban supersedes a suspension, and a new suspension supersedes an
    // older one. Marking the prior action is what keeps appeal approval from
    // lifting enforcement that is no longer the action under appeal.
    await db.run(
      `UPDATE moderation_actions SET status = 'SUPERSEDED', updated_at = ?
       WHERE id <> ? AND target_type = 'user' AND target_id = ?
         AND action_type IN ('SUSPENSION', 'ACCOUNT_BAN') AND status = 'ACTIVE'`,
      [ts, actionId, targetUserId]
    );
  } else if (type === 'RESTRICTION') {
    const restrictionId = uuid();
    await db.run(
      `INSERT INTO user_restrictions
         (id, user_id, kind, reason, actor_id, case_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [restrictionId, targetUserId, restrictionKind, reason, actorId, createdCase.id, expiresAt, ts]
    );
    await cases.addEvent(createdCase.id, actorId, 'RESTRICTION_APPLIED',
      restrictionKind, { restrictionId, expiresAt });
  }

  await cases.addEvent(createdCase.id, actorId, 'ENFORCEMENT_APPLIED', reason, {
    actionId, actionType, expiresAt, restrictionType: restrictionKind,
  });
  await audit(actorId, 'MODERATION_' + type, 'user', targetUserId, reason, {
    reportId: input.reportId || null,
    caseId: createdCase.id,
    metadata: { actionId, expiresAt, restrictionType: restrictionKind },
  });
  await notifyTarget(targetUserId,
    type === 'WARNING' ? 'moderation_warning' : 'moderation_action',
    actorId, actionId, detail, 'moderation:' + actionId);

  return {
    id: actionId,
    caseId: createdCase.id,
    type,
    actionType,
    reason,
    expiresAt,
    restrictionType: restrictionKind,
    targetUserId,
  };
}

async function liftUserEnforcement(actorId, targetUserId, reason, options = {}) {
  const msg = String((reason || '').trim());
  if (!msg || msg.length > 2000) bad('a reason (<=2000 chars) is required');
  const user = await db.get('SELECT id, enforcement_state, enforcement_expires_at FROM users WHERE id = ?', [targetUserId]);
  if (!user) { const e = new Error('user not found'); e.code = 'NOT_FOUND'; throw e; }
  if (!describeEffective(user)) bad('that account has no active enforcement to lift');

  const ts = now();
  const active = await db.get(
    `SELECT * FROM moderation_actions
     WHERE target_id = ? AND target_type = 'user'
       AND action_type IN ('SUSPENSION', 'ACCOUNT_BAN') AND status = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1`,
    [targetUserId]
  );
  const caseId = options.caseId || (active ? active.case_id : null);
  const actionId = uuid();
  await db.transaction(async (t) => {
    await t.run(
      `UPDATE users SET enforcement_state = NULL, enforcement_expires_at = NULL,
         enforcement_reason = NULL, enforcement_updated_at = ? WHERE id = ?`,
      [ts, targetUserId]
    );
    await t.run(
      `UPDATE moderation_actions SET status = 'LIFTED', lifted_at = ?, lifted_by = ?, updated_at = ?
       WHERE target_id = ? AND target_type = 'user'
         AND action_type IN ('SUSPENSION', 'ACCOUNT_BAN') AND status = 'ACTIVE'`,
      [ts, actorId, ts, targetUserId]
    );
    await t.run(
      `INSERT INTO moderation_actions
         (id, case_id, actor_id, target_type, target_id, action_type, reason, status,
          lifted_at, lifted_by, updated_at, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, 'ACTIVE', NULL, NULL, ?, ?)`,
      [actionId, caseId, actorId, targetUserId, LIFT_ACTION, msg, ts, ts]
    );
  });
  if (caseId) {
    await cases.addEvent(caseId, actorId, 'ENFORCEMENT_LIFTED', msg, { actionId });
  }
  await audit(actorId, 'ENFORCEMENT_LIFTED', 'user', targetUserId, msg, {
    caseId, metadata: { actionId, liftedActionId: active ? active.id : null },
  });
  await notifyTarget(targetUserId, 'moderation_lift', actorId, actionId,
    'A moderation action on your account was lifted.', 'moderation:lift:' + actionId);
  return { id: actionId, caseId, type: LIFT_ACTION, targetUserId };
}

// --- feature restrictions --------------------------------------------------

async function activeRestrictions(userId, conn = db) {
  const rows = await conn.all(
    `SELECT * FROM user_restrictions
     WHERE user_id = ? AND lifted_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC`,
    [userId, new Date().toISOString()]
  );
  return rows;
}

async function isRestricted(userId, kind, conn = db) {
  const row = await conn.get(
    `SELECT 1 AS yes FROM user_restrictions
     WHERE user_id = ? AND kind = ? AND lifted_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    [userId, String(kind).toUpperCase(), new Date().toISOString()]
  );
  return !!row;
}

async function liftRestriction(actorId, restrictionId, reason) {
  const msg = String((reason || '').trim());
  if (!msg || msg.length > 2000) bad('a reason (<=2000 chars) is required');
  const row = await db.get('SELECT * FROM user_restrictions WHERE id = ?', [restrictionId]);
  if (!row) { const e = new Error('restriction not found'); e.code = 'NOT_FOUND'; throw e; }
  if (row.lifted_at) bad('that restriction is already lifted');
  const ts = now();
  await db.run(
    `UPDATE user_restrictions SET lifted_at = ?, lifted_by = ?, lift_reason = ? WHERE id = ?`,
    [ts, actorId, msg, restrictionId]
  );
  const actionId = uuid();
  await db.run(
    `INSERT INTO moderation_actions
       (id, case_id, actor_id, target_type, target_id, action_type, reason, status, updated_at, created_at)
     VALUES (?, ?, ?, 'user', ?, 'RESTRICTION_LIFTED', ?, 'ACTIVE', ?, ?)`,
    [actionId, row.case_id || null, actorId, row.user_id, msg, ts, ts]
  );
  if (row.case_id) {
    await cases.addEvent(row.case_id, actorId, 'RESTRICTION_LIFTED', msg,
      { restrictionId, kind: row.kind });
  }
  await audit(actorId, 'RESTRICTION_LIFTED', 'user', row.user_id, msg, {
    caseId: row.case_id, metadata: { restrictionId, kind: row.kind },
  });
  await notifyTarget(row.user_id, 'moderation_lift', actorId, actionId,
    'A restriction on your account was lifted.', 'moderation:restriction-lift:' + restrictionId);
  return { id: actionId, restrictionId, userId: row.user_id, kind: row.kind };
}

// --- server enforcement ----------------------------------------------------

async function applyServerAction(actorId, serverId, input) {
  const type = String((input && input.actionType) || '').toUpperCase();
  if (!validateActionType(type, SERVER_ACTIONS)) bad('invalid action type for server target');
  const reason = cleanReason(input);
  if (type === 'SERVER_REMOVAL' && !input.confirm) bad('server removal requires explicit confirmation');
  const server = await db.get('SELECT id, name, owner_id, enforcement_state FROM servers WHERE id = ?', [serverId]);
  if (!server) { const e = new Error('server not found'); e.code = 'NOT_FOUND'; throw e; }
  const expiresAt = type === 'SERVER_SUSPENSION'
    ? expiryFromHours(input.expiresInHours, 'a community suspension', { required: false })
    : null;
  const actionId = uuid();
  const ts = now();
  let createdCase = null;
  if (input.reportId) {
    const report = await db.get('SELECT case_id FROM reports WHERE id = ?', [input.reportId]);
    if (report && report.case_id) createdCase = await cases.get(report.case_id);
  }
  if (!createdCase) {
    createdCase = await cases.create({
      scope: 'platform',
      subjectType: 'server',
      subjectId: serverId,
      title: type === 'SERVER_REMOVAL' ? 'Community removed: ' + server.name : 'Community suspended: ' + server.name,
      category: 'OTHER',
      severity: type === 'SERVER_REMOVAL' ? 'CRITICAL' : 'HIGH',
      priority: 'HIGH',
      status: 'RESOLVED',
      summary: reason,
      actorId,
    });
  }
  if (input.reportId) await cases.linkReport(createdCase.id, input.reportId);

  if (type === 'SERVER_SUSPENSION') {
    await db.run(
      `UPDATE servers SET enforcement_state = 'suspended', enforcement_reason = ?,
         enforcement_updated_at = ?, enforcement_expires_at = ? WHERE id = ?`,
      [reason, ts, expiresAt, serverId]
    );
  } else {
    await db.run(
      `UPDATE servers SET enforcement_state = 'removed', enforcement_reason = ?,
         enforcement_updated_at = ?, deleted_at = ?, deletion_reason = ? WHERE id = ?`,
      [reason, ts, ts, reason, serverId]
    );
  }
  await db.run(
    `INSERT INTO moderation_actions
       (id, case_id, actor_id, target_type, target_id, action_type, reason, expires_at,
        status, report_id, updated_at, created_at)
     VALUES (?, ?, ?, 'server', ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [actionId, createdCase.id, actorId, serverId, type, reason, expiresAt,
      input.reportId || null, ts, ts]
  );
  await cases.linkAction(createdCase.id, actionId);
  await cases.addEvent(createdCase.id, actorId, 'ENFORCEMENT_APPLIED', reason,
    { actionId, actionType: type, expiresAt });
  await audit(actorId, 'MODERATION_' + type, 'server', serverId, reason, {
    reportId: input.reportId || null, caseId: createdCase.id, metadata: { actionId, expiresAt },
  });
  await notifyTarget(server.owner_id, 'moderation_action', actorId, actionId,
    (type === 'SERVER_REMOVAL'
      ? 'Your community ' + server.name + ' was removed. You can appeal this decision.'
      : 'Your community ' + server.name + ' was suspended. You can appeal this decision.'),
    'moderation:server:' + actionId);
  return { id: actionId, caseId: createdCase.id, type, actionType: type, serverId, expiresAt };
}

async function liftServerEnforcement(actorId, serverId, reason, options = {}) {
  const msg = String((reason || '').trim());
  if (!msg || msg.length > 2000) bad('a reason (<=2000 chars) is required');
  const server = await db.get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!server) { const e = new Error('server not found'); e.code = 'NOT_FOUND'; throw e; }
  if (!server.enforcement_state) bad('that community is not under enforcement');
  if (server.enforcement_state === 'removed' && !options.allowRemovedRestore) {
    bad('restore a removed community from the restoration action, with confirmation');
  }
  const ts = now();
  const active = await db.get(
    `SELECT * FROM moderation_actions
     WHERE target_type = 'server' AND target_id = ?
       AND action_type IN ('SERVER_SUSPENSION', 'SERVER_REMOVAL') AND status = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1`,
    [serverId]
  );
  const caseId = options.caseId || (active ? active.case_id : null);
  const actionId = uuid();
  await db.transaction(async (t) => {
    await t.run(
      `UPDATE servers SET enforcement_state = NULL, enforcement_reason = NULL,
         enforcement_expires_at = NULL, enforcement_updated_at = ?,
         deleted_at = NULL, deletion_reason = NULL WHERE id = ?`,
      [ts, serverId]
    );
    await t.run(
      `UPDATE moderation_actions SET status = 'LIFTED', lifted_at = ?, lifted_by = ?, updated_at = ?
       WHERE target_type = 'server' AND target_id = ?
         AND action_type IN ('SERVER_SUSPENSION', 'SERVER_REMOVAL') AND status = 'ACTIVE'`,
      [ts, actorId, ts, serverId]
    );
    await t.run(
      `INSERT INTO moderation_actions
         (id, case_id, actor_id, target_type, target_id, action_type, reason, status, updated_at, created_at)
       VALUES (?, ?, ?, 'server', ?, ?, ?, 'ACTIVE', ?, ?)`,
      [actionId, caseId, actorId, serverId, LIFT_ACTION, msg, ts, ts]
    );
  });
  if (caseId) await cases.addEvent(caseId, actorId, 'ENFORCEMENT_LIFTED', msg, { actionId });
  await audit(actorId, server.enforcement_state === 'removed' ? 'SERVER_RESTORED' : 'ENFORCEMENT_LIFTED',
    'server', serverId, msg, { caseId, metadata: { actionId } });
  await notifyTarget(server.owner_id, 'moderation_lift', actorId, actionId,
    server.enforcement_state === 'removed'
      ? 'Your community was restored.'
      : 'The suspension on your community was lifted.',
    'moderation:server-lift:' + actionId);
  return { id: actionId, caseId, type: LIFT_ACTION, serverId };
}

async function restoreServer(actorId, serverId, reason) {
  const server = await db.get('SELECT enforcement_state FROM servers WHERE id = ?', [serverId]);
  if (!server) { const e = new Error('server not found'); e.code = 'NOT_FOUND'; throw e; }
  if (server.enforcement_state !== 'removed') bad('that community is not removed');
  return liftServerEnforcement(actorId, serverId, reason, { allowRemovedRestore: true });
}

async function removeServer(actorId, serverId, input) {
  return applyServerAction(actorId, serverId, Object.assign({}, input, { actionType: 'SERVER_REMOVAL' }));
}

// --- audit trail -----------------------------------------------------------

async function audit(actorId, action, targetType, targetId, reason, options) {
  return auditTrail.record(actorId, action, targetType, targetId, reason, options);
}

// --- platform role helpers -------------------------------------------------

async function isPlatformAdmin(userId) {
  return !!(await db.get('SELECT 1 FROM admins WHERE user_id = ?', [userId]));
}

async function ensureAdminUser(userId) {
  await db.run(
    `INSERT ${db.ignoreKeyword} INTO admins (user_id, role, created_at) VALUES (?, 'PLATFORM_ADMIN', ?)`,
    [userId, now()]
  );
}

function listedAdminNames() {
  return String(process.env.ADMIN_USERNAMES || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isListedAdminName(username) {
  const name = String(username || '').trim().toLowerCase();
  return !!name && listedAdminNames().includes(name);
}

async function ensureListedAdmin(userId, username) {
  try {
    if (!userId || !isListedAdminName(username)) return false;
    await ensureAdminUser(userId);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  USER_ACTIONS,
  SERVER_ACTIONS,
  LIFT_ACTION,
  describeEffective,
  describeServer,
  activeAccountAction,
  applyUserAction,
  liftUserEnforcement,
  activeRestrictions,
  isRestricted,
  liftRestriction,
  applyServerAction,
  liftServerEnforcement,
  restoreServer,
  removeServer,
  audit,
  isPlatformAdmin,
  ensureAdminUser,
  listedAdminNames,
  isListedAdminName,
  ensureListedAdmin,
  notifyTarget,
  platformRoles,
};
