// /api/dms — one-to-one direct conversations over the same patterns as
// channel chat: auth, membership checks, server timestamps, author from the
// session (never from the client), cursor history, hard author-only delete.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const dms = require('../services/dms');
const notifications = require('../services/notifications');

let gateway = { broadcastDm: () => {}, sendToUser: () => {}, isOnline: () => false };
function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

const router = express.Router();
router.use(auth);
router.use(rateLimit({ windowMs: 60000, max: 180 }));

function withPresence(list) {
  try {
    const ids = [];
    list.forEach((c) => { if (c.peer) ids.push(c.peer.id); });
    const presence = gateway.getPresence ? gateway.getPresence(ids) : {};
    list.forEach((c) => { if (c.peer) c.peer.presence = presence[c.peer.id] || 'offline'; });
  } catch { /* presence is best-effort */ }
  return list;
}

// GET /api/dms — my conversations, most recent first.
router.get('/', async (req, res, next) => {
  try {
    res.json(withPresence(await dms.listMine(req.user.id)));
  } catch (e) { next(e); }
});

// POST /api/dms { userId } — get-or-create (idempotent, race-safe).
router.post('/', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const peerId = String(((req.body || {}).userId) || '');
    const { conversation, created } = await dms.getOrCreate({ id: req.user.id }, peerId);
    const detail = await dms.detail(req.user.id, conversation.id, { limit: 1 });
    res.json({ id: conversation.id, peer: detail.peer, created });
  } catch (e) { serviceError(res, e); }
});

// GET /api/dms/:id — full conversation payload for opening a chat.
router.get('/:id', async (req, res, next) => {
  try {
    const detail = await dms.detail(req.user.id, req.params.id, { limit: 50 });
    try {
      const presence = gateway.getPresence ? gateway.getPresence(detail.peer ? [detail.peer.id] : []) : {};
      if (detail.peer) detail.peer.presence = presence[detail.peer.id] || 'offline';
    } catch { /* best-effort */ }
    res.json(detail);
  } catch (e) { serviceError(res, e); }
});

// GET /api/dms/:id/messages?before=&limit= — older pages.
router.get('/:id/messages', async (req, res, next) => {
  try {
    res.json(await dms.history(req.user.id, req.params.id, {
      before: req.query.before || null,
      limit: req.query.limit,
    }));
  } catch (e) { serviceError(res, e); }
});

// POST /api/dms/:id/messages { content } — persist, broadcast, notify.
router.post('/:id/messages', rateLimit({ windowMs: 60000, max: 40 }), async (req, res, next) => {
  try {
    const msg = await dms.send(req.user.id, req.user.username, req.params.id, (req.body || {}).content);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, { type: 'dm:message', ...msg, conversationId: req.params.id });
    // Notify members who aren't connected right now (persisted; delivered
    // on reconnect). Online members already got the realtime event.
    for (const id of members) {
      if (String(id) === String(req.user.id)) continue;
      try {
        if (gateway.isOnline && gateway.isOnline(id)) continue;
        const note = await notifications.create(id, 'dm', req.user.id, req.params.id);
        gateway.sendToUser(id, { type: 'notification', notification: note });
      } catch { /* notification failure must not fail the send */ }
    }
    res.json(msg);
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/dms/:id/messages/:messageId — author only, hard delete.
router.delete('/:id/messages/:messageId', async (req, res, next) => {
  try {
    const out = await dms.remove(req.user.id, req.params.id, req.params.messageId);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, { type: 'dm:message_deleted', id: out.id, conversationId: out.conversationId });
    res.json({ ok: true });
  } catch (e) { serviceError(res, e); }
});

// PATCH /api/dms/:id/messages/:messageId — author-only edit.
router.patch('/:id/messages/:messageId', rateLimit({ windowMs: 60000, max: 40 }), async (req, res, next) => {
  try {
    const out = await dms.edit(req.user.id, req.params.id, req.params.messageId, (req.body || {}).content, req.user.username);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, { type: 'dm:message_updated', ...out, conversationId: out.conversationId });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// POST /api/dms/:id/read — viewing drives read state, never list loads.
router.post('/:id/read', async (req, res, next) => {
  try {
    const out = await dms.markRead(req.user.id, req.params.id);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(
      members.filter((id) => String(id) !== String(req.user.id)),
      { type: 'dm:read', conversationId: out.conversationId, userId: req.user.id, lastReadAt: out.lastReadAt }
    );
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
