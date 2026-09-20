// Notifications: persisted per user, newest first. Created for events the
// user didn't see live (offline DM, incoming friend request, accepted
// request). The realtime gateway pushes them to connected sockets; the
// database is the durable source when offline.
const db = require('../db');
const { now, uuid } = require('../util');

const TYPES = ['dm', 'friend_request', 'friend_accepted', 'mention'];

async function create(userId, type, actorId, referenceId) {
  if (TYPES.indexOf(type) === -1) throw { code: 'VALIDATION_ERROR', message: 'unknown notification type' };
  const row = {
    id: uuid(), user_id: userId, type,
    actor_id: actorId || null, reference_id: referenceId || null,
    created_at: now(), read_at: null,
  };
  await db.run(
    'INSERT INTO notifications (id, user_id, type, actor_id, reference_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.user_id, row.type, row.actor_id, row.reference_id, row.created_at, row.read_at]
  );
  return shape(row, null);
}

function shape(n, actor) {
  return {
    id: n.id, type: n.type, createdAt: n.created_at, readAt: n.read_at,
    referenceId: n.reference_id,
    actor: actor ? { id: actor.id, username: actor.username, displayName: actor.display_name } : null,
  };
}

async function list(userId, limit) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const rows = await db.all(
    `SELECT n.*, u.username AS actor_name, u.display_name AS actor_display
     FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ${lim}`,
    [userId]
  );
  const unread = await db.get(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId]
  );
  return {
    unreadCount: unread ? unread.n : 0,
    items: rows.map((r) => shape(r, r.actor_name ? { id: r.actor_id, username: r.actor_name, display_name: r.actor_display } : null)),
  };
}

async function markRead(userId, id) {
  const n = await db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  if (!n) throw { code: 'NOT_FOUND', message: 'notification not found' };
  await db.run('UPDATE notifications SET read_at = ? WHERE id = ?', [now(), id]);
  return { id, read: true };
}

async function markAllRead(userId) {
  await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), userId]);
  return { ok: true };
}

module.exports = { TYPES, create, list, markRead, markAllRead };
