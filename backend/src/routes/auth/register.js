const express = require('express');

const router = express.Router();
const bcrypt = require('bcrypt');
const recovery = require('../../auth/recovery');

const db = require('../../db');
const { fail, serviceError } = require('../../errors');
const { now, uuid } = require('../../util');
const rateLimit = require('../../middleware/ratelimit');
const { TERMS_VERSION, PRIVACY_VERSION } = require('../../legal');
const { checkPassword, BCRYPT_COST } = require('../../auth/passwords');
const enforcement = require('../../services/enforcement');
const { isUniqueViolation } = require('./unique-violation');

// POST /register

router.post('/register', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const features = require('../../features');
    if (!features.current.registration) {
      return fail(res, 'REGISTRATION_DISABLED',
        'this instance is not accepting new accounts', 403);
    }

    const { username, password, displayName, email: rawEmail, termsVersion, privacyVersion } = req.body || {};
    const email = rawEmail ? recovery.normalizeEmail(rawEmail) : null;
    if (rawEmail && !email) return fail(res, 'VALIDATION_ERROR', 'email address is invalid');
    if (!username || !password) return fail(res, 'VALIDATION_ERROR', 'username and password required');
    const pwErr = checkPassword(password);
    if (pwErr) return fail(res, 'VALIDATION_ERROR', pwErr);
    // An address is required when the instance enforces verification, because
    // there is otherwise no way to verify anything and the account would be
    // stuck unable to post.
    if (features.current.emailVerificationRequired && !email) {
      return fail(res, 'VALIDATION_ERROR',
        'this instance requires a verified email address, so an address is required');
    }
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
    // Approval on means the account exists but cannot be used until an admin says
    // so. Accounts created while it is off are approved at creation, and accounts
    // that existed before the column are NULL, which the auth gate reads as
    // "not pending" so switching the setting on never locks out existing members.
    const awaitingApproval = require('../../features').current.registrationApproval;
    try {
      await db.run(
        'INSERT INTO users (id, username, display_name, password_hash, created_at, terms_version, privacy_version, terms_accepted_at, email, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, String(displayName || name).slice(0, 32), hash, now(), TERMS_VERSION,
          PRIVACY_VERSION, now(), email, awaitingApproval ? null : now()]
      );
    } catch (e) {
      if (isUniqueViolation(e)) return fail(res, 'CONFLICT', 'username taken');
      throw e;
    }
    if (email) recovery.requestVerification(id, email).catch(() => {});
    // Listed platform admins are promoted at creation too, not just at
    // boot, so accounts made after the server started must not miss it.
    await enforcement.ensureListedAdmin(id, name);
    // A pending account gets a token so it can see the waiting screen, which is
    // the only thing that token can reach. Everything else refuses it.
    //
    // The session is issued through the one shared path, so the session that
    // registration creates is recorded like any other: it appears in the
    // account's own list of signed-in devices and can be ended on its own.
    // Registration used to mint a token directly, which produced a session the
    // Security page could not show and could not revoke.
    const { issued } = require('./issued');
    issued(res, {
      id,
      username: name,
      display_name: String(displayName || name).slice(0, 32),
      created_at: now(),
      session_version: 0,
    }, req, {
      pendingApproval: !!awaitingApproval,
      user: { email: email || null, emailVerified: false },
    });
  } catch (e) { next(e); }
});

module.exports = router;
