const express = require('express');

const router = express.Router();

const auth = require('../../middleware/auth');
const { fail, serviceError } = require('../../errors');
const rateLimit = require('../../middleware/ratelimit');

// POST /forgot-password and /reset-password. The flow itself is a service.

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

module.exports = router;
