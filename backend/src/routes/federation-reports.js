// /api/federation-reports — a report about activity on another instance.
//
// Filing one needs an account. Receiving one does not: the signature is the
// credential, and the receiving instance checks it against the key it
// recorded for the sender.
//
// What a report carries is a reference, never a copy of the content, and the
// reporter is told what was shared and what was not before they file it.
const express = require('express');
const auth = require('../middleware/auth');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const reports = require('../services/cross-instance-reports');

const router = express.Router();

// File a report about something on another instance.
router.post('/', auth, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    res.status(201).json(await reports.create(Object.assign({}, req.body || {}, {
      reporterId: req.user.id,
    })));
  } catch (e) { serviceError(res, e); }
});

// What a report carries, and what it does not.
//
// The reporter is asked before they file, not after. Without this the only
// answer is the one that arrives with a report somebody has already filed,
// which is no answer at the moment the decision is made.
router.get('/disclosure', auth, rateLimit(30), async (req, res, next) => {
  try {
    res.json(reports.disclosure());
  } catch (e) { serviceError(res, e); }
});

// The reports this reader filed, and what was shared with each of them.
router.get('/mine', auth, rateLimit(30), async (req, res, next) => {
  try {
    const rows = await reports.listOutbound(req.user.id);
    res.json(rows.map((row) => Object.assign({}, row, { disclosure: reports.disclosure() })));
  } catch (e) { serviceError(res, e); }
});

// One report of this reader's own.
//
// The report is the reporter's: an id that names somebody else's report is
// not found, so the answer does not say that the id exists. The direction
// check is in the service, next to the reporter filter.
router.get('/mine/:id', auth, rateLimit(30), async (req, res, next) => {
  try {
    const report = await reports.get(req.params.id, { reporterId: req.user.id });
    res.json(report);
  } catch (e) { serviceError(res, e); }
});

// The reports that arrived here.
router.get('/', adminGuard, rateLimit(30), async (req, res, next) => {
  try {
    res.json(await reports.listInbound({ limit: req.query.limit }));
  } catch (e) { serviceError(res, e); }
});

// A report from another instance.
//
// The signature is checked against the key recorded for the sending
// instance, and the report is stored as a reference.
router.post('/inbound', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const outcome = await reports.receive(req.body || {});
    if (!outcome.accepted) {
      return res.status(403).json({ error: { code: 'PERMISSION_DENIED', message: outcome.reason } });
    }
    res.json({ accepted: true, receipt: outcome.id, duplicate: !!outcome.duplicate, actionable: !!outcome.actionable });
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
