const express = require('express');

const router = express.Router();
const sessions = require('../../services/sessions');
const { disconnectUser } = require('../../auth/gateway');

const db = require('../../db');
const auth = require('../../middleware/auth');
const { fail, serviceError } = require('../../errors');
const { now, uuid, sign, signWithJti, secret } = require('../../util');
const rateLimit = require('../../middleware/ratelimit');
const events = require('../../services/events');
const { issued } = require('./issued');

// Listing and revoking sessions.
// 
// Revoking here cuts the sockets as well as the tokens, so a revoked session
// cannot stay connected just because its token check happens on the next request.

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
async function invalidateSessions(userId) {
  await db.run(
    'UPDATE users SET session_version = session_version + 1, sessions_invalidated_at = ? WHERE id = ?',
    [now(), userId]
  );
  const row = await db.get('SELECT session_version FROM users WHERE id = ?', [userId]);
  return row ? Number(row.session_version || 0) : 0;
}

// Revoke the current token so it cannot be used again.

// Sign out everywhere: invalidates every session including the caller's.
// The client drops its token and returns to login.
router.post('/sessions/revoke-all', auth, async (req, res, next) => {
  try {
    await invalidateSessions(req.user.id);
    // The named rows go too. The version bump is what actually kills the
    // tokens; leaving the rows would mean the Security page lists devices that
    // no longer work, which is worse than not listing them at all.
    await db.run('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [now(), req.user.id]);
    console.log(`[security] all_sessions_revoked user=${req.user.id}`);
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

// Sign out all other sessions: same invalidation, plus a fresh token so
// only the caller's session survives.
router.post('/sessions/revoke-others', auth, async (req, res, next) => {
  try {
    // The new token must carry the bumped version. Signing before reading it
    // back, or signing a row that does not include the column, hands back a
    // token the middleware rejects on its very next request - the member is
    // signed out of the session they are standing in, with no error.
    const version = await invalidateSessions(req.user.id);
    const row = await db.get(
      'SELECT id, username, display_name, created_at, session_version FROM users WHERE id = ?',
      [req.user.id]
    );
    // Every named row goes, including the caller's. The version bump above has
    // already killed the caller's token too - that is why this endpoint returns
    // a fresh one - so keeping its row would leave the list showing a device
    // that no longer holds a usable token. issued() below registers the
    // replacement, so the reader's own device is the row that survives.
    await sessions.revokeOthers(req.user.id, null);
    console.log(`[security] other_sessions_revoked user=${req.user.id}`);
    // Before the sockets go, for the same reason as revoke-all above. This one
    // also names who asked, because the version bump killed the caller's own
    // token too - a fresh one is returned below - so a client that treated it
    // as a revocation of itself would sign the reader out for doing what they
    // asked.
    events.emitTo(req.user.id, 'session-revoked', {
      all: false, reason: 'revoke-others', actorJti: req.user.jti || null,
    });
    try { disconnectUser(req.user.id); } catch { /* gateway not wired */ }
    issued(res, {
      id: row.id, username: row.username, display_name: row.display_name,
      created_at: row.created_at, session_version: version,
    }, req);
  } catch (e) { next(e); }
});

// GET /api/auth/sessions — the caller's live sessions. Backs the Security page.
// Named from the user agent so a reader can tell which row to revoke; the jti
// is included because that is the only handle a revoke can use, and it belongs
// to the caller's own token.
router.get('/sessions', auth, async (req, res, next) => {
  try {
    res.json({ sessions: await sessions.listSessions(req.user.id, req.user.jti || null) });
  } catch (e) { next(e); }
});

// POST /api/auth/sessions/revoke { jti } — kill one session.
//
// Per-session rather than a version bump, so the caller's own session survives
// and they are not signed out of the tab they are using. The jti also goes into
// revoked_tokens, which is what the auth middleware checks, so the revocation
// takes effect immediately rather than waiting for the token to expire.
router.post('/sessions/revoke', auth, rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const jti = String(((req.body || {}).jti) || '');
    if (!jti) return fail(res, 'VALIDATION_ERROR', '`jti` is required');
    if (jti === req.user.jti) {
      return fail(res, 'VALIDATION_ERROR', 'use sign out to end the session you are currently using');
    }
    const revoked = await sessions.revokeSession(req.user.id, jti);
    // Every socket, including the one that asked: a revoked session that stays
    // connected is a session the server has already refused but the client has
    // not noticed, which is the worst of both.
    events.emitTo(req.user.id, 'session-revoked', {
      jti, all: false, actorJti: req.user.jti || null,
    });
    if (!revoked) return fail(res, 'NOT_FOUND', 'session not found or already revoked');
    const exp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    try {
      await db.upsert(
        'revoked_tokens',
        ['jti', 'expires_at'],
        [jti, exp],
        ['jti'],
        {
          expires_at: db.dialect === 'mysql' ? 'VALUES(expires_at)' : 'excluded.expires_at',
        }
      );
    } catch { /* already revoked */ }
    res.json({ ok: true, jti });
  } catch (e) { next(e); }
});

// Forgot password: ALWAYS generic, so nobody can probe for accounts.

module.exports = router;
// Changing the password or the second factor has to end every session the account has,
// and both of those live in other files. This one was defined here, called there, and
// exported by nobody - so a password change reached `await invalidateSessions(...)` and
// threw, answering 500 after the new password had already been written.
module.exports.invalidateSessions = invalidateSessions;
