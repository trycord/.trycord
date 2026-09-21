// POST /api/auth/register, /login, /logout
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const auth = require('../middleware/auth');
const { fail, serviceError } = require('../errors');
const { now, uuid, sign } = require('../util');

const router = express.Router();
const rateLimit = require('../middleware/ratelimit');
const { TERMS_VERSION, PRIVACY_VERSION } = require('../legal');
const { checkPassword } = require('../auth/passwords');

function isUniqueViolation(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

router.post('/register', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const { username, password, displayName, termsVersion, privacyVersion } = req.body || {};
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
    res.json({ token, user: { id, username: name, displayName: displayName || name, createdAt: now() } });
  } catch (e) { next(e); }
});

router.post('/login', rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, 'VALIDATION_ERROR', 'username and password required');
    const user = await db.get('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
    if (!user) return fail(res, 'AUTH_REQUIRED', 'invalid credentials');
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return fail(res, 'AUTH_REQUIRED', 'invalid credentials');
    res.json({
      token: sign(user),
      user: { id: user.id, username: user.username, displayName: user.display_name, createdAt: user.created_at },
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

// Change password: verify current, enforce policy, reject reuse, then
// invalidate every other session and hand the caller a fresh token.
// The caller swaps to the new token; attacker-held old sessions die.
router.post('/change-password', auth, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return fail(res, 'VALIDATION_ERROR', 'current and new password required');
    }
    const pwErr = checkPassword(newPassword);
    if (pwErr) return fail(res, 'VALIDATION_ERROR', pwErr);
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!row) return fail(res, 'NOT_FOUND', 'user not found');
    const ok = await bcrypt.compare(String(currentPassword), row.password_hash);
    if (!ok) return fail(res, 'AUTH_REQUIRED', 'current password is incorrect');
    const reuse = await bcrypt.compare(String(newPassword), row.password_hash);
    if (reuse) return fail(res, 'VALIDATION_ERROR', 'new password must be different from the current one');
    const hash = await bcrypt.hash(String(newPassword), 10);
    const ts = now();
    await db.run(
      'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
      [hash, ts, req.user.id]
    );
    console.log(`[security] password_changed user=${req.user.id}`);
    const token = sign({ id: row.id, username: row.username });
    res.json({
      token,
      user: { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at },
    });
  } catch (e) { next(e); }
});

// Sign out everywhere: invalidates every session including the caller's.
// The client drops its token and returns to login.
router.post('/sessions/revoke-all', auth, async (req, res, next) => {
  try {
    await db.run('UPDATE users SET sessions_invalidated_at = ? WHERE id = ?', [now(), req.user.id]);
    console.log(`[security] all_sessions_revoked user=${req.user.id}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Sign out all other sessions: same invalidation, plus a fresh token so
// only the caller's session survives.
router.post('/sessions/revoke-others', auth, async (req, res, next) => {
  try {
    const ts = now();
    await db.run('UPDATE users SET sessions_invalidated_at = ? WHERE id = ?', [ts, req.user.id]);
    const row = await db.get('SELECT id, username, display_name, created_at FROM users WHERE id = ?', [req.user.id]);
    console.log(`[security] other_sessions_revoked user=${req.user.id}`);
    res.json({
      token: sign({ id: row.id, username: row.username }),
      user: { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at },
    });
  } catch (e) { next(e); }
});

// Forgot password: ALWAYS generic, so nobody can probe for accounts.
router.post('/forgot-password', rateLimit({ windowMs: 60000, max: 5 }), async (req, res, next) => {
  try {
    const recovery = require('../auth/recovery');
    await recovery.requestPasswordReset((req.body || {}).email);
    res.json({ ok: true, message: "If an account exists for that email, you'll receive a password reset link." });
  } catch (e) { next(e); }
});

// Reset password with a single-use token. Returns a fresh session.
router.post('/reset-password', rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const { token, newPassword, confirmPassword } = req.body || {};
    if (confirmPassword !== undefined && confirmPassword !== newPassword) {
      return fail(res, 'VALIDATION_ERROR', 'passwords do not match');
    }
    const recovery = require('../auth/recovery');
    res.json(await recovery.resetPassword(token, newPassword));
  } catch (e) { serviceError(res, e); }
});

// Verify a recovery email address.
router.post('/verify-email', rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const recovery = require('../auth/recovery');
    res.json(await recovery.verifyEmail((req.body || {}).token));
  } catch (e) { serviceError(res, e); }
});

// Request a verification email for a new recovery address (authenticated,
// so the address can't be probed anonymously).
router.post('/verify-email/resend', auth, rateLimit({ windowMs: 60000, max: 5 }), async (req, res, next) => {
  try {
    const recovery = require('../auth/recovery');
    res.json(await recovery.requestVerification(req.user.id, (req.body || {}).email));
  } catch (e) { serviceError(res, e); }
});

// Change recovery email: password-confirmed here, applied on verification.
router.post('/change-email', auth, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const recovery = require('../auth/recovery');
    res.json(await recovery.requestEmailChange(req.user.id, (req.body || {}).currentPassword, (req.body || {}).newEmail));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
