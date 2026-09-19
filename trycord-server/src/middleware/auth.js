// Bearer-token auth. Rejects missing, invalid, expired, and revoked tokens.
const jwt = require('jsonwebtoken');
const db = require('../db');
const { fail } = require('../errors');
const { JWT_SECRET } = require('../util');

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return fail(res, 'AUTH_REQUIRED', 'authentication required');
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return fail(res, 'AUTH_REQUIRED', 'invalid or expired session');
    if (user.jti) {
      const revoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(user.jti);
      if (revoked) return fail(res, 'SESSION_REVOKED', 'session revoked');
    }
    req.user = user;
    next();
  });
}

module.exports = auth;
