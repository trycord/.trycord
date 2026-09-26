// Trust & Safety: enforcement is applied here and only here. The persistent
// moderation_actions table records what happened (actor, type, reason,
// expiry), and the *effective* live state is mirrored on the users/servers
// rows so the hot authentication path stays a single read with no joins.
//
// Session lifecycle rules come from the spec:
//   ban/suspend -> invalidate sessions + disconnect live sockets + refuse
//   new auth; appeals are reviewed by platform admins server-side.
const db = require('../db');
const { now, uuid } = require('../util');

const USER_ACTIONS = new Set(['WARNING', 'SUSPENSION', 'ACCOUNT_BAN']);
const SERVER_ACTIONS = new Set(['SERVER_SUSPENSION', 'SERVER_REMOVAL']);
const LIFT_ACTION = 'ENFORCEMENT_LIFTED';
const ACTION_TYPES = new Set([...USER_ACTIONS, ...SERVER_ACTIONS, LIFT_ACTION]);

function describeEffective(row) {
  if (!row) return null;
  const state = row.enforcement_state;
  if (!state) return null;
  if (state === 'banned') return { type: 'ACCOUNT_BAN' };
  if (state === 'suspended') {
    const exp = row.enforcement_expires_at;
    if (exp && new Date(exp).getTime() < Date.now()) return null; // expired
    return { type: 'SUSPENSION', until: exp };
  }
  return null;
}

