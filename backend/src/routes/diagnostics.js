// The diagnostics the operator asks for.
//
// Every subsystem is asked in its own terms whether it is healthy, and the
// answer is what it says. A subsystem that is configured but cannot prove
// itself says so; a subsystem that is switched off says that too. Nothing here
// reports a green tick because a setting was present.
//
// Administrative only, and audited: reading the diagnostics of an instance is
// an operator's business.

const express = require('express');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const diagnostics = require('../services/diagnostics');
const { wrap } = require('../errors');
const db = require('../db');
const { uuid, now } = require('../util');

const router = express.Router();
router.use(adminGuard);
router.use(rateLimit({ windowMs: 60000, max: 60 }));

router.get('/', wrap(async (req, res) => {
  const report = await diagnostics.report();
  // Reading the diagnostics is an operator action, and it is written down.
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, 'read_diagnostics', 'instance', NULL, ?, ?)`,
    [uuid(), req.user.id, JSON.stringify({ overall: report.overall }), now()]
  ).catch(() => { /* the audit trail must never block the reading */ });
  res.json(report);
}));

module.exports = router;
