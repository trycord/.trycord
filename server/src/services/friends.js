// Friends: requests, and the friendships that come out of them.
//
// A request and a friendship are separate rows, so a declined or withdrawn request leaves
// the two people free to ask again without the history of the old attempt following them.

const db = require('../db');
const { now, uuid } = require('../util');

async function list(userId) {
  const friends = await db.all(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, f.created_at AS since
       FROM friendships f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ?
      ORDER BY u.display_name`,
    [userId]
  );

  const incoming = await db.all(
    `SELECT r.id, r.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_url
       FROM friend_requests r JOIN users u ON u.id = r.from_user_id
      WHERE r.to_user_id = ? AND r.status = 'pending'
      ORDER BY r.created_at DESC`,
    [userId]
  );

  const outgoing = await db.all(
    `SELECT r.id, r.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_url
       FROM friend_requests r JOIN users u ON u.id = r.to_user_id
      WHERE r.from_user_id = ? AND r.status = 'pending'
      ORDER BY r.created_at DESC`,
    [userId]
  );

  const shapeUser = (r) => ({
    id: r.user_id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url || null,
    since: r.created_at,
  });

  return {
    friends: friends.map((r) => ({
      id: r.id, username: r.username, displayName: r.display_name,
      avatarUrl: r.avatar_url || null, since: r.since,
    })),
    incoming: incoming.map((r) => ({ id: r.id, ...shapeUser(r) })),
    outgoing: outgoing.map((r) => ({ id: r.id, ...shapeUser(r) })),
  };
}

async function sendRequest(fromUserId, toUserId) {
  if (String(fromUserId) === String(toUserId)) {
    throw { code: 'VALIDATION_ERROR', message: 'you cannot add yourself as a friend' };
  }

  const target = await db.get('SELECT id FROM users WHERE id = ?', [toUserId]);
  if (!target) throw { code: 'NOT_FOUND', message: 'user not found' };

  // A friendship already exists, so there is nothing to ask for.
  const already = await db.get(
    'SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?',
    [fromUserId, toUserId]
  );
  if (already) throw { code: 'ALREADY_EXISTS', message: 'you are already friends' };

  // A privacy setting may close friend requests entirely.
  const prefs = await privacy(toUserId);
  if (prefs.friendRequests === 'nobody') {
    throw { code: 'FORBIDDEN', message: 'that person is not accepting friend requests' };
  }

  const existing = await db.get(
    `SELECT id, status FROM friend_requests
      WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
    [fromUserId, toUserId]
  );
  if (existing) throw { code: 'ALREADY_EXISTS', message: 'a request is already pending' };

  // The mirror request: if they already asked, accepting is the only sensible answer.
  const mirror = await db.get(
    `SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
    [toUserId, fromUserId]
  );
  if (mirror) return accept(fromUserId, mirror.id);

  const id = uuid();
  await db.run(
    'INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, fromUserId, toUserId, 'pending', now(), now()]
  );
  return { id };
}

async function accept(userId, requestId) {
  const req = await db.get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
  if (!req) throw { code: 'NOT_FOUND', message: 'request not found' };
  if (req.to_user_id !== userId) {
    throw { code: 'PERMISSION_DENIED', message: 'that request is not yours to accept' };
  }
  if (req.status !== 'pending') throw { code: 'VALIDATION_ERROR', message: 'that request is no longer pending' };

  await db.transaction(async (t) => {
    await t.run('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?', ['accepted', now(), requestId]);
    await t.run(
      'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
      [req.from_user_id, req.to_user_id, now()]
    );
    await t.run(
      'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
      [req.to_user_id, req.from_user_id, now()]
    );
  });
  return { ok: true };
}

async function decline(userId, requestId) {
  const req = await db.get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
  if (!req) throw { code: 'NOT_FOUND', message: 'request not found' };
  if (req.to_user_id !== userId) {
    throw { code: 'PERMISSION_DENIED', message: 'that request is not yours to decline' };
  }
  await db.run('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?', ['declined', now(), requestId]);
  return { ok: true };
}

async function withdraw(userId, requestId) {
  const req = await db.get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
  if (!req) throw { code: 'NOT_FOUND', message: 'request not found' };
  if (req.from_user_id !== userId) {
    throw { code: 'PERMISSION_DENIED', message: 'that request is not yours to withdraw' };
  }
  await db.run('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?', ['withdrawn', now(), requestId]);
  return { ok: true };
}

async function remove(userId, friendId) {
  await db.run(
    'DELETE FROM friendships WHERE user_id = ? AND friend_id = ?',
    [userId, friendId]
  );
  await db.run(
    'DELETE FROM friendships WHERE user_id = ? AND friend_id = ?',
    [friendId, userId]
  );
  return { ok: true };
}

// The privacy settings that govern who may reach this person.
async function privacy(userId) {
  const row = await db.get('SELECT * FROM privacy_settings WHERE user_id = ?', [userId]);
  return {
    friendRequests: (row && row.friend_requests) || 'everyone',
    dms: (row && row.dms) || 'everyone',
    presence: (row && row.presence) || 'everyone',
    discoverable: row ? !!row.discoverable : true,
  };
}

async function setPrivacy(userId, patch) {
  const current = await privacy(userId);
  const next = {
    friendRequests: patch.friendRequests || current.friendRequests,
    dms: patch.dms || current.dms,
    presence: patch.presence || current.presence,
    discoverable: patch.discoverable === undefined ? current.discoverable : !!patch.discoverable,
  };

  await db.run(
    `INSERT INTO privacy_settings (user_id, friend_requests, dms, presence, discoverable, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       friend_requests = excluded.friend_requests,
       dms = excluded.dms,
       presence = excluded.presence,
       discoverable = excluded.discoverable,
       updated_at = excluded.updated_at`,
    [userId, next.friendRequests, next.dms, next.presence, next.discoverable ? 1 : 0, now()]
  );
  return next;
}

// Blocking is symmetric and immediate: neither side can reach the other.
async function block(userId, blockedId) {
  await db.run(
    'INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)',
    [userId, blockedId, now()]
  );
  await require('./dms').pairKey(userId, blockedId);
  return { ok: true };
}

async function unblock(userId, blockedId) {
  await db.run('DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?', [userId, blockedId]);
  return { ok: true };
}

async function blocks(userId) {
  const rows = await db.all(
    `SELECT u.id, u.username, u.display_name FROM user_blocks b
       JOIN users u ON u.id = b.blocked_id
      WHERE b.user_id = ?`,
    [userId]
  );
  return rows;
}

async function isBlockedEitherWay(a, b) {
  const row = await db.get(
    `SELECT 1 FROM user_blocks
      WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)`,
    [a, b, b, a]
  );
  return !!row;
}

module.exports = {
  list, sendRequest, accept, decline, withdraw, remove,
  privacy, setPrivacy, block, unblock, blocks, isBlockedEitherWay,
};