// Moderation action record available to a user who just failed login:
// the *current* account-level enforcement, if any. Feed into the appeal flow.
async function activeAccountAction(userId) {
  const row = await db.get(
    `SELECT * FROM moderation_actions
     WHERE target_type = 'user' AND target_id = ?
       AND action_type IN ('SUSPENSION', 'ACCOUNT_BAN')
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!row) return null;
  const u = await db.get('SELECT enforcement_state, enforcement_expires_at FROM users WHERE id = ?', [userId]);
  // Only surface an action that is still governing the account.
  return describeEffective(u) ? row : null;
}

function validateActionType(type, bucket) {
  return typeof type === 'string' && bucket.has(type.toUpperCase());
}

// --- account enforcement ---

async function applyUserAction(actorId, targetUserId, input) {
  const type = String((input && input.actionType) || '').toUpperCase();
  if (!validateActionType(type, USER_ACTIONS)) {
    const e = new Error('invalid action type for user target');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  const reason = String((input && input.reason) || '').trim();
  if (!reason || reason.length > 2000) {
    const e = new Error('a reason (<=2000 chars) is required');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  if (type === 'ACCOUNT_BAN' && !input.confirm) {
    const e = new Error('account bans require explicit confirmation');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  const expiresHrs = Number(input.expiresInHours);
  const expiresAt = type === 'SUSPENSION' && Number.isFinite(expiresHrs) && expiresHrs > 0
    ? new Date(Date.now() + expiresHrs * 3600e3).toISOString()
    : null;

  const actionId = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO moderation_actions (id, actor_id, target_type, target_id, action_type, reason, expires_at, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [actionId, actorId, 'user', targetUserId, type, reason, expiresAt, input.reportId || null, ts]
  );

  if (type === 'SUSPENSION' || type === 'ACCOUNT_BAN') {
    const state = type === 'ACCOUNT_BAN' ? 'banned' : 'suspended';
    await db.run(
      `UPDATE users SET
         enforcement_state = ?, enforcement_expires_at = ?, enforcement_reason = ?, enforcement_updated_at = ?,
         sessions_invalidated_at = ?
       WHERE id = ?`,
      [state, expiresAt, reason, ts, ts, targetUserId]
    );
  }
  await audit(actorId, 'MODERATION_' + type, 'user', targetUserId, reason, input.reportId || null);
  return { id: actionId, type, reason, expiresAt, targetUserId };
}

async function liftUserEnforcement(actorId, targetUserId, reason) {
  const msg = String((reason || '').trim());
  if (!msg || msg.length > 2000) {
    const e = new Error('a reason (<=2000 chars) is required');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  const ts = now();
  await db.run(
    `UPDATE users SET enforcement_state = NULL, enforcement_expires_at = NULL,
       enforcement_reason = NULL, enforcement_updated_at = ? WHERE id = ?`,
    [ts, targetUserId]
  );
  const actionId = uuid();
  await db.run(
    'INSERT INTO moderation_actions (id, actor_id, target_type, target_id, action_type, reason, expires_at, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
    [actionId, actorId, 'user', targetUserId, LIFT_ACTION, msg, ts]
  );
  await audit(actorId, 'ENFORCEMENT_LIFTED', 'user', targetUserId, msg, null);
  return { id: actionId, type: LIFT_ACTION, targetUserId };
}

// --- server enforcement ---

async function applyServerAction(actorId, serverId, input) {
  const type = String((input && input.actionType) || '').toUpperCase();
  if (!validateActionType(type, SERVER_ACTIONS)) {
    const e = new Error('invalid action type for server target');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  const reason = String((input && input.reason) || '').trim();
  if (!reason || reason.length > 2000) {
    const e = new Error('a reason (<=2000 chars) is required');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  if (type === 'SERVER_REMOVAL' && !input.confirm) {
    const e = new Error('server removal requires explicit confirmation');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  const actionId = uuid();
  const ts = now();

  if (type === 'SERVER_SUSPENSION') {
    await db.run(
      `UPDATE servers SET enforcement_state = 'suspended', enforcement_reason = ?, enforcement_updated_at = ? WHERE id = ?`,
      [reason, ts, serverId]
    );
  }
  await db.run(
    'INSERT INTO moderation_actions (id, actor_id, target_type, target_id, action_type, reason, expires_at, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    [actionId, actorId, 'server', serverId, type, reason, input.reportId || null, ts]
  );
  await audit(actorId, 'MODERATION_' + type, 'server', serverId, reason, input.reportId || null);
  return { id: actionId, type, serverId };
}

async function liftServerEnforcement(actorId, serverId, reason) {
  const msg = String((reason || '').trim());
  if (!msg || msg.length > 2000) {
    const e = new Error('a reason (<=2000 chars) is required');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  const ts = now();
  await db.run(
    `UPDATE servers SET enforcement_state = NULL, enforcement_reason = NULL, enforcement_updated_at = ? WHERE id = ?`,
    [ts, serverId]
  );
  const actionId = uuid();
  await db.run(
    'INSERT INTO moderation_actions (id, actor_id, target_type, target_id, action_type, reason, expires_at, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
    [actionId, actorId, 'server', serverId, LIFT_ACTION, msg, ts]
  );
  await audit(actorId, 'ENFORCEMENT_LIFTED', 'server', serverId, msg, null);
  return { id: actionId, type: LIFT_ACTION, serverId };
}

async function removeServer(actorId, serverId, input) {
  const applied = await applyServerAction(actorId, serverId, Object.assign({}, input, { actionType: 'SERVER_REMOVAL' }));
  // Destructive but deliberate: all children cascade (schema FKs).
  await db.run('DELETE FROM servers WHERE id = ?', [serverId]);
  return applied;
}

// --- audit trail (append-only, no edit path) ---

async function audit(actorId, action, targetType, targetId, reason, reportId) {
  await db.run(
    'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [uuid(), actorId, action, targetType || null, targetId || null, reason || null, reportId || null, now()]
  );
}

async function isPlatformAdmin(userId) {
  return !!(await db.get('SELECT 1 FROM admins WHERE user_id = ?', [userId]));
}

async function ensureAdminUser(userId) {
  await db.run(
    `INSERT ${db.ignoreKeyword} INTO admins (user_id, created_at) VALUES (?, ?)`,
    [userId, now()]
  );
}

// ADMIN_USERNAMES handling. The boot bootstrap alone was a footgun:
// accounts created AFTER boot (or with different case) never became
// admins, and nothing told the operator why. These helpers run the same
// idempotent promotion at registration and login, with case-insensitive
// matching because usernames preserve case but operators type env vars
// by hand. Never throws — admin promotion must not fail authentication.
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
  ACTION_TYPES,
  USER_ACTIONS,
  SERVER_ACTIONS,
  describeEffective,
  activeAccountAction,
  applyUserAction,
  liftUserEnforcement,
  applyServerAction,
  liftServerEnforcement,
  removeServer,
  audit,
  isPlatformAdmin,
  ensureAdminUser,
  listedAdminNames,
  isListedAdminName,
  ensureListedAdmin,
};