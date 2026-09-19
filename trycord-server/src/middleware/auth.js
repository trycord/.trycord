// Bearer-token auth. Rejects missing, invalid, expired, and revoked tokens.
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../util');

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'authentication required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'invalid or expired session' });
    if (user.jti) {
      const revoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(user.jti);
      if (revoked) return res.status(401).json({ error: 'session revoked' });
    }
    req.user = user;
    next();
  });
}

module.exports = auth;
