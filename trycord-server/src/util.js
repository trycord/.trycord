// Shared helpers: ids, timestamps, tokens, membership checks. All database
// access goes through the db facade and is async.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required. Set it in the environment or .env (see .env.example).');
  return s;
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// jti is returned alongside the token so the caller can record the session.
// The signature authenticates the request; jti is what lets one session be
// revoked without touching the others. session_version can't do that - it's
// all-or-nothing by design.
function signWithJti(user) {
  const jti = uuid();
  const token = jwt.sign(
// iat has one-second resolution, so a token minted in the same second as a
// password change is indistinguishable from one minted after it and the change
// silently does nothing. The session version is what makes "invalidate every
// session" exact.
    { id: user.id, username: user.username, jti, sv: Number(user.session_version || 0) },
    secret(),
    { expiresIn: '7d' }
  );
  return { token, jti };
}

function sign(user) {
  return signWithJti(user).token;
}

async function isMember(userId, serverId) {
  return !!(await db.get('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?', [userId, serverId]));
}

async function isOwner(userId, serverId) {
  const row = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  return !!row && row.owner_id === userId;
}

// Channel row if it exists AND the user belongs to its server, else null.
// Accepts a channel id, or a slug when the community is known - the server
// argument isn't optional sugar, because channel slugs are unique per community
// and not globally, so two communities can each have a #general and guessing one
// would let a link resolve to somebody else's channel.
async function visibleChannel(channelId, userId, serverId) {
  let ch = null;
  if (serverId) {
    ch = await require('./services/slugs').resolveChannel(channelId, serverId);
  } else {
    ch = await db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
  }
  if (!ch || !(await isMember(userId, ch.server_id))) return null;
  return ch;
}

// Escape char is '!' not backslash: MySQL and MariaDB read a lone backslash
// inside a SQL string literal as an escape, which ends the literal and turns the
// statement into a syntax error.
function escapeLike(s) {
  return String(s).replace(/[%_!]/g, (c) => '!' + c);
}

module.exports = {
  signWithJti, secret, now, uuid, sign, isMember, isOwner, visibleChannel, escapeLike };
