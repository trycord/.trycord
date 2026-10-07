const express = require('express');

const router = express.Router();

const auth = require('../../middleware/auth');
const { fail, serviceError } = require('../../errors');
const rateLimit = require('../../middleware/ratelimit');

// Verifying an address, resending the link, and changing it.

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

module.exports = router;
