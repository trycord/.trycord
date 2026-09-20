// Friendships: requests with pending/accepted/declined states, stored
// friendships in both directions for single-lookup listing. Every state
// change is transactional so half-accepted friendships cannot exist.
const db = require('../db');
const { now, uuid } = require('../util');

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}

async function userExists(id) {
  return !!(await db.get('SELECT id FROM users WHERE id = ?', [id]));
}

async function areFriends(a, b) {
  return !!(await db.get('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', [a, b]));
}

async function pendingBetween(a, b) {
  return await db.get(
    `SELECT * FROM friend_requests
     WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
       AND status = 'pending'`,
    [a, b, b, a]
  );
}

async function request(fromId, toId) {
  if (!toId) throw { code: 'VALIDATION_ERROR', message: 'userId required' };
  if (String(toId) === String(fromId)) throw { code: 'VALIDATION_ERROR', message: 'you cannot friend yourself' };
  if (!(await userExists(toId))) throw { code: 'NOT_FOUND', message: 'user not found' };
  if (await areFriends(fromId, toId)) throw { code: 'CONFLICT', message: 'already friends' };
  const existing = await pendingBetween(fromId, toId);
  if (existing) {
    // If they already asked us, accept instead of creating a mirror request.
    if (String(existing.to_user_id) === String(fromId)) {
      return { accepted: await accept(fromId, existing.id), autoAccepted: true };
    }
    throw { code: 'CONFLICT', message: 'friend request already pending' };
  }
  const ts = now();
  const row = { id: uuid(), from_user_id: fromId, to_user_id: toId, status: 'pending', created_at: ts, updated_at: ts };
  await db.run(
    'INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [row.id, row.from_user_id, row.to_user_id, row.status, row.created_at, row.updated_at]
  );
  return { request: row, autoAccepted: false };
}

async function incoming(userId) {
  const rows = await db.all(
    `SELECT r.*, u.username, u.display_name, u.created_at AS user_created
     FROM friend_requests r JOIN users u ON u.id = r.from_user_id
     WHERE r.to_user_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id, status: r.status, createdAt: r.created_at,
    from: { id: r.from_user_id, username: r.username, displayName: r.display_name, createdAt: r.user_created },
  }));
}

async function outgoing(userId) {
  const rows = await db.all(
    `SELECT r.*, u.username, u.display_name, u.created_at AS user_created
     FROM friend_requests r JOIN users u ON u.id = r.to_user_id
     WHERE r.from_user_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id, status: r.status, createdAt: r.created_at,
    to: { id: r.to_user_id, username: r.username, displayName: r.display_name, createdAt: r.user_created },
  }));
}

async function accept(userId, requestId) {
  const req = await db.get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
  if (!req || req.status !== 'pending') throw { code: 'NOT_FOUND', message: 'request not found' };
  if (String(req.to_user_id) !== String(userId)) {
    throw { code: 'PERMISSION_DENIED', message: 'only the recipient can accept' };
  }
  const ts = now();
  await db.transaction(async (t) => {
    await t.run("UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ?", [ts, req.id]);
    await t.run('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)', [req.from_user_id, req.to_user_id, ts]);
    await t.run('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)', [req.to_user_id, req.from_user_id, ts]);
  });
  return { id: req.id, status: 'accepted', friendId: req.from_user_id };
}

async function decline(userId, requestId) {
  const req = await db.get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
  if (!req || req.status !== 'pending') throw { code: 'NOT_FOUND', message: 'request not found' };
  if (String(req.to_user_id) !== String(userId)) {
    throw { code: 'PERMISSION_DENIED', message: 'only the recipient can decline' };
  }
  await db.run("UPDATE friend_requests SET status = 'declined', updated_at = ? WHERE id = ?", [now(), req.id]);
  return { id: req.id, status: 'declined' };
}

// Cancel your own outgoing pending request.
async function cancel(userId, requestId) {
  const req = await db.get('SELECT * FROM friend_requests WHERE id = ?', [requestId]);
  if (!req || req.status !== 'pending') throw { code: 'NOT_FOUND', message: 'request not found' };
  if (String(req.from_user_id) !== String(userId)) {
    throw { code: 'PERMISSION_DENIED', message: 'only the sender can cancel' };
  }
  await db.run('DELETE FROM friend_requests WHERE id = ?', [req.id]);
  return { id: req.id, cancelled: true };
}

async function list(userId) {
  const rows = await db.all(
    `SELECT u.id, u.username, u.display_name, u.created_at, f.created_at AS friends_since
     FROM friendships f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? ORDER BY u.username`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id, username: r.username, displayName: r.display_name,
    createdAt: r.created_at, friendsSince: r.friends_since,
  }));
}

async function remove(userId, friendId) {
  const row = await db.get(
    'SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?',
    [userId, friendId]
  );
  if (!row) throw { code: 'NOT_FOUND', message: 'not friends' };
  await db.transaction(async (t) => {
    await t.run('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', [userId, friendId]);
    await t.run('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', [friendId, userId]);
  });
  return { ok: true };
}

module.exports = {
  publicUser, areFriends, request, incoming, outgoing,
  accept, decline, cancel, list, remove,
};
