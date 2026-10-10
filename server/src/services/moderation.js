// Moderation: timeouts, kicks and bans, and the audit trail.
//
// Every moderation action is a row, because a record that cannot be read cannot be
// appealed against. Bans live in their own table rather than inside moderation_actions,
// so "is this person banned" is a single indexed lookup on the join path.

const db = require('../db');
const { now, uuid } = require('../util');

async function isBanned(serverId, userId) {
  const row = await db.get(
    'SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?',
    [serverId, userId]
  );
  return !!row;
}

// A ban is a refusal to join, not a removal from a channel, so the timeout check is its
// own question answered from the ban's expiry.
async function isTimedOut(serverId, userId) {
  const row = await db.get(
    `SELECT 1 FROM server_bans
      WHERE server_id = ? AND user_id = ?
        AND (expires_at IS NULL OR expires_at > ?)`,
    [serverId, userId, now()]
  );
  return !!row;
}

async function record({ actorId, targetType, targetId, actionType, reason, expiresAt }) {
  const id = uuid();
  await db.run(
    `INSERT INTO moderation_actions (id, actor_id, target_type, target_id, action_type, reason, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, actorId || null, targetType, targetId, actionType, reason || null, expiresAt || null, now()]
  );
  return { id };
}

async function timeout(serverId, actorId, userId, minutes) {
  const n = Math.max(parseInt(minutes, 10) || 60, 1);
  if (n > 60 * 24 * 28) throw { code: 'VALIDATION_ERROR', message: 'a timeout is at most 28 days' };

  const expiresAt = new Date(Date.now() + n * 60000).toISOString();
  await record({
    actorId, targetType: 'user', targetId: userId,
    actionType: 'timeout', expiresAt,
  });
  await db.run(
    'UPDATE server_members SET timeout_expires_at = ? WHERE server_id = ? AND user_id = ?',
    [expiresAt, serverId, userId]
  );
  return { ok: true, until: expiresAt };
}

async function kick(serverId, actorId, userId) {
  await record({ actorId, targetType: 'user', targetId: userId, actionType: 'kick' });
  await db.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  await db.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  return { ok: true };
}

async function ban(serverId, actorId, userId, { reason, minutes }) {
  const n = minutes ? Math.max(parseInt(minutes, 10) || 0, 0) : null;
  const expiresAt = n ? new Date(Date.now() + n * 60000).toISOString() : null;

  await db.run(
    `INSERT INTO server_bans (id, server_id, user_id, actor_id, reason, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), serverId, userId, actorId || null, reason || null, expiresAt, now()]
  );
  await record({ actorId, targetType: 'user', targetId: userId, actionType: 'ban', reason, expiresAt });

  await db.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  await db.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  return { ok: true, expiresAt };
}

async function unban(serverId, userId) {
  await db.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  return { ok: true };
}

async function listBans(serverId) {
  const rows = await db.all(
    `SELECT b.id, b.user_id, b.reason, b.expires_at, b.created_at, u.username, u.display_name
     FROM server_bans b JOIN users u ON u.id = b.user_id
      WHERE b.server_id = ?
      ORDER BY b.created_at DESC`,
    [serverId]
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    reason: r.reason || '',
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

// The audit trail, most recent first. Written by the routes that perform the action
// rather than reconstructed later.
async function audit(serverId, { limit = 50, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT a.*, actor.username AS actor_name, actor.display_name AS actor_display,
       subject.username AS subject_name
     FROM audit_logs a
       LEFT JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users subject ON subject.id = a.target_id
      WHERE a.target_id IN (
              SELECT id FROM servers WHERE id = ?
            ) OR a.report_id IS NOT NULL
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    [serverId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0)]
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.actor_display || r.actor_name || 'system',
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason || '',
    createdAt: r.created_at,
  }));
}

async function log({ serverId, actorId, targetType, targetId, actionType, reason }) {
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), actorId || null, actionType, targetType || 'server', targetId || serverId, reason || null, now()]
  );
}

module.exports = {
  isBanned, isTimedOut, timeout, kick, ban, unban, listBans, audit, log, record,
};
