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
  const issuedMs = user.iat * 1000;
  for (const col of ['password_changed_at', 'sessions_invalidated_at']) {
    const t = row[col];
    if (!t) continue;
    const markerMs = new Date(t).getTime();
    if (!Number.isNaN(markerMs) && issuedMs <= markerMs) return true;
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
  db.get('SELECT 1 FROM revoked_tokens WHERE jti = ?', [user.jti])
    .then((revoked) => {
      if (user.jti && revoked) return fail(res, 'SESSION_REVOKED', 'session revoked');
      return db.get(
        'SELECT password_changed_at, sessions_invalidated_at FROM users WHERE id = ?',
        [user.id]
      ).then((row) => {
        if (!row) return fail(res, 'NOT_FOUND', 'user not found');
        if (tokenStale(user, row)) return fail(res, 'SESSION_REVOKED', 'session revoked');
        req.user = user;
        next();
      });
    })
    .catch((e) => next(e));
}

module.exports = auth;
