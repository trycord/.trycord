// Shared helpers: ids, timestamps, tokens, membership checks.
// All database access is async through the db facade (sqlite or mysql).
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

// The jti is returned alongside the token so the caller can record the session.
// The signature is what authenticates a request; the jti is what lets one
// session be revoked without touching the others, which session_version cannot
// do (it is all-or-nothing by design).
function signWithJti(user) {
  const jti = uuid();
  const token = jwt.sign(
    // sv is the session version. It is what makes "invalidate every session"
    // exact: iat has one-second resolution, so a token issued in the same second
    // as a password change or a 2FA enable is indistinguishable from one issued
    // after it, and the change silently fails to take effect.
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
// Accepts a channel id, or a channel slug when the owning community is known.
// The server argument is not optional sugar: channel slugs are unique per
// community, not globally, so two communities can each have a #general. Without
// the server there is no single correct answer, and guessing one would let a
// link resolve to somebody else's channel.
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

// LIKE metacharacters must match literally, never as wildcards. The escape
// character is '!' rather than backslash because MySQL and MariaDB parse a
// lone backslash inside a SQL string literal as an escape, which terminates
// the literal and turns the statement into a syntax error. '!' needs no
// escaping in either JS or SQL string syntax.
function escapeLike(s) {
  return String(s).replace(/[%_!]/g, (c) => '!' + c);
}

module.exports = {
  signWithJti, secret, now, uuid, sign, isMember, isOwner, visibleChannel, escapeLike };
