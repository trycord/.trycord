// Community Continuum routes.
//
// Public discovery (no auth): what this instance is and what it can do.
// Admin inbox/instance management (auth + adminGuard): the operator's view of
// remote relationships and delivery failures.
//
// All routes are gated behind the continuum.enabled feature flag: when
// federation is off, these routes answer 404 and nothing is sent or received.

const express = require('express');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const continuum = require('../services/continuum');

const router = express.Router();

// ---- public discovery ------------------------------------------------------

// Well-known discovery document. Any instance can fetch this to learn this
// instance's id, public key and capabilities before deciding to federate.
router.get('/.well-known/trycord', async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(continuum.discovery());
  } catch (e) { serviceError(res, e); }
});

// ---- inbound ---------------------------------------------------------------

// Receive an event from a remote instance. Signature is verified against the
// sending instance's recorded public key; replays are rejected by event id.
router.post('/api/continuum/inbox', rateLimit({ windowMs: 60000, max: 120 }), async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    const result = await continuum.receiveEvent(req.body);
    if (!result) return res.status(400).json({ error: { code: 'REJECTED', message: 'event not accepted' } });
    res.status(202).json({ ok: true, id: result.id });
  } catch (e) { serviceError(res, e); }
});

// ---- administration (adminGuard) -------------------------------------------

router.get('/api/continuum/instances', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listInstances());
  } catch (e) { serviceError(res, e); }
});

router.post('/api/continuum/instances', adminGuard, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    const { id, name, origin, public_key } = req.body || {};
    if (!id || !name || !origin || !public_key) {
      return fail(res, 'VALIDATION_ERROR', 'id, name, origin and public_key are required', 400);
    }
    res.status(201).json(await continuum.addInstance(id, name, origin, public_key));
  } catch (e) { serviceError(res, e); }
});

router.patch('/api/continuum/instances/:id/trust', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    const { trust_status } = req.body || {};
    if (!trust_status) return fail(res, 'VALIDATION_ERROR', 'trust_status is required', 400);
    res.json(await continuum.setTrust(req.params.id, trust_status));
  } catch (e) { serviceError(res, e); }
});

// The durable outbox: events this instance has tried to deliver, with what
// succeeded, what is still waiting, and what failed after every attempt.
router.get('/api/continuum/events', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listEvents(req.query.limit));
  } catch (e) { serviceError(res, e); }
});

// What came in from remote instances: kind, sender, and whether the inbound
// processor has handled it yet.
router.get('/api/continuum/inbox', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listInbox(req.query.limit));
  } catch (e) { serviceError(res, e); }
});

// Probe a prospective remote instance's discovery document on the operator's
// behalf. The browser cannot fetch it cross-origin unless the remote happens to
// allow this origin, and an operator pasting an origin deserves an answer, not
// a CORS error. The service's origin validator decides reachability of the
// destination, so the keep-out list (private ranges, localhost, link-local and
// cloud metadata names) always applies, exactly as it does when federation
// itself delivers events.
router.get('/api/continuum/probe', adminGuard, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    const raw = String(req.query.origin || '').trim();
    let safeOrigin;
    try {
      safeOrigin = await continuum.validateOrigin(raw);
    } catch (e) {
      return fail(res, 'VALIDATION_ERROR', String(e && e.message || e), 400);
    }
    let response;
    try {
      response = await fetch(`${safeOrigin}/.well-known/trycord`, {
        headers: { 'accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch (e) {
      return fail(res, 'UNREACHABLE', `the remote instance did not answer: ${String(e && e.message || e)}`, 502);
    }
    if (!response.ok) {
      return fail(res, 'UNREACHABLE', `the remote discovery document answered HTTP ${response.status} (Continuum is probably not enabled there)`, 502);
    }
    let document;
    try {
      document = await response.json();
    } catch (e) {
      return fail(res, 'UNREACHABLE', 'the remote discovery document was not JSON', 502);
    }
    res.json({ ok: true, origin: safeOrigin, discovery: document });
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
