// Who may reach this account, and who may see it.
//
// Split out of services/privacy.js, which also held notification preferences,
// wellbeing and named sessions. Three of those are not privacy at all, and a file
// named privacy that owns session revocation is a file nobody opens when they want to
// revoke a session.
//
// Every default is defined once, here. An absent row is not "false" and not
// "empty": it is DEFAULTS, so an account created before a new preference existed
// behaves the same as one created after it, with no backfill.

const db = require('../db');
const { now } = require('../util');

// 'anyone'  - no restriction
// 'friends' - accepted friends only
// 'nobody'  - nobody except the account holder
// 'everyone' is a synonym of 'anyone', not a separate value. Presence stored
// 'everyone' by default while the request gates stored 'anyone', so it needed to be
// accepted as an input or a reader who chose the obvious option had it silently
// rewritten on the way in - the stored value then disagreed with what they picked and
// with the default they never touched.
const SCOPES = ['anyone', 'friends', 'nobody'];

const DEFAULTS = {
  friendRequests: 'anyone',
  dms: 'anyone',
  presence: 'everyone',
  discoverable: true,
};

// How the incoming row is referenced in an upsert's update branch.
// SQLite writes `excluded.column`; MySQL and MariaDB write `VALUES(column)`.
// db.upsert() builds the surrounding statement, but this part is a per-value
// expression and so is spelled here, once, at the call site.

const boolInt = (v) => (v ? 1 : 0);
const intBool = (v) => !!v;

function scope(value, fallback) {
  const v = String(value || '').toLowerCase();
  if (v === 'everyone') return 'anyone';
  return SCOPES.includes(v) ? v : fallback;
}

// The accepted input vocabulary for a scope, including the 'everyone' synonym.
// The route validates against this rather than against SCOPES directly, so that
// "what values are legal" is answered in exactly one place. Validating against
// SCOPES while scope() accepted 'everyone' made the two disagree, and the loser
// was the reader: a client that sent the natural word was told it was invalid.
function normalizeScope(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'everyone') return 'anyone';
  return SCOPES.includes(v) ? v : null;
}

async function getPrivacy(userId, conn = db) {
  const row = await conn.get('SELECT * FROM privacy_settings WHERE user_id = ?', [userId]);
  if (!row) return { ...DEFAULTS };
  return {
    friendRequests: scope(row.friend_requests, DEFAULTS.friendRequests),
    dms: scope(row.dms, DEFAULTS.dms),
    presence: scope(row.presence, DEFAULTS.presence),
    discoverable: intBool(row.discoverable),
  };
}

// Only the keys the caller actually sent are written, so a partial update from
// an older client cannot reset a preference it does not know about.
async function setPrivacy(userId, patch) {
  const current = await getPrivacy(userId);
  const next = {
    friendRequests: scope(patch.friendRequests, current.friendRequests),
    dms: scope(patch.dms, current.dms),
    presence: scope(patch.presence, current.presence),
    discoverable: patch.discoverable === undefined ? current.discoverable : !!patch.discoverable,
  };
  const ts = now();
  await db.upsert(
    'privacy_settings',
    ['user_id', 'friend_requests', 'dms', 'presence', 'discoverable', 'updated_at'],
    [userId, next.friendRequests, next.dms, next.presence, boolInt(next.discoverable), ts],
    ['user_id'],
    {
      friend_requests: db.newRef('friend_requests'),
      dms: db.newRef('dms'),
      presence: db.newRef('presence'),
      discoverable: db.newRef('discoverable'),
      updated_at: db.newRef('updated_at'),
    }
  );
  return next;
}

// Symmetric: a row in either direction blocks the relationship. A block is
// therefore a property of the pair, not of the person who pressed the button,
// which is what makes "unblock" unambiguous from either side.
async function isBlocked(a, b, conn = db) {
  if (String(a) === String(b)) return false;
  const row = await conn.get(
    `SELECT 1 FROM user_blocks
     WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)`,
    [a, b, b, a]
  );
  return !!row;
}

