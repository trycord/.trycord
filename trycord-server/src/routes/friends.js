// /api/friends — requests with pending/accepted/declined states and the
// friendship list. Every mutation is server-validated; the recipient alone
// accepts/declines, the sender alone cancels.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const friends = require('../services/friends');
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
router.post('/requests', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
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
router.post('/requests/:id/accept', async (req, res, next) => {
  try {
    const out = await friends.accept(req.user.id, req.params.id);
    await notify(out.friendId, 'friend_accepted', req.user.id, null);
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// POST /api/friends/requests/:id/decline
router.post('/requests/:id/decline', async (req, res, next) => {
  try {
    res.json(await friends.decline(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/friends/requests/:id — cancel my outgoing request.
router.delete('/requests/:id', async (req, res, next) => {
  try {
    res.json(await friends.cancel(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/friends/:userId — remove a friendship.
router.delete('/:userId', async (req, res, next) => {
  try {
    res.json(await friends.remove(req.user.id, req.params.userId));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
