// /api/friends — requests with pending/accepted/declined states and the
// friendship list. Every mutation is server-validated; the recipient alone
// accepts/declines, the sender alone cancels.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const friends = require('../services/friends');
const events = require('../services/events');
const privacy = require('../services/privacy');
const notifications = require('../services/notifications');

let gateway = { sendToUser: () => {}, getPresence: null };
function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

const router = express.Router();
router.use(auth);
router.use(rateLimit({ windowMs: 60000, max: 120 }));

function withPresence(list) {
  try {
    const presence = gateway.getPresence
      ? gateway.getPresence(list.map((f) => f.id))
      : {};
    list.forEach((f) => { f.presence = presence[f.id] || 'offline'; });
  } catch { /* best-effort */ }
  return list;
}

async function notify(userId, type, actorId, referenceId) {
  try {
    const note = await notifications.create(userId, type, actorId, referenceId);
    gateway.sendToUser(userId, { type: 'notification', notification: note });
  } catch { /* notifications never fail the request */ }
}

// GET /api/friends — my friendships with presence.
router.get('/', async (req, res, next) => {
  try {
    res.json(withPresence(await friends.list(req.user.id)));
  } catch (e) { next(e); }
});

// GET /api/friends/requests — { incoming, outgoing }.
router.get('/requests', async (req, res, next) => {
  try {
    const [incoming, outgoing] = await Promise.all([
      friends.incoming(req.user.id),
      friends.outgoing(req.user.id),
    ]);
    res.json({ incoming, outgoing });
  } catch (e) { next(e); }
});

// POST /api/friends/requests { userId }
router.post('/requests', auth.requireVerified, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    // The target's friend-request policy, and a block in either direction, are
    // checked here rather than inside friends.request() so the rejection reaches
    // the caller as a real 403 with its own message instead of being flattened
    // into a generic conflict.
    const gate = await privacy.canSendFriendRequest(req.user.id, String(((req.body || {}).userId) || ''));
    if (!gate.allowed) {
      const err = new Error(gate.message);
      err.code = gate.code;
      throw err;
    }
    const out = await friends.request(req.user.id, String(((req.body || {}).userId) || ''));
    if (out.autoAccepted) {
      await notify(out.accepted.friendId, 'friend_accepted', req.user.id, null);
    } else {
      await notify(out.request.to_user_id, 'friend_request', req.user.id, out.request.id);
    }
    res.json(out.autoAccepted ? { autoAccepted: true } : { id: out.request.id, status: 'pending' });
  } catch (e) { serviceError(res, e); }
});

// POST /api/friends/requests/:id/accept
router.post('/requests/:id/accept', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await friends.accept(req.user.id, req.params.id);
    await notify(out.friendId, 'friend_accepted', req.user.id, null);
    // Both sides change: the requester is now a friend, and the accepter's list
    // gained someone. Emitting only to the caller left the other client showing a
    // pending request that no longer existed.
    if (out && out.friendId) {
      events.emitTo(out.friendId, 'friend', { state: 'friend' });
      events.emitTo(req.user.id, 'friend', { state: 'friend', userId: out.friendId });
    }
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// POST /api/friends/requests/:id/decline
router.post('/requests/:id/decline', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await friends.decline(req.user.id, req.params.id);
    events.emitTo(req.user.id, 'friend', { state: 'declined', userId: out && out.userId });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/friends/requests/:id — cancel my outgoing request.
router.delete('/requests/:id', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await friends.cancel(req.user.id, req.params.id);
    events.emitTo(req.user.id, 'friend', { state: 'cancelled', userId: out && out.userId });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/friends/:userId — remove a friendship.
router.delete('/:userId', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await friends.remove(req.user.id, req.params.userId);
    const otherId = out && out.userId ? out.userId : req.params.userId;
    // Symmetric: a removed friendship is gone for both people, so both are told.
    events.emitTo(otherId, 'friend', { state: 'removed', userId: req.user.id });
    events.emitTo(req.user.id, 'friend', { state: 'removed', userId: otherId });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