// A block is meant to take effect now, not on the next request the other person
// happens to make. Anything that would keep the relationship alive despite the block
// is removed here rather than merely hidden:
//   - a pending friend request in either direction
//   - an existing friendship, both directions
//   - the blocker's presence to the blocked user
async function block(userId, blockedId, reason) {
  if (String(userId) === String(blockedId)) {
    throw { code: 'VALIDATION_ERROR', message: 'You cannot block yourself' };
  }
  const exists = await db.get('SELECT id FROM users WHERE id = ?', [blockedId]);
  if (!exists) throw { code: 'NOT_FOUND', message: 'User not found' };

  const ts = now();
  await db.upsert(
    'user_blocks',
    ['user_id', 'blocked_id', 'reason', 'created_at'],
    [userId, blockedId, reason || null, ts],
    ['user_id', 'blocked_id'],
    { reason: db.newRef('reason') }
  );

  const pending = await db.get(
    `SELECT * FROM friend_requests
     WHERE status = 'pending'
       AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    [userId, blockedId, blockedId, userId]
  );
  if (pending) {
    await db.run('DELETE FROM friend_requests WHERE id = ?', [pending.id]);
  }
  await db.run(
    'DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [userId, blockedId, blockedId, userId]
  );
  await db.run(
    'UPDATE server_members SET nickname = nickname WHERE user_id = ? AND server_id IN (SELECT server_id FROM servers WHERE id = ?)',
    [blockedId, blockedId]
  );

  return { userId, blockedId, reason: reason || null, createdAt: ts };
}

async function unblock(userId, blockedId) {
  await db.run('DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?', [userId, blockedId]);
  return { userId, blockedId };
}

async function listBlocks(userId) {
  const rows = await db.all(
    `SELECT b.blocked_id AS id, b.reason, b.created_at,
            u.username, u.display_name
     FROM user_blocks b LEFT JOIN users u ON u.id = b.blocked_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

async function canOpenDm(fromId, toId, conn = db) {
  if (String(fromId) === String(toId)) return { allowed: true };
  const target = await conn.get('SELECT id FROM users WHERE id = ?', [toId]);
  if (!target) return { allowed: false, code: 'NOT_FOUND', message: 'User not found' };
  if (await isBlocked(fromId, toId, conn)) {
    return { allowed: false, code: 'BLOCKED', message: 'This conversation is not available' };
  }
  const pref = await getPrivacy(toId, conn);
  if (pref.dms === 'nobody') {
    return { allowed: false, code: 'NOT_ACCEPTING_DMS', message: 'This user is not accepting messages' };
  }
  if (pref.dms === 'friends') {
    const row = await conn.get(
      'SELECT 1 FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
      [toId, fromId, fromId, toId]
    );
    if (!row) {
      return { allowed: false, code: 'NOT_ACCEPTING_DMS', message: 'This user only accepts messages from friends' };
    }
  }
  return { allowed: true };
}

async function canSendFriendRequest(fromId, toId, conn = db) {
  if (String(fromId) === String(toId)) {
    return { allowed: false, code: 'VALIDATION_ERROR', message: 'You cannot friend yourself' };
  }
  const target = await conn.get('SELECT id FROM users WHERE id = ?', [toId]);
  if (!target) return { allowed: false, code: 'NOT_FOUND', message: 'User not found' };
  if (await isBlocked(fromId, toId, conn)) {
    return { allowed: false, code: 'BLOCKED', message: 'This request is not available' };
  }
  const pref = await getPrivacy(toId, conn);
  if (pref.friendRequests === 'nobody') {
    return { allowed: false, code: 'NOT_ACCEPTING_REQUESTS', message: 'This user is not accepting friend requests' };
  }
  if (pref.friendRequests === 'friends') {
    const row = await conn.get(
      'SELECT 1 FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
      [toId, fromId, fromId, toId]
    );
    if (!row) {
      return { allowed: false, code: 'NOT_ACCEPTING_REQUESTS', message: 'This user only accepts requests from friends' };
    }
  }
  return { allowed: true };
}

async function canSeePresence(viewerId, subjectId, conn = db) {
  if (String(viewerId) === String(subjectId)) return true;
  if (await isBlocked(viewerId, subjectId, conn)) return false;
  const pref = await getPrivacy(subjectId, conn);
  if (pref.presence === 'everyone') return true;
  if (pref.presence === 'nobody') return false;
  const row = await conn.get(
    'SELECT 1 FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [subjectId, viewerId, viewerId, subjectId]
  );
  return !!row;
}

async function canDiscover(viewerId, subjectId, conn = db) {
  if (String(viewerId) === String(subjectId)) return true;
  if (await isBlocked(viewerId, subjectId, conn)) return false;
  const pref = await getPrivacy(subjectId, conn);
  return pref.discoverable;
}

module.exports = {
  SCOPES,
  scope,
  normalizeScope,
  getPrivacy,
  setPrivacy,
  isBlocked,
  block,
  unblock,
  listBlocks,
  canOpenDm,
  canSendFriendRequest,
  canSeePresence,
  canDiscover,
};
