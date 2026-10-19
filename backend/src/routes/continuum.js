// Community Continuum routes.
//
// Public discovery (no auth): what this instance is and what it can do.
// Admin inbox/instance management (auth + adminGuard): the operator's view of
// remote relationships and delivery failures.
// Member routes (auth): the remote communities this instance knows about, and
// joining and leaving one.
//
// All routes are gated behind the continuum.enabled feature flag: when
// federation is off, these routes answer 404 and nothing is sent or received.

const express = require('express');
const adminGuard = require('../middleware/adminGuard');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const continuum = require('../services/continuum');

const router = express.Router();

// ---- public discovery ------------------------------------------------------

// Well-known discovery document. Any instance can fetch this to learn this
// instance's id, public key and capabilities before deciding to federate.
//
// It also lists the communities this instance federates - the public ones,
// and only the channels the members may post in. A private community is not
// in it, and neither is a channel the members cannot post in.
router.get('/.well-known/trycord', async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.discovery());
  } catch (e) { serviceError(res, e); }
});

// ---- inbound ---------------------------------------------------------------

// Receive an event from a remote instance. The signature is verified against
// the sending instance's recorded public key; replays are rejected by event
// id.
//
// An event that has been seen before is accepted rather than refused: it has
// been accepted already, and refusing it would make the sender retry a
// delivery that has in fact succeeded.
router.post('/api/continuum/inbox', rateLimit({ windowMs: 60000, max: 120 }), async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    const result = await continuum.receiveEvent(req.body);
    if (!result || !result.accepted) {
      return fail(res, 'REJECTED', (result && result.reason) || 'event not accepted', 400);
    }
    res.status(202).json({ ok: true, id: result.id, duplicate: !!result.duplicate });
  } catch (e) { serviceError(res, e); }
});

// ---- administration (adminGuard) -------------------------------------------

router.get('/api/continuum/instances', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    await continuum.runFeedSoon();
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

// Remove a peer. Its events are refused from then on: an instance that is no
// longer known is not one whose signatures mean anything here.
router.delete('/api/continuum/instances/:id', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.removeInstance(req.params.id));
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

// Ask a peer for the communities it federates and record them. The peer is
// asked through the same guard the delivery path uses, so an address nobody
// may reach is not reached here either.
router.post('/api/continuum/instances/:id/sync', adminGuard, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.syncPeerCommunities(req.params.id));
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

// One event in full, for an operator who wants to see what was sent.
router.get('/api/continuum/events/:id', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    const event = await continuum.getEvent(req.params.id);
    if (!event) return fail(res, 'NOT_FOUND', 'no such event', 404);
    res.json(event);
  } catch (e) { serviceError(res, e); }
});

// The delivery status per event and per destination: what reached which
// instance, what is still being retried, and what failed and why.
router.get('/api/continuum/deliveries', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listDeliveries({ eventId: req.query.event_id, limit: req.query.limit }));
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
// behalf. The browser cannot fetch it cross-origin unless the remote happens
// to allow this origin, and an operator pasting an origin deserves an answer, not
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
        headers: { accept: 'application/json' },
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

// ---- remote communities ----------------------------------------------------

// The remote communities this instance knows about, with the local
// relationship to each of them.
router.get('/api/continuum/communities', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listRemoteCommunities());
  } catch (e) { serviceError(res, e); }
});

// The relayed messages of one remote community. They are presented as
// relayed: the origin's timestamp, the origin's author, and the ids they
// have on the instance they came from.
router.get('/api/continuum/communities/:instanceId/:communityId/messages', auth, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listRelayedMessages(req.params.instanceId, req.params.communityId, req.query.limit));
  } catch (e) { serviceError(res, e); }
});

// Join a community that lives on another instance.
//
// Joining is a local record and one relayed event. It grants no role, no
// permission and no moderation power over that community: the instance that
// owns the community decides what a member of it may do, and enforces it
// there.
router.post('/api/continuum/communities/:instanceId/:communityId/join', auth, rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.joinRemoteCommunity(req.user, req.params.instanceId, req.params.communityId));
  } catch (e) { serviceError(res, e); }
});

// Leave a community that lives on another instance.
router.post('/api/continuum/communities/:instanceId/:communityId/leave', auth, rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.leaveRemoteCommunity(req.user, req.params.instanceId, req.params.communityId));
  } catch (e) { serviceError(res, e); }
});

// The communities a local account follows.
router.get('/api/continuum/memberships', auth, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listUserMemberships(req.user.id));
  } catch (e) { serviceError(res, e); }
});

// ---- the relay store -------------------------------------------------------

// Everything that arrived from another instance: the relayed messages and the
// members of this instance's communities who live elsewhere.
router.get('/api/continuum/relay/messages', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listAllRelayedMessages(req.query.limit));
  } catch (e) { serviceError(res, e); }
});

router.get('/api/continuum/relay/memberships', adminGuard, async (req, res, next) => {
  try {
    if (!continuum.enabled()) return res.status(404).json({ error: { code: 'DISABLED', message: 'Continuum is not enabled on this instance' } });
    res.json(await continuum.listRelayMemberships({
      originCommunityId: req.query.community_id,
      originInstanceId: req.query.instance_id,
    }));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
