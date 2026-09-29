// POST /api/auth/register, /login, /logout
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const auth = require('../middleware/auth');
const { fail, serviceError } = require('../errors');
const { now, uuid, sign, secret } = require('../util');
const jwt = require('jsonwebtoken');

const router = express.Router();
const rateLimit = require('../middleware/ratelimit');
const { TERMS_VERSION, PRIVACY_VERSION } = require('../legal');
const { checkPassword, BCRYPT_COST } = require('../auth/passwords');
const enforcement = require('../services/enforcement');
const recovery = require('../auth/recovery');
const twofactor = require('../services/twofactor');

// A challenge is not a session. It is a short-lived, single-audience token that
// proves "this password was correct" and nothing else: the auth middleware
// rejects it, and it carries no username or permissions. Its only power is to
// let /2fa/verify mint a real session, and only while a second factor is still
// outstanding. 5 minutes is long enough to find an authenticator and short
// enough that a challenge left in a log or a proxy buffer is not useful later.
const CHALLENGE_TTL_SECONDS = 300;

function signChallenge(userId) {
  return jwt.sign({ sub: userId, jti: uuid(), purpose: 'mfa' }, secret(), { expiresIn: CHALLENGE_TTL_SECONDS });
}

function readChallenge(token) {
  try {
    const claims = jwt.verify(token, secret());
    return claims && claims.purpose === 'mfa' && claims.sub ? String(claims.sub) : null;
  } catch {
    return null;
  }
}

let disconnectUser = () => {};
function setGateway(gw) {
  if (gw && typeof gw.disconnectUser === 'function') disconnectUser = gw.disconnectUser;
}

function isUniqueViolation(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

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

router.post('/login', rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, 'VALIDATION_ERROR', 'username and password required');
    const user = await db.get('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
    if (!user) return fail(res, 'AUTH_REQUIRED', 'invalid credentials');

    // Lockout is checked after the lookup but before the password comparison, so
    // a locked account cannot be used as a password oracle: the same response
    // comes back whether or not the guess would have been right.
    const lockMs = await twofactor.remainingLockMs(user.id);
    if (lockMs > 0) {
      return fail(res, 'ACCOUNT_LOCKED', 'too many failed attempts; try again later', 429, {
        retryAfterSeconds: Math.ceil(lockMs / 1000),
      });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      const locked = await twofactor.recordFailure(user.id);
      return locked
        ? fail(res, 'ACCOUNT_LOCKED', 'too many failed attempts; try again later', 429, {
          retryAfterSeconds: Math.ceil(twofactor.LOCKOUT_MS / 1000),
        })
        : fail(res, 'AUTH_REQUIRED', 'invalid credentials');
    }
    // Reset on success, never per attempt: resetting on every attempt would let
    // a caller interleave one guess with the real password to hold the counter
    // at zero indefinitely.
    await twofactor.recordSuccess(user.id);

    // Trust & Safety: a correct login from a banned/suspended account must
    // not mint new sessions — the account holder gets the enforcement
    // details plus the action id so they can open an appeal with it.
    const ef = enforcement.describeEffective(user);
    if (ef) {
      const action = await enforcement.activeAccountAction(user.id);
      return fail(res, 'ACCOUNT_ENFORCED', 'this account is under a moderation action', 403, {
        type: ef.type,
        until: ef.until || null,
        actionId: action ? action.id : null,
      });
    }
    // Same promotion at login: covers listed names whose accounts
    // postdate the last boot, with case-insensitive matching.
    await enforcement.ensureListedAdmin(user.id, user.username);

    // Second factor. The password was correct, but no session is minted yet:
    // returning one here would make the second factor advisory.
    if (user.totp_enabled_at) {
      return res.json({
        mfaRequired: true,
        challengeToken: signChallenge(user.id),
        expiresInSeconds: CHALLENGE_TTL_SECONDS,
      });
    }

    res.json({
      token: sign(user),
      user: { id: user.id, username: user.username, displayName: user.display_name, createdAt: user.created_at },
    });
  } catch (e) { next(e); }
});

// ---- second factor -------------------------------------------------------

// Completes a login that stopped at the second factor. Takes the challenge
// token rather than the password, so the password is not re-sent a second time
// and cannot be harvested from this endpoint's logs.
router.post('/2fa/verify', rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const { challengeToken, code } = req.body || {};
    if (!challengeToken || !code) return fail(res, 'VALIDATION_ERROR', 'challengeToken and code required');
    const userId = readChallenge(challengeToken);
    if (!userId) return fail(res, 'AUTH_REQUIRED', 'challenge expired or invalid');

    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return fail(res, 'NOT_FOUND', 'user not found');
    // The factor may have been turned off between the challenge and the code.
    if (!user.totp_enabled_at) return fail(res, 'VALIDATION_ERROR', '2FA is not enabled for this account');

    const result = await twofactor.verifySecondFactor(user.id, code);
    if (!result.ok) return fail(res, 'AUTH_REQUIRED', 'invalid code');

    res.json({
      token: sign(user),
      user: { id: user.id, username: user.username, displayName: user.display_name, createdAt: user.created_at },
      usedRecoveryCode: result.via === 'recovery',
    });
  } catch (e) { next(e); }
});

