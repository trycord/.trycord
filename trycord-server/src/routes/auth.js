// POST /api/auth/register, /login, /logout
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const auth = require('../middleware/auth');
const { fail, serviceError } = require('../errors');
const { now, uuid, sign } = require('../util');

const router = express.Router();
const { TERMS_VERSION, PRIVACY_VERSION } = require('../legal');

function isUniqueViolation(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

router.post('/register', async (req, res, next) => {
  try {
    const { username, password, displayName, termsVersion, privacyVersion } = req.body || {};
    if (!username || !password) return fail(res, 'VALIDATION_ERROR', 'username and password required');
    if (String(password).length < 6) return fail(res, 'VALIDATION_ERROR', 'password must be 6+ characters');
    // Terms acceptance is recorded with the exact versions shown at signup.
    // Existing (pre-policy) accounts have NULL columns and are unaffected.
    if (termsVersion !== TERMS_VERSION || privacyVersion !== PRIVACY_VERSION) {
      return fail(res, 'VALIDATION_ERROR', 'please accept the current Terms of Service and Privacy Policy');
    }
    const name = String(username).trim();
    if (!/^[A-Za-z0-9_.]{2,32}$/.test(name)) {
      return fail(res, 'VALIDATION_ERROR', 'username must be 2-32 chars: letters, numbers, _ or .');
    }
    const id = uuid();
    const hash = await bcrypt.hash(String(password), 10);
    try {
      await db.run(
        'INSERT INTO users (id, username, display_name, password_hash, created_at, terms_version, privacy_version, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, String(displayName || name).slice(0, 32), hash, now(), TERMS_VERSION, PRIVACY_VERSION, now()]
      );
    } catch (e) {
      if (isUniqueViolation(e)) return fail(res, 'CONFLICT', 'username taken');
      throw e;
    }
    const token = sign({ id, username: name });
    res.json({ token, user: { id, username: name, displayName: displayName || name } });
  } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, 'VALIDATION_ERROR', 'username and password required');
    const user = await db.get('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
    if (!user) return fail(res, 'AUTH_REQUIRED', 'invalid credentials');
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return fail(res, 'AUTH_REQUIRED', 'invalid credentials');
    res.json({
      token: sign(user),
      user: { id: user.id, username: user.username, displayName: user.display_name },
    });
  } catch (e) { next(e); }
});

// Revoke the current token so it cannot be used again.
router.post('/logout', auth, async (req, res, next) => {
  try {
    if (req.user.jti) {
      const expiresAt = new Date(req.user.exp * 1000).toISOString();
      await db.run(`INSERT ${db.ignoreKeyword} INTO revoked_tokens (jti, expires_at) VALUES (?, ?)`, [req.user.jti, expiresAt]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
