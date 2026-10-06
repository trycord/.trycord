// /api/dms — one-to-one direct conversations over the same patterns as
// channel chat: auth, membership checks, server timestamps, author from the
// session (never from the client), cursor history, hard author-only delete.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const dms = require('../services/dms');
const threads = require('../services/threads');
const replies = require('../services/replies');
const privacy = require('../services/privacy');
const notifications = require('../services/notifications');
const embeds = require('../services/embeds');

// A message body is capped rather than truncated. Slicing to the limit loses
// whatever the writer typed past it with no indication at all, so a long paste
// comes back looking like a successful send of something they did not write.
const MAX_CONTENT = 2000;
function readContent(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text.length > MAX_CONTENT) {
    const e = new Error('message must be ' + MAX_CONTENT + ' characters or fewer');
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
  return text;
}

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
//
// Three gates before the conversation is created, in the order that tells a
// stranger least: the peer has to exist, neither party may have blocked the
// other, and the peer's DM preference has to permit this sender. Without them
// the privacy settings would be a display preference on a control that nothing
// enforced.
router.post('/', auth.requireVerified, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const peerId = String(((req.body || {}).userId) || '');
    const gate = await privacy.canOpenDm(req.user.id, peerId);
    if (!gate.allowed) {
      const err = new Error(gate.message);
      err.code = gate.code;
      throw err;
    }
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

// GET /api/dms/:id/messages?before=|after=&limit= — older pages, or forward
// catch-up after a reconnect. `after` takes the highest seq the client holds;
// `before` accepts a seq or a legacy message id.
router.get('/:id/messages', async (req, res, next) => {
  try {
    res.json(await dms.history(req.user.id, req.params.id, {
      before: req.query.before || null,
      after: req.query.after || null,
      limit: req.query.limit,
    }));
  } catch (e) { serviceError(res, e); }
});

// A thread, on the same terms as the channel one: membership is the check, so
// this cannot be used to read a conversation the caller is not in.
router.get('/:id/messages/:messageId/thread', async (req, res, next) => {
  try {
    const seen = await dms.visibleConversation(req.params.id, req.user.id);
    if (!seen) return fail(res, 'NOT_FOUND', 'conversation not found');
    const rootId = await threads.resolveRoot('dm', req.params.id, req.params.messageId);
    res.json(await threads.fetch('dm', req.params.id, rootId));
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return fail(res, 'NOT_FOUND', 'message not found');
    serviceError(res, e);
  }
});

// POST /api/dms/:id/messages { content, attachmentIds, clientNonce, replyToId } — persist,
// broadcast, notify. The nonce makes a retried submission collapse onto the row
// the first attempt already wrote, so a lost response cannot duplicate a
// message. A message with files and no text is allowed, as it is in a channel.
router.post('/:id/messages', auth.requireVerified, rateLimit({ windowMs: 60000, max: 40 }), async (req, res, next) => {
  try {
    const msg = await dms.send(
      req.user.id, req.user.username, req.params.id,
      readContent((req.body || {}).content), (req.body || {}).clientNonce,
      (req.body || {}).attachmentIds, (req.body || {}).replyToId
    );
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, { type: 'dm:message', ...msg, conversationId: req.params.id });

    // Opt-out from link previews for this one message, read server-side for the
    // same reason as the channel path: a flag the server ignores is a control
    // that only looks like it works.
    const suppressEmbeds = (req.body || {}).suppressEmbeds === true;

    // A link in a direct message gets the same preview a channel link does,
    // resolved after the broadcast so the message is not held on a slow link.
    // The stored text is used rather than the request body, so what is previewed
    // is what was actually written.
    const text = String((msg && msg.content) || '');
    if (!suppressEmbeds && /https?:\/\//i.test(text)) {
      embeds.queue({ kind: 'dm', messageId: msg.id, conversationId: req.params.id }, text).then((cards) => {
        if (!cards.length) return;
        gateway.broadcastDm(members, {
          type: 'dm:message_embeds', conversationId: req.params.id,
          messageId: msg.id, embeds: cards,
        });
      }).catch(() => {});
    }
    // Notify members who aren't connected right now (persisted; delivered
    // on reconnect). Online members already got the realtime event.
    // A deduped retry must not produce a second notification.
    if (!msg.deduped) {
      for (const id of members) {
        if (String(id) === String(req.user.id)) continue;
        try {
          if (gateway.isOnline && gateway.isOnline(id)) continue;
          const { notification, held } = await notifications.create(id, 'dm', req.user.id, req.params.id);
          if (!held) gateway.sendToUser(id, { type: 'notification', notification });
        } catch { /* notification failure must not fail the send */ }
      }
    }
    // A reply additionally tells the author of the message it hangs from, even
    // if they are connected - the "they are online" shortcut above exists
    // because the message itself reaches them over the socket, and a reply does
    // not otherwise interrupt what they are reading.
    if (!msg.deduped && msg.threadRootId) {
      try {
        const r = await replies.notifyReply({
          kind: 'dm', scopeId: req.params.id, rootId: msg.threadRootId,
          replyId: msg.id, authorId: req.user.id,
        });
        if (r && !r.held) gateway.sendToUser(r.userId, { type: 'notification', notification: r.notification });
      } catch { /* ignore */ }
    }
    res.json(msg);
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/dms/:id/messages/:messageId — author only, hard delete.
router.delete('/:id/messages/:messageId', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await dms.remove(req.user.id, req.params.id, req.params.messageId);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, { type: 'dm:message_deleted', id: out.id, conversationId: out.conversationId });
    res.json({ ok: true });
  } catch (e) { serviceError(res, e); }
});

// PATCH /api/dms/:id/messages/:messageId — author-only edit.
router.patch('/:id/messages/:messageId', auth.requireVerified, rateLimit({ windowMs: 60000, max: 40 }), async (req, res, next) => {
  try {
    const out = await dms.edit(req.user.id, req.params.id, req.params.messageId, readContent((req.body || {}).content), req.user.username);
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