// ---- 2FA management ------------------------------------------------------
//
// All of these require a recent session (the normal auth middleware) and, for
// enable and disable, the current password. A stolen session token must not be
// enough to remove the factor that is supposed to survive it.

router.get('/2fa/status', auth, async (req, res, next) => {
  try {
    res.json(await twofactor.status(req.user.id));
  } catch (e) { next(e); }
});

router.post('/2fa/setup', auth, async (req, res, next) => {
  try {
    if (!(await requirePassword(req, res))) return;
    const out = await twofactor.beginSetup(req.user.id, req.user.username);
    res.json(out);
  } catch (e) { next(e); }
});

router.post('/2fa/enable', auth, async (req, res, next) => {
  try {
    if (!(await requirePassword(req, res))) return;
    const out = await twofactor.enable(req.user.id, (req.body || {}).code);
    // Changing the authentication factor invalidates existing sessions: a
    // session minted before the factor existed should not outlive it.
    await invalidateSessions(req.user.id);
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

router.post('/2fa/disable', auth, async (req, res, next) => {
  try {
    if (!(await requirePassword(req, res))) return;
    await twofactor.disable(req.user.id, (req.body || {}).code);
    await invalidateSessions(req.user.id);
    res.json({ ok: true });
  } catch (e) { serviceError(res, e); }
});

router.post('/2fa/recovery-codes', auth, async (req, res, next) => {
  try {
    if (!(await requirePassword(req, res))) return;
    // Re-issue by disabling and re-enabling is not an option: it would need a
    // current code the member may no longer have. Mint a fresh set directly.
    res.json(await twofactor.issueRecoveryCodes(req.user.id));
  } catch (e) { serviceError(res, e); }
});

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

// Bumps the session version, which the auth middleware compares against the
// token's sv claim on every request. Increments a counter rather than stamping a
// timestamp because iat has one-second resolution: a token issued in the same
// second as this call is otherwise indistinguishable from a fresh one, and the
// change would not take effect.
async function invalidateSessions(userId) {
  await db.run('UPDATE users SET session_version = session_version + 1, sessions_invalidated_at = ? WHERE id = ?', [now(), userId]);
  if (typeof disconnectUser === 'function') {
    try { disconnectUser(userId, 'security settings changed'); } catch { /* gateway not wired */ }
  }
}

// Revoke the current token so it cannot be used again.
router.post('/logout', auth, async (req, res, next) => {
  try {
    if (req.user.jti) {
      const expiresAt = new Date(req.user.exp * 1000).toISOString();
      await db.run(`INSERT ${db.ignoreKeyword} INTO revoked_tokens (jti, expires_at) VALUES (?, ?)`, [req.user.jti, expiresAt]);
    }
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
    await db.run(
      'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
      [hash, ts, req.user.id]
    );
    console.log(`[security] password_changed user=${req.user.id}`);
    const token = sign({ id: row.id, username: row.username });
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
router.post('/sessions/revoke-all', auth, async (req, res, next) => {
  try {
    await db.run('UPDATE users SET sessions_invalidated_at = ? WHERE id = ?', [now(), req.user.id]);
    console.log(`[security] all_sessions_revoked user=${req.user.id}`);
    try { disconnectUser(req.user.id); } catch { /* gateway not wired */ }
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
    try { disconnectUser(req.user.id); } catch { /* gateway not wired */ }
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

// Request a short-lived, single-use ticket for the WebSocket handshake.
// Bearer JWTs never belong in a URL (logs, proxies, referrers), so the
// client exchanges its token for a ticket over HTTPS and connects with it.
let ticketIssuer = null;
function setTicketIssuer(fn) { ticketIssuer = fn; }

router.post('/ws/ticket', auth, rateLimit({ windowMs: 60000, max: 60 }), (req, res) => {
  if (!ticketIssuer) return fail(res, 'NOT_FOUND', 'websocket gateway unavailable');
  res.json({
    ticket: ticketIssuer({
      id: req.user.id,
      username: req.user.username,
      jti: req.user.jti || null,
      iat: req.user.iat,
    }),
  });
});

module.exports = router;
module.exports.setGateway = setGateway;
module.exports.setTicketIssuer = setTicketIssuer;
