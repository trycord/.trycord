const express = require('express');

const router = express.Router();
const bcrypt = require('bcrypt');
const { disconnectUser } = require('../../auth/gateway');
const { invalidateSessions } = require('./sessions');

const db = require('../../db');
const auth = require('../../middleware/auth');
const { fail, serviceError } = require('../../errors');
const { now, uuid, sign, signWithJti, secret } = require('../../util');
const rateLimit = require('../../middleware/ratelimit');
const events = require('../../services/events');
const { checkPassword, BCRYPT_COST } = require('../../auth/passwords');
const twofactor = require('../../services/twofactor');

// Changing a password, and signing out.
// 
// These are together because signing out without changing your password leaves
// every other session alive, which is the thing a reader of this file most needs
// to see next to it.

// Password re-confirmation. Failures are throttled into the same lockout counter
// as login, so a stolen session token cannot be brute-forced through here.
async function requirePassword(req, res) {
  const { password } = req.body || {};
  if (!password) {
    fail(res, 'VALIDATION_ERROR', 'password required');
    return false;
  }
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  const ok = row && await bcrypt.compare(String(password), row.password_hash);
  if (!ok) {
    await twofactor.recordFailure(req.user.id);
    fail(res, 'AUTH_REQUIRED', 'password is not correct');
    return false;
  }
  await twofactor.recordSuccess(req.user.id);
  return true;
}

// Invalidates every outstanding session by bumping the session version, which
// the auth middleware compares against the token's sv claim on every request.
//
// A counter, not a timestamp: JWT iat has one-second resolution, so a token
// issued in the same second as the change is indistinguishable from one issued
// after it and the invalidation silently does nothing. Every path that signs out
// sessions must go through here - the earlier version of this used the
// timestamp for three of the four, which left them racy.
//
// Returns the new version, because the caller usually has to hand back a fresh
// token and that token must carry it. Signing with a stale sv produces a token
// the middleware rejects immediately, which looks like a successful sign-out
// followed by a mysterious login failure.

// Revoke the current token so it cannot be used again.
router.post('/logout', auth, async (req, res, next) => {
  try {
    if (req.user.jti) {
      const expiresAt = new Date(req.user.exp * 1000).toISOString();
      await db.run(`INSERT ${db.ignoreKeyword} INTO revoked_tokens (jti, expires_at) VALUES (?, ?)`, [req.user.jti, expiresAt]);
    }
    // Announced before the sockets are dropped. Sent afterwards it reaches
    // nobody, because disconnectUser has already closed them - so the event
    // existed, the revocation was real, and no client was ever told.
    events.emitTo(req.user.id, 'session-revoked', {
      all: true, reason: 'revoke-all', actorJti: req.user.jti || null,
    });
    try { disconnectUser(req.user.id); } catch { /* gateway not wired */ }
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
    if (!ok) return fail(res, 'BAD_PASSWORD', 'current password is incorrect');
    const reuse = await bcrypt.compare(String(newPassword), row.password_hash);
    if (reuse) return fail(res, 'VALIDATION_ERROR', 'new password must be different from the current one');
    const hash = await bcrypt.hash(String(newPassword), BCRYPT_COST);
    const ts = now();
    // Changing the password is a credential change, so it invalidates sessions
    // through the same version bump as every other path. It used to stamp only
    // sessions_invalidated_at, which left the same-second hole open here, and
    // the replacement token was signed without a session_version - so for an
    // account whose version had ever been bumped, the token this call returns
    // was already stale and the member was signed out by their own password
    // change with no error.
    const version = await invalidateSessions(req.user.id);
    await db.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [hash, ts, req.user.id]);
    console.log(`[security] password_changed user=${req.user.id}`);
    const token = sign({ id: row.id, username: row.username, session_version: version });
    // Every token issued before now is stale, the caller's included. Sockets
    // are authorized only at upgrade time, so live ones are dropped here or a
    // stolen session stays interactive for the life of the connection.
    try { disconnectUser(req.user.id); } catch { /* gateway not wired */ }
    res.json({
      token,
      user: { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at },
    });
  } catch (e) { next(e); }
});

// Sign out everywhere: invalidates every session including the caller's.
// The client drops its token and returns to login.

module.exports = router;
// Changing a second factor is as sensitive as changing the password, so the same
// proof-of-password gate is used. It lived here and was not exported, and twofactor.js
// called it without importing it - so every route in that file answered 500 and 2FA could
// not be set up, enabled, disabled or recovered.
module.exports.requirePassword = requirePassword;
