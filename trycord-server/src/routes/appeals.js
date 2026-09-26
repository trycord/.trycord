// /api/appeals — anonymous submission gated on knowledge of the moderation
// action id handed back at a correct-password login attempt (or present in
// the enforcement payload). No listing, no lookup — the possession check
// doubles as the account-enumeration guard, and the rate limit keeps
// brute-force probing of ids slow. Genuine holders can re-appeal after a
// denial, so the limit is per-IP headroom rather than a single attempt.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const ts = require('../services/trustsafety');

const router = express.Router();

// Own appeals for signed-in users. Scoped by auth identity — the anonymous
// POST below stays anonymous; this never lists anyone else's appeals.
router.get('/mine', auth, async (req, res, next) => {
  try {
    res.json(await ts.listMine(req.user.id));
  } catch (e) { serviceError(res, e); }
});

router.post('/', rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    res.status(201).json(await ts.submitAppeal(req.body || {}));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;