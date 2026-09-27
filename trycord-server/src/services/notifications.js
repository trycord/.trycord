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

// Keyset cursor for the notification list.
//
// Encoded as "<created_at>|<id>". created_at alone is not a usable anchor: it
// is a timestamp with a resolution finer than a busy minute, so several
// notifications can share it and an anchor on that value alone would either
// skip the rest of the tie or loop forever. Pairing it with the primary key
// makes the order total and the boundary exact, which is the same reason the
// message tables moved to seq - the difference here is that notifications have
// no existing counter, and adding one would mean a migration for a list that
// is already ordered by an indexed column.
function encodeCursor(row) {
  return row ? row.created_at + '|' + row.id : null;
}

function decodeCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw);
  const at = s.lastIndexOf('|');
  if (at <= 0) return null;
  const createdAt = s.slice(0, at);
  const id = s.slice(at + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

async function list(userId, limit, cursor) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const anchor = decodeCursor(cursor);

  // One extra row tells us whether another page exists without a second count
  // query.
  let rows;
  if (anchor) {
    rows = await db.all(
      `SELECT n.*, u.username AS actor_name, u.display_name AS actor_display
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ?
         AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))
       ORDER BY n.created_at DESC, n.id DESC LIMIT ${lim + 1}`,
      [userId, anchor.createdAt, anchor.createdAt, anchor.id]
    );
  } else {
    rows = await db.all(
      `SELECT n.*, u.username AS actor_name, u.display_name AS actor_display
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT ${lim + 1}`,
      [userId]
    );
  }

  const hasMore = rows.length > lim;
  if (hasMore) rows = rows.slice(0, lim);

  const unread = await db.get(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId]
  );
  // Mention deep links: batch-resolve the referenced message to its
  // channel/server so the client can jump straight to it. Missing rows
  // (deleted messages) simply carry no context.
  const mentionIds = [...new Set(rows.filter((r) => r.type === 'mention' && r.reference_id).map((r) => String(r.reference_id)))];
  const ctx = {};
  if (mentionIds.length) {
    const placeholders = mentionIds.map(() => '?').join(',');
    const found = await db.all(
      `SELECT m.id AS mid, m.channel_id, ch.server_id FROM messages m
       JOIN channels ch ON ch.id = m.channel_id
       WHERE m.id IN (${placeholders})`,
      mentionIds
    );
    for (const f of found) {
      ctx[String(f.mid)] = { serverId: String(f.server_id), channelId: String(f.channel_id), messageId: String(f.mid) };
    }
  }
  return {
    // Unread is a whole-account badge count, not a per-page count, so it must
    // not shrink just because the caller paged.
    unreadCount: unread ? unread.n : 0,
    items: rows.map((r) => {
      const out = shape(r, r.actor_name ? { id: r.actor_id, username: r.actor_name, display_name: r.actor_display } : null);
      if (r.type === 'mention' && ctx[String(r.reference_id)]) out.context = ctx[String(r.reference_id)];
      return out;
    }),
    // Cursor for the next older page, or null at the end of the list.
    nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : null,
    hasMore,
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
