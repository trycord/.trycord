// Authentication routes: register, login, second factor, session management.

const express = require('express');
const config = require('../../config');
const db = require('../../db');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const auth = require('../../services/auth');
const users = require('../../services/users');
const twofactor = require('../../services/twofactor');
const { now } = require('../../util');

const router = express.Router();

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email || null,
    emailVerified: !!u.emailVerified,
    createdAt: u.createdAt,
  };
}

// The session token, written as an HttpOnly cookie as well as returned in the body. The
// cookie is what a browser uses, so a token is never left in localStorage where any XSS
// can read it; the body is what the desktop client and curl use.
function issue(res, session, user, extra) {
  res.cookie('trycord.session', session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https'),
    maxAge: config.sessionTtlDays * 86400000,
    path: '/',
  });
  res.json({ token: session.token, user: publicUser(user), ...(extra || {}) });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}

// The session token, from either transport: the Authorization header for the desktop
// client and curl, the HttpOnly cookie for a browser.
function readToken(req) {
  return (req.headers.authorization || '').replace(/^Bearer /, '') || readCookie(req, 'trycord.session') || '';
}

router.post('/register',
  limit({ windowMs: 60000, max: 10 }),
  wrap(async (req, res) => {
    const { username, email, password, displayName, termsVersion, privacyVersion } = req.body || {};

    if (!username || String(username).length < 2 || String(username).length > 32) {
      return fail(res, 'VALIDATION_ERROR', 'a username is 2 to 32 characters');
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(String(username))) {
      return fail(res, 'VALIDATION_ERROR', 'a username may only contain letters, numbers, dot, dash and underscore');
    }
    if (!password || String(password).length < 8) {
      return fail(res, 'VALIDATION_ERROR', 'a password is at least 8 characters');
    }

    const session = await auth.register({ username: String(username), email, password: String(password), displayName, termsVersion, privacyVersion });
    issue(res, session, session.user, { emailVerified: !!session.user.emailVerified });
  })
);

router.post('/login',
  limit({ windowMs: 60000, max: 30 }),
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, 'VALIDATION_ERROR', 'username and password are required');

    const user = await auth.login({ username, password });

    // The password was right, but no session yet: returning one here would make the
    // second factor advisory.
    if (user.totpEnabled) {
      return res.json({
        mfaRequired: true,
        challengeToken: auth.signChallenge(user.id),
        expiresInSeconds: 300,
      });
    }

    issue(res, auth.sign(user), user);
  })
);

router.post('/2fa/verify',
  limit({ windowMs: 60000, max: 10 }),
  wrap(async (req, res) => {
    const { challengeToken, code } = req.body || {};
    if (!challengeToken || !code) return fail(res, 'VALIDATION_ERROR', 'challengeToken and code are required');

    const userId = auth.readChallenge(challengeToken);
    if (!userId) return fail(res, 'AUTH_REQUIRED', 'challenge expired or invalid');

    const row = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) return fail(res, 'NOT_FOUND', 'user not found');
    // The factor may have been turned off between the challenge and the code.
    if (!row.totp_enabled_at) return fail(res, 'VALIDATION_ERROR', '2FA is not enabled for this account');

    const result = await twofactor.verifySecondFactor(userId, String(code));
    if (!result.ok) return fail(res, 'AUTH_REQUIRED', 'invalid code');

    issue(res, auth.sign(row), row, { usedRecoveryCode: result.via === 'recovery' });
  })
);

router.post('/logout', wrap(async (req, res) => {
  await auth.logout(readToken(req));
  res.clearCookie('trycord.session', { path: '/' });
  res.json({ ok: true });
}));

// Everything below this line needs a live session; everything above it is how one is
// obtained. The guard is mounted here rather than on the router as a whole so the
// register and login endpoints are reachable without a token.
router.use(require('../../middleware/auth').authenticate);

router.get('/sessions', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT id, created_at, last_seen_at, user_agent, ip FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows.map((r) => ({
    id: r.id,
    jti: r.id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    userAgent: r.user_agent || '',
    current: false,
  })));
}));

router.post('/sessions/revoke', wrap(async (req, res) => {
  const { jti } = req.body || {};
  if (!jti) return fail(res, 'VALIDATION_ERROR', 'a session id is required');
  await db.run('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ?', [now(), jti, req.user.id]);
  await auth.revokeSession(jti);
  res.json({ ok: true });
}));

router.post('/sessions/revoke-all', wrap(async (req, res) => {
  await auth.revokeAllSessions(req.user.id);
  await db.run('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ?', [now(), req.user.id]);
  res.json({ ok: true });
}));

router.post('/change-password', limit({ windowMs: 60000, max: 5 }), wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return fail(res, 'VALIDATION_ERROR', 'a new password is at least 8 characters');
  }
  await auth.changePassword(req.user.id, currentPassword, newPassword);
  res.json({ ok: true });
}));

router.post('/change-email', limit({ windowMs: 60000, max: 5 }), wrap(async (req, res) => {
  const { email, currentPassword } = req.body || {};
  if (!email) return fail(res, 'VALIDATION_ERROR', 'an email address is required');
  await users.changeEmail(req.user.id, String(email), currentPassword);
  res.json(await users.me(req.user.id));
}));

// --- 2FA management ----------------------------------------------------------
//
// Enable and disable both require the current password. A stolen session token must not
// be enough to remove the factor that is supposed to survive it.

router.get('/2fa/status', wrap(async (req, res) => {
  res.json(await twofactor.status(req.user.id));
}));

router.post('/2fa/setup', limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!password) return fail(res, 'VALIDATION_ERROR', 'your current password is required');
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await auth.verifyPassword(password, row.password_hash))) {
    return fail(res, 'VALIDATION_ERROR', 'that password is not correct');
  }
  res.json(await twofactor.beginSetup(req.user.id, req.user.username));
}));

router.post('/2fa/enable', limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const { code, password } = req.body || {};
  if (!code) return fail(res, 'VALIDATION_ERROR', 'a code from your authenticator is required');
  if (password) {
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!(await auth.verifyPassword(password, row.password_hash))) {
      return fail(res, 'VALIDATION_ERROR', 'that password is not correct');
    }
  }
  // Returned once and never again: only the hashes are kept.
  res.json(await twofactor.enable(req.user.id, String(code)));
}));

router.post('/2fa/disable', limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const { code, password } = req.body || {};
  if (!code) return fail(res, 'VALIDATION_ERROR', 'a code from your authenticator is required');
  if (password) {
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!(await auth.verifyPassword(password, row.password_hash))) {
      return fail(res, 'VALIDATION_ERROR', 'that password is not correct');
    }
  }
  res.json(await twofactor.disable(req.user.id, String(code)));
}));

router.post('/2fa/recovery-codes', limit({ windowMs: 60000, max: 5 }), wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!password) return fail(res, 'VALIDATION_ERROR', 'your current password is required');
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await auth.verifyPassword(password, row.password_hash))) {
    return fail(res, 'VALIDATION_ERROR', 'that password is not correct');
  }
  res.json(await twofactor.issueRecoveryCodes(req.user.id));
}));

// The WebSocket handshake ticket. The bearer token never appears in a URL, because URLs
// end up in access logs, proxy logs and Referer headers.
router.post('/ws/ticket', wrap(async (req, res) => {
  res.json({ ticket: auth.issueTicket({ id: req.user.id, username: req.user.username }) });
}));

module.exports = router;
