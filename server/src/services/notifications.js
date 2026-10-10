// Notifications and the preferences that shape them.
//
// A notification is a row per reader, not per event: an unread count is a COUNT over one
// reader's rows, so it is exact and cheap rather than reconstructed from a shared log.

const db = require('../db');
const { now, uuid } = require('../util');

// The preference that decides whether a reader hears about one event. Categorised by
// server and by kind, so a community can be silenced wholesale or one channel can be.
const KINDS = ['mention', 'reply', 'dm', 'friend', 'system'];

async function notify(userId, { type, actorId, referenceId }) {
  if (KINDS.indexOf(type) === -1) return;

  const id = uuid();
  await db.run(
    `INSERT INTO notifications (id, user_id, type, actor_id, reference_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, type, actorId || null, referenceId || null, now()]
  );
  return { id };
}

async function list(userId, { limit = 50, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT n.*, a.username AS actor_name, a.display_name AS actor_display, a.avatar_url
       FROM notifications n LEFT JOIN users a ON a.id = n.actor_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
    [userId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0)]
  );

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actor: r.actor_id ? {
      id: r.actor_id,
      username: r.actor_name,
      displayName: r.actor_display,
      avatarUrl: r.avatar_url || null,
    } : null,
    referenceId: r.reference_id || null,
    createdAt: r.created_at,
    read: !!r.read_at,
  }));
}

async function unreadCount(userId) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId]
  );
  return Number(row.n || 0);
}

async function markRead(userId, ids) {
  const safe = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x).slice(0, 200);
  if (!safe.length) return { ok: true };

  const marks = safe.map(() => '?').join(',');
  await db.run(
    `UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${marks}) AND read_at IS NULL`,
    [now(), userId, ...safe]
  );
  return { ok: true };
}

async function markAllRead(userId) {
  await db.run(
    'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
    [now(), userId]
  );
  return { ok: true };
}

// Per-server and per-channel notification preferences.
async function prefs(userId) {
  const rows = await db.all(
    'SELECT server_id, categories FROM notification_prefs WHERE user_id = ?',
    [userId]
  );
  const perServer = {};
  for (const r of rows) {
    let categories = [];
    try { categories = JSON.parse(r.categories || '[]'); } catch { categories = []; }
    perServer[r.server_id] = Array.isArray(categories) ? categories : [];
  }
  return perServer;
}

async function setServerPref(userId, serverId, categories) {
  const clean = (Array.isArray(categories) ? categories : [])
    .filter((c) => typeof c === 'string' && c).slice(0, 20);

  await db.run(
    `INSERT INTO notification_prefs (user_id, server_id, categories, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, server_id) DO UPDATE SET
       categories = excluded.categories, updated_at = excluded.updated_at`,
    [userId, serverId, JSON.stringify(clean), now()]
  );
  return { serverId, categories: clean };
}

async function setChannelPref(userId, channelId, muted) {
  // A muted channel is a row, not a flag, so unmuting is a delete rather than an update
  // that has to distinguish "never set" from "explicitly on".
  if (muted) {
    await db.run(
      'INSERT OR IGNORE INTO muted_channels (user_id, channel_id, muted_at) VALUES (?, ?, ?)',
      [userId, channelId, now()]
    );
  } else {
    await db.run(
      'DELETE FROM muted_channels WHERE user_id = ? AND channel_id = ?',
      [userId, channelId]
    );
  }
  return { channelId, muted: !!muted };
}

async function mutedChannels(userId) {
  const rows = await db.all(
    'SELECT channel_id FROM muted_channels WHERE user_id = ?',
    [userId]
  );
  return rows.map((r) => r.channel_id);
}

module.exports = {
  notify, list, unreadCount, markRead, markAllRead,
  prefs, setServerPref, setChannelPref, mutedChannels, KINDS,
};
