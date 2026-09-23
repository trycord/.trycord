// Bearer-token auth. Rejects missing, invalid, expired, and revoked tokens.
// Tokens issued before the account's password change or session-invalidation
// markers are also rejected, so password changes and "sign out everywhere"
// actually end old sessions instead of leaving them valid.
const jwt = require('jsonwebtoken');
const db = require('../db');
const { fail } = require('../errors');
const { secret } = require('../util');

function tokenStale(user, row) {
  if (!row || !user.iat) return false;
  // JWT iat is whole seconds, so compare against the marker's whole
  // second too. A marker written in the same second the token was
  // issued must not flag a freshly-signed token as stale.
  for (const col of ['password_changed_at', 'sessions_invalidated_at']) {
    const t = row[col];
    if (!t) continue;
    const markerSec = Math.floor(new Date(t).getTime() / 1000);
    if (!Number.isNaN(markerSec) && user.iat < markerSec) return true;
  }
  return false;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return fail(res, 'AUTH_REQUIRED', 'authentication required');
  let user;
  try {
    user = jwt.verify(token, secret());
  } catch {
    return fail(res, 'AUTH_REQUIRED', 'invalid or expired session');
  }
  // One round trip for the whole session check: the revocation flag rides
  // along as a scalar subquery instead of a second sequential lookup.
  // Identical semantics: revoked jti, missing user, or stale markers reject.
  db.get(
    `SELECT u.password_changed_at, u.sessions_invalidated_at,
       (SELECT 1 FROM revoked_tokens r WHERE r.jti = ?) AS revoked
     FROM users u WHERE u.id = ?`,
    [user.jti || '', user.id]
  )
    .then((row) => {
      if (!row) return fail(res, 'NOT_FOUND', 'user not found');
      if (user.jti && row.revoked) return fail(res, 'SESSION_REVOKED', 'session revoked');
      if (tokenStale(user, row)) return fail(res, 'SESSION_REVOKED', 'session revoked');
      req.user = user;
      next();
    })
    .catch((e) => next(e));
}

module.exports = auth;
module.exports.tokenStale = tokenStale;
