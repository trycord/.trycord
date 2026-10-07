const express = require('express');

const router = express.Router();
const bcrypt = require('bcrypt');

const db = require('../../db');
const auth = require('../../middleware/auth');
const { fail, serviceError } = require('../../errors');
const rateLimit = require('../../middleware/ratelimit');
const enforcement = require('../../services/enforcement');
const twofactor = require('../../services/twofactor');
const { issued } = require('./issued');
const { signChallenge, readChallenge } = require('./challenge');

// POST /login and POST /2fa/verify.
// 
// Together because the second is the second half of the first: a correct password
// with a second factor outstanding produces a challenge, and only a challenge plus a
// valid code produces a session.

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

    issued(res, user, req);
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

    issued(res, user, req, { usedRecoveryCode: result.via === 'recovery' });
  } catch (e) { next(e); }
});

// ---- 2FA management ------------------------------------------------------
//
// All of these require a recent session (the normal auth middleware) and, for
// enable and disable, the current password. A stolen session token must not be
// enough to remove the factor that is supposed to survive it.

module.exports = router;
