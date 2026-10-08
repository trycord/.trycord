const express = require('express');

const router = express.Router();

const auth = require('../../middleware/auth');
const { fail, serviceError } = require('../../errors');
const { now, uuid, sign, signWithJti, secret } = require('../../util');
const events = require('../../services/events');
const twofactor = require('../../services/twofactor');
const { requirePassword } = require('./password');
const { invalidateSessions } = require('./sessions');

// The second factor itself - status, setup, enable, disable, recovery codes.

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
    // Two-factor off is the single most consequential thing a member can do, and
    // it was silent: another tab with the page open still showed two-factor as
    // enabled until it was refreshed. The sessions killed above are told too, so
    // a second device is sent back through sign-in rather than left holding a
    // token it can no longer use.
    events.emitTo(req.user.id, 'twofactor', { enabled: false });
    events.emitTo(req.user.id, 'session-revoked', { reason: 'twofactor-disabled', all: true });
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

module.exports = router;
