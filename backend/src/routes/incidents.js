// /api/incidents — the operational incident timeline.
//
// The reading is public: a status page is for the people who are affected by
// something, and they should not have to sign in to read it.
//
// The writing is not: an incident is something an operator posts, so posting
// one needs the platform administration gate.
//
// What the public answer contains is exactly what an operator wrote. An
// instance with nothing recorded says it has nothing recorded.
const express = require('express');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const settings = require('../services/settings');
const incidents = require('../services/incidents');

const router = express.Router();

// The timeline.
router.get('/', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    if (!settings.read('incidents.statusPageEnabled', true)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'the status page is not published' } });
    }
    res.json(await incidents.list({ limit: req.query.limit, kind: req.query.kind }));
  } catch (e) { next(e); }
});

// The status page's own answer.
router.get('/status', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    if (!settings.read('incidents.statusPageEnabled', true)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'the status page is not published' } });
    }
    res.json(await incidents.status({ limit: req.query.limit }));
  } catch (e) { next(e); }
});

// One incident, and what was written in it.
router.get('/:id', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await incidents.get(req.params.id));
  } catch (e) { serviceError(res, e); }
});

// Post an incident.
router.post('/', adminGuard, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    res.status(201).json(await incidents.create(Object.assign({}, req.body || {}, {
      actorId: req.user.id,
    })));
  } catch (e) { serviceError(res, e); }
});

// Move an incident on: it is being looked at, the cause is known, it is
// being watched, or it is over.
router.patch('/:id', adminGuard, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    res.json(await incidents.update(req.params.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
