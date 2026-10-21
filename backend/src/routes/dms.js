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
const e2ee = require('../services/e2ee');
const { EVENTS } = require('../ws/events.js');

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

// A conversation with more than two people in it.
//
// The people have to be able to open a conversation with the person who
// creates it: the same gate a one-to-one conversation goes through, so a
// group cannot be used to reach somebody who has said no.
//
// The group route has a budget of its own: it is rare, and it is not the
// same cost as writing a message, and the other routes in this router would
// otherwise spend it.
router.post('/groups', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 10, key: 'dm-groups' }), async (req, res, next) => {
  try {
    const group = await dms.createGroup({ id: req.user.id }, req.body || {});
    res.status(201).json(group);
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
    const thread = await threads.fetch('dm', req.params.id, rootId);
    // The thread carries the same rows the history does, so the same rule
    // applies: an envelope row says it is one.
    e2ee.shapeMessage(thread.root);
    for (const reply of thread.replies) e2ee.shapeMessage(reply);
    res.json(thread);
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return fail(res, 'NOT_FOUND', 'message not found');
    serviceError(res, e);
  }
});

// POST /api/dms/:id/messages { content, attachmentIds, clientNonce, replyToId, envelopes } — persist,
// broadcast, notify. The nonce makes a retried submission collapse onto the row
// the first attempt already wrote, so a lost response cannot duplicate a
// message. A message with files and no text is allowed, as it is in a channel.
//
// A conversation that is encrypted takes an envelope instead of text: the
// server stores what the client encrypted and never holds a key that opens
// it. Whether the conversation is encrypted is the status service's answer,
// not the client's.
router.post('/:id/messages', auth.requireVerified, rateLimit({ windowMs: 60000, max: 40 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const carriesEnvelopes = body.envelopes !== undefined && body.envelopes !== null;
    const content = carriesEnvelopes ? '' : readContent(body.content);
    const msg = await dms.send(
      req.user.id, req.user.username, req.params.id,
      {
        content,
        envelopes: body.envelopes,
        clientNonce: body.clientNonce,
        attachmentIds: body.attachmentIds,
        replyToId: body.replyToId,
      }
    );
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, { type: EVENTS.DM_MESSAGE, ...msg, conversationId: req.params.id });

    // Opt-out from link previews for this one message, read server-side for the
    // same reason as the channel path: a flag the server ignores is a control
    // that only looks like it works.
    const suppressEmbeds = body.suppressEmbeds === true;

    // A link in a direct message gets the same preview a channel link does,
    // resolved after the broadcast so the message is not held on a slow link.
    // The stored text is used rather than the request body, so what is previewed
    // is what was actually written. An encrypted message has no text, and so
    // has no preview: the server cannot read its own message.
    const text = String((msg && msg.content) || '');
    if (!suppressEmbeds && /https?:\/\//i.test(text)) {
      embeds.queue({ kind: 'dm', messageId: msg.id, conversationId: req.params.id }, text).then((cards) => {
        if (!cards.length) return;
        gateway.broadcastDm(members, {
          type: EVENTS.DM_MESSAGE_EMBEDS, conversationId: req.params.id,
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
          if (!held) gateway.sendToUser(id, { type: EVENTS.NOTIFICATION, notification });
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
        if (r && !r.held) gateway.sendToUser(r.userId, { type: EVENTS.NOTIFICATION, notification: r.notification });
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
    gateway.broadcastDm(members, { type: EVENTS.DM_MESSAGE_DELETED, id: out.id, conversationId: out.conversationId });
    res.json({ ok: true });
  } catch (e) { serviceError(res, e); }
});

// PATCH /api/dms/:id/messages/:messageId — author-only edit.
//
// An edit of an encrypted message is an envelope, exactly as a new message in
// an encrypted conversation is: editing one with text would put the text in
// the row.
router.patch('/:id/messages/:messageId', auth.requireVerified, rateLimit({ windowMs: 60000, max: 40 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const out = await dms.edit(req.user.id, req.params.id, req.params.messageId, {
      content: body.envelopes !== undefined && body.envelopes !== null ? '' : readContent(body.content),
      envelopes: body.envelopes,
    }, req.user.username);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, { type: EVENTS.DM_MESSAGE_UPDATED, ...out, conversationId: out.conversationId });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// POST /api/dms/:id/read — viewing drives read state, never list loads.
// The name of a group, and who is in it.
//
// Anybody in the conversation may do this: a name is what the people in the
// conversation call it, and it is not a setting of the instance.
router.patch('/:id', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
  try {
    res.json(await dms.renameGroup(req.params.id, req.user.id, (req.body || {}).name));
  } catch (e) { serviceError(res, e); }
});

// Somebody joins a group.
//
// The same gate a one-to-one conversation goes through: the person being
// added has to be somebody the person adding them can open a conversation
// with.
router.post('/:id/members', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
  try {
    res.json(await dms.addGroupMember(req.params.id, req.user.id, (req.body || {}).userId));
  } catch (e) { serviceError(res, e); }
});

// Somebody leaves a group.
//
// A conversation of two people cannot lose one of them: it would not be a
// conversation any more.
//
// The address is the one that leaves, and the member who is taken out has
// their own address - so the two are never confused for each other.
router.delete('/:id/members', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
  try {
    res.json(await dms.leaveGroup(req.params.id, req.user.id));
  } catch (e) { serviceError(res, e); }
});

// Somebody is taken out of a group.
//
// The member is named in the address, so leaving and removing are two
// different things and neither of them is guessed at.
router.delete('/:id/members/:userId', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
    try {
      res.json(await dms.removeGroupMember(req.params.id, req.user.id, req.params.userId));
    } catch (e) { serviceError(res, e); }
  });

router.post('/:id/read', async (req, res, next) => {
  try {
    const out = await dms.markRead(req.user.id, req.params.id);
    const members = await dms.memberIds(req.params.id);
    // Everybody in the conversation, including the reader. The reader's other
    // devices are the ones that need to know: the conversation is read for
    // the account, not for the tab that happened to open it, and a badge that
    // stays lit on the phone because the conversation was read on the laptop
    // is a badge that is lying.
    gateway.broadcastDm(
      members,
      { type: EVENTS.DM_READ, conversationId: out.conversationId, userId: req.user.id, lastReadAt: out.lastReadAt }
    );
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
