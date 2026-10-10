// Trust and safety: reports from readers, and appeals against moderation decisions.
//
// A report is filed against a target rather than against a message, because the same
// report form covers users, communities and individual content - and the target type is
// what tells a reviewer which of those it is.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const reports = require('../../services/reports');

const TARGETS = ['user', 'message', 'community', 'channel'];

const router = express.Router();
router.use(authenticate);

router.post('/', requireVerified, limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const { targetType, targetId, reason, description } = req.body || {};
  if (TARGETS.indexOf(targetType) === -1) {
    return fail(res, 'VALIDATION_ERROR', 'a report needs a target type');
  }
  if (!targetId) return fail(res, 'VALIDATION_ERROR', 'a report needs a target id');
  if (!reason || !String(reason).trim()) {
    return fail(res, 'VALIDATION_ERROR', 'a report needs a reason');
  }

  // A duplicate report from the same reader about the same target is refused rather than
  // creating a second review of one problem.
  const existing = await reports.sameOpen(req.user.id, targetType, targetId);
  if (existing) return fail(res, 'ALREADY_EXISTS', 'you have already reported this');

  res.status(201).json(await reports.file({
    reporterId: req.user.id,
    targetType, targetId,
    reason: String(reason).slice(0, 255),
    description: description ? String(description).slice(0, 4000) : null,
  }));
}));

module.exports = router;
