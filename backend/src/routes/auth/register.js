const express = require('express');

const router = express.Router();
const bcrypt = require('bcrypt');
const recovery = require('../../auth/recovery');

const db = require('../../db');
const { fail, serviceError } = require('../../errors');
const { now, uuid, sign, signWithJti, secret } = require('../../util');
const rateLimit = require('../../middleware/ratelimit');
const { TERMS_VERSION, PRIVACY_VERSION } = require('../../legal');
const { checkPassword, BCRYPT_COST } = require('../../auth/passwords');
const enforcement = require('../../services/enforcement');
const { isUniqueViolation } = require('./unique-violation');

// POST /register

router.post('/register', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const { username, password, displayName, email: rawEmail, termsVersion, privacyVersion } = req.body || {};
    const email = rawEmail ? recovery.normalizeEmail(rawEmail) : null;
    if (rawEmail && !email) return fail(res, 'VALIDATION_ERROR', 'email address is invalid');
    if (!username || !password) return fail(res, 'VALIDATION_ERROR', 'username and password required');
    const pwErr = checkPassword(password);
    if (pwErr) return fail(res, 'VALIDATION_ERROR', pwErr);
    // Terms acceptance is recorded with the exact versions shown at signup.
    // Existing (pre-policy) accounts have NULL columns and are unaffected.
    if (termsVersion !== TERMS_VERSION || privacyVersion !== PRIVACY_VERSION) {
      return fail(res, 'VALIDATION_ERROR', 'please accept the current Terms of Service and Privacy Policy');
    }
    const name = String(username).trim();
    if (!/^[A-Za-z0-9_.]{2,32}$/.test(name)) {
      return fail(res, 'VALIDATION_ERROR', 'username must be 2-32 chars: letters, numbers, _ or .');
    }
    if (email) {
      const taken = await db.get('SELECT id FROM users WHERE email = ?', [email]);
      if (taken) return fail(res, 'CONFLICT', 'that email is already in use');
    }
    const id = uuid();
    const hash = await bcrypt.hash(String(password), BCRYPT_COST);
    try {
      await db.run(
        'INSERT INTO users (id, username, display_name, password_hash, created_at, terms_version, privacy_version, terms_accepted_at, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, String(displayName || name).slice(0, 32), hash, now(), TERMS_VERSION, PRIVACY_VERSION, now(), email]
      );
    } catch (e) {
      if (isUniqueViolation(e)) return fail(res, 'CONFLICT', 'username taken');
      throw e;
    }
    if (email) recovery.requestVerification(id, email).catch(() => {});
    // Listed platform admins are promoted at creation too, not just at
    // boot — accounts made after the server started must not miss it.
    await enforcement.ensureListedAdmin(id, name);
    const token = sign({ id, username: name });
    res.json({ token, user: { id, username: name, displayName: displayName || name, email: email || null, emailVerified: false, createdAt: now() } });
  } catch (e) { next(e); }
});

module.exports = router;
