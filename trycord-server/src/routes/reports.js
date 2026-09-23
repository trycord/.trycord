// /api/reports — users file reports on content/users/servers. The reporter
// sees only their own contributions; the admin queue lives under /api/admin.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const ts = require('../services/trustsafety');

const router = express.Router();

router.post('/', auth, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    res.status(201).json(await ts.create(req.user.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

router.get('/mine', auth, rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    res.json(await ts.mine(req.user.id));
  } catch (e) { next(e); }
});

module.exports = router;