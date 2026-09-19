// Bearer-token auth. Rejects missing, invalid, expired, and revoked tokens.
const jwt = require('jsonwebtoken');
const db = require('../db');
const { fail } = require('../errors');
const { secret } = require('../util');

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
      req.user = user;
      next();
    })
    .catch((e) => next(e));
}

module.exports = auth;
