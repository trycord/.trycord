// Appeals, and the platform-admin surface over moderation.
//
// Both halves need the same service: a reader files against an action they were subject
// to, and a reviewer decides. The reviewer half is permission-gated here rather than in
// the service, so the rule is stated once where the request arrives.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const reports = require('../../services/reports');

const router = express.Router();
router.use(authenticate);

// Filing an appeal needs no special permission - it is the right of the person subject to
// the action - but it does need a live, verified session.
router.post('/', requireVerified, limit({ windowMs: 60000, max: 5 }), wrap(async (req, res) => {
  res.status(201).json(await reports.fileAppeal(req.user.id, req.body || {}));
}));

router.get('/', wrap(async (req, res) => {
  res.json(await reports.listAppeals(req.query));
}));

router.post('/:appealId/decide', requireVerified, wrap(async (req, res) => {
  if (!isAdmin(req)) return fail(res, 'PERMISSION_DENIED', 'you cannot decide appeals');
  res.json(await reports.decideAppeal(req.params.appealId, req.user.id, req.body || {}));
}));

// Platform admin is an instance-level fact, not a permission computed from a community.
function isAdmin(req) {
  return req.admin === true;
}

module.exports = router;
