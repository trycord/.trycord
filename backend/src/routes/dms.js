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
const presenceService = require('../services/presence');
const notifications = require('../services/notifications');
const embeds = require('../services/embeds');
const e2ee = require('../services/e2ee');
const uploads = require('../services/uploads');
const { singleImage } = require('../middleware/upload');
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

// Presence on the peer of a one-to-one conversation, and on the faces in a
// group. The rule is the same one the friends list uses: a hidden presence is
// null, not 'offline'. A group's members come from the detail payload, so the
// caller passes the people whose state it wants.
async function withPresence(list, viewerId) {
  const peers = [];
  for (const c of list) {
    if (c.peer) peers.push(c.peer.id);
    for (const p of c.people || c.members || []) if (p && p.id) peers.push(p.id);
  }
  const states = await presenceService.forGateway(peers, gateway);
  for (const c of list) {
    if (c.peer) {
      const visible = await privacy.canSeePresence(viewerId, c.peer.id);
      c.peer.presence = visible ? states[String(c.peer.id)] || 'offline' : null;
    }
    for (const p of (c.people || c.members || [])) {
      if (!p || !p.id) continue;
      const visible = await privacy.canSeePresence(viewerId, p.id);
      p.presence = visible ? states[String(p.id)] || 'offline' : null;
    }
  }
  return list;
}

// GET /api/dms — my conversations, most recent first.
router.get('/', async (req, res, next) => {
  try {
    res.json(await withPresence(await dms.listMine(req.user.id), req.user.id));
  } catch (e) { next(e); }
});

// POST /api/dms { userId } — get-or-create (idempotent, race-safe).
//
// Three gates before the conversation is created, in the order that tells a
// stranger least: the peer has to exist, neither party may have blocked the
// other, and the peer's DM preference has to permit this sender. Without them
// the privacy settings would be a display preference on a control that nothing
// enforced.
// POST /api/dms has a budget of its own. The router-level limiter below is
// one shared bucket, so a route with a smaller ceiling must name its own
// bucket; otherwise a busy minute of reading conversations would spend a
// creation budget it never touched.
router.post('/', auth.requireVerified, rateLimit({ windowMs: 60000, max: 20, key: 'dm-create' }), async (req, res, next) => {
  try {
    if (await require('../services/enforcement').isRestricted(req.user.id, 'DIRECT_MESSAGES')) {
      return fail(res, 'FEATURE_RESTRICTED', 'direct messages are restricted on your account', 403,
        { feature: 'DIRECT_MESSAGES' });
    }
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
    if (await require('../services/enforcement').isRestricted(req.user.id, 'DIRECT_MESSAGES')) {
      return fail(res, 'FEATURE_RESTRICTED', 'direct messages are restricted on your account', 403,
        { feature: 'DIRECT_MESSAGES' });
    }
    const group = await dms.createGroup({ id: req.user.id }, req.body || {});
    // Being added to a group is a membership change the other people did not
    // witness. Each of them is told, once, and every member's list learns the
    // new conversation over the socket. A failure here must not undo a group
    // that exists.
    const members = await dms.memberIds(group.id);
    for (const id of members) {
      if (String(id) === String(req.user.id)) continue;
      try {
        const { notification, held } = await notifications.create(
          id, 'group_member_added', req.user.id, group.id,
          { dedupeKey: 'group-added:' + group.id + ':' + id }
        );
        if (notification && !held) {
          gateway.sendToUser(id, { type: EVENTS.NOTIFICATION, notification });
        }
      } catch { /* the membership is the fact */ }
    }
    gateway.broadcastDm(members, {
      type: EVENTS.DM_CONVERSATION_UPDATED,
      conversationId: group.id,
      conversation: group,
      reason: 'created',
    });
    res.status(201).json(group);
  } catch (e) { serviceError(res, e); }
});

// GET /api/dms/invites — the group invitations waiting for me.
//
// Declared before /:id because "invites" is a fixed word and would otherwise
// be read as a conversation id.
router.get('/invites', async (req, res, next) => {
  try {
    res.json(await dms.groupInvites(req.user.id));
  } catch (e) { serviceError(res, e); }
});

// POST /api/dms/invites/:inviteId/accept — the invited person joins.
router.post('/invites/:inviteId/accept', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await dms.acceptGroupInvite(req.user.id, req.params.inviteId);
    const members = await dms.memberIds(out.conversation.id);
    gateway.broadcastDm(members, {
      type: EVENTS.DM_CONVERSATION_UPDATED,
      conversationId: out.conversation.id,
      conversation: out.conversation,
      reason: 'member_joined',
      userId: req.user.id,
    });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// POST /api/dms/invites/:inviteId/decline
router.post('/invites/:inviteId/decline', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await dms.declineGroupInvite(req.user.id, req.params.inviteId);
    gateway.sendToUser(out.inviterId, {
      type: EVENTS.DM_INVITE,
      invite: { id: out.id, conversationId: out.conversationId, status: out.status, inviteeId: req.user.id },
    });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// GET /api/dms/:id — full conversation payload for opening a chat.
router.get('/:id', async (req, res, next) => {
  try {
    const detail = await dms.detail(req.user.id, req.params.id, { limit: 50 });
    await withPresence([detail], req.user.id);
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

// GET /api/dms/:id/messages/search?q=&limit= — search inside one
// conversation. The membership check is the service's first query, so this
// cannot be used to read a conversation the caller is not in.
router.get('/:id/messages/search', async (req, res, next) => {
  try {
    res.json(await dms.searchMessages(req.user.id, req.params.id, req.query.q, req.query.limit));
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
router.post('/:id/messages', auth.requireVerified, rateLimit({ windowMs: 60000, max: 40, key: 'dm-send' }), async (req, res, next) => {
  try {
    const enforcement = require('../services/enforcement');
    if (await enforcement.isRestricted(req.user.id, 'DIRECT_MESSAGES')) {
      return fail(res, 'FEATURE_RESTRICTED', 'direct messages are restricted on your account', 403,
        { feature: 'DIRECT_MESSAGES' });
    }
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
          if (notification && !held) gateway.sendToUser(id, { type: EVENTS.NOTIFICATION, notification });
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
        if (r && r.notification && !r.held) gateway.sendToUser(r.userId, { type: EVENTS.NOTIFICATION, notification: r.notification });
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
router.patch('/:id/messages/:messageId', auth.requireVerified, rateLimit({ windowMs: 60000, max: 40, key: 'dm-edit' }), async (req, res, next) => {
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

// GET /api/dms/:id/pins — the messages this conversation keeps at hand.
router.get('/:id/pins', async (req, res, next) => {
  try {
    res.json(await dms.listPins(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

// POST /api/dms/:id/pins { messageId }
router.post('/:id/pins', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await dms.addPin(req.user.id, req.params.id, (req.body || {}).messageId);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, {
      type: EVENTS.DM_PINNED,
      conversationId: req.params.id,
      messageId: out.messageId,
      pinnedBy: req.user.id,
      pinnedAt: out.pinnedAt,
    });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/dms/:id/pins/:messageId
router.delete('/:id/pins/:messageId', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await dms.removePin(req.user.id, req.params.id, req.params.messageId);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, {
      type: EVENTS.DM_UNPINNED,
      conversationId: req.params.id,
      messageId: out.messageId,
    });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// The name of a group, and who is in it.
//
// The owner and admins may do this: a name is what the people in the
// conversation call it, but it is still a shared object; letting any member
// rename it turns the heading of the conversation into a prank surface.
router.patch('/:id', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
    try {
      const out = await dms.renameGroup(req.params.id, req.user.id, (req.body || {}).name);
      const members = await dms.memberIds(req.params.id);
      gateway.broadcastDm(members, {
        type: EVENTS.DM_CONVERSATION_UPDATED,
        conversationId: req.params.id,
        conversation: out,
        reason: 'renamed',
      });
      res.json(out);
    } catch (e) { serviceError(res, e); }
  });

// A group's picture. The bytes go through the same image sniffing and storage
// as a profile avatar; the route only decides who may write it.
router.post('/:id/avatar', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 10, key: 'dm-groups' }), singleImage, async (req, res, next) => {
    try {
      const role = await dms.groupRole(req.params.id, req.user.id);
      if (!role) return fail(res, 'NOT_FOUND', 'conversation not found');
      if (role !== 'owner' && role !== 'admin') {
        return fail(res, 'PERMISSION_DENIED', 'only an owner or admin can change the picture', 403);
      }
      if (!req.file || !req.file.buffer) {
        return fail(res, 'VALIDATION_ERROR', 'send the image as a multipart field named "file"');
      }
      const stored = await uploads.storeConversationMedia({
        conversationId: req.params.id,
        kind: 'avatar',
        buffer: req.file.buffer,
        originalName: req.file.originalname || '',
      });
      if (stored.error) return fail(res, stored.error, stored.message);
      const previous = await dms.groupAvatar(req.params.id);
      const out = await dms.setGroupAvatar(req.params.id, req.user.id, stored.url);
      if (previous && previous !== stored.url) {
        await uploads.removeConversationFile(previous).catch(() => {});
      }
      const members = await dms.memberIds(req.params.id);
      gateway.broadcastDm(members, {
        type: EVENTS.DM_CONVERSATION_UPDATED,
        conversationId: req.params.id,
        conversation: out,
        reason: 'avatar',
      });
      res.status(201).json(out);
    } catch (e) { serviceError(res, e); }
  });

router.delete('/:id/avatar', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 10, key: 'dm-groups' }), async (req, res, next) => {
    try {
      const role = await dms.groupRole(req.params.id, req.user.id);
      if (!role) return fail(res, 'NOT_FOUND', 'conversation not found');
      if (role !== 'owner' && role !== 'admin') {
        return fail(res, 'PERMISSION_DENIED', 'only an owner or admin can change the picture', 403);
      }
      const previous = await dms.groupAvatar(req.params.id);
      const out = await dms.setGroupAvatar(req.params.id, req.user.id, null);
      if (previous) await uploads.removeConversationFile(previous).catch(() => {});
      const members = await dms.memberIds(req.params.id);
      gateway.broadcastDm(members, {
        type: EVENTS.DM_CONVERSATION_UPDATED,
        conversationId: req.params.id,
        conversation: out,
        reason: 'avatar',
      });
      res.json(out);
    } catch (e) { serviceError(res, e); }
  });

// Invite somebody to a group. An invitation is a question, unlike POST
// /:id/members which adds them directly; both are supported because both are
// real things people do.
router.post('/:id/invites', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
    try {
      const invite = await dms.inviteToGroup(req.params.id, req.user.id, (req.body || {}).userId);
      if (invite && invite.inviteeId) {
        try {
          const { notification, held } = await notifications.create(
            invite.inviteeId, 'group_invite', req.user.id, invite.id,
            { dedupeKey: 'dm-invite:' + invite.id + ':' + invite.updatedAt }
          );
          if (notification && !held) {
            gateway.sendToUser(invite.inviteeId, { type: EVENTS.NOTIFICATION, notification });
          }
          if (notification) gateway.sendToUser(invite.inviteeId, { type: EVENTS.DM_INVITE, invite });
        } catch { /* the invitation exists even if the nudge did not arrive */ }
      }
      res.status(201).json(invite);
    } catch (e) { serviceError(res, e); }
  });

router.delete('/:id/invites/:inviteId', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await dms.cancelGroupInvite(req.params.id, req.user.id, req.params.inviteId);
    if (out.inviteeId) {
      gateway.sendToUser(out.inviteeId, {
        type: EVENTS.DM_INVITE,
        invite: { id: out.id, conversationId: out.conversationId, status: out.status },
      });
    }
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// Promote or demote a member. Owner only.
router.patch('/:id/members/:userId', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
    try {
      const out = await dms.setGroupRole(
        req.params.id, req.user.id, req.params.userId, (req.body || {}).role
      );
      const members = await dms.memberIds(req.params.id);
      gateway.broadcastDm(members, {
        type: EVENTS.DM_CONVERSATION_UPDATED,
        conversationId: req.params.id,
        conversation: out.conversation,
        reason: 'role',
      });
      try {
        const { notification, held } = await notifications.create(
          req.params.userId, 'group_role_changed', req.user.id, req.params.id,
          { detail: out.role }
        );
        if (notification && !held) {
          gateway.sendToUser(req.params.userId, { type: EVENTS.NOTIFICATION, notification });
        }
      } catch { /* role already changed */ }
      res.json(out);
    } catch (e) { serviceError(res, e); }
  });

// Hand the group on. The previous owner becomes an admin.
router.post('/:id/transfer', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 10, key: 'dm-groups' }), async (req, res, next) => {
    try {
      const out = await dms.transferGroupOwnership(
        req.params.id, req.user.id, (req.body || {}).userId
      );
      const members = await dms.memberIds(req.params.id);
      gateway.broadcastDm(members, {
        type: EVENTS.DM_CONVERSATION_UPDATED,
        conversationId: req.params.id,
        conversation: out.conversation,
        reason: 'ownership',
      });
      try {
        const { notification, held } = await notifications.create(
          out.ownerId, 'group_ownership_transferred', req.user.id, req.params.id
        );
        if (notification && !held) {
          gateway.sendToUser(out.ownerId, { type: EVENTS.NOTIFICATION, notification });
        }
      } catch { /* ownership already changed */ }
      res.json(out);
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
    const targetId = String((req.body || {}).userId || '');
    const out = await dms.addGroupMember(req.params.id, req.user.id, targetId);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, {
      type: EVENTS.DM_CONVERSATION_UPDATED,
      conversationId: req.params.id,
      conversation: out,
      reason: 'member_added',
      userId: targetId,
    });
    try {
      const { notification, held } = await notifications.create(
        targetId, 'group_member_added', req.user.id, req.params.id,
        { dedupeKey: 'group-added:' + req.params.id + ':' + targetId }
      );
      if (notification && !held) {
        gateway.sendToUser(targetId, { type: EVENTS.NOTIFICATION, notification });
      }
    } catch { /* the membership is the fact */ }
    res.json(out);
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
    const out = await dms.leaveGroup(req.params.id, req.user.id);
    const members = await dms.memberIds(req.params.id);
    gateway.broadcastDm(members, {
      type: EVENTS.DM_CONVERSATION_UPDATED,
      conversationId: req.params.id,
      reason: 'member_left',
      userId: req.user.id,
    });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// Somebody is taken out of a group.
//
// The member is named in the address, so leaving and removing are two
// different things and neither of them is guessed at.
router.delete('/:id/members/:userId', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'dm-groups' }), async (req, res, next) => {
    try {
      const targetId = String(req.params.userId || '');
      const out = await dms.removeGroupMember(req.params.id, req.user.id, targetId);
      const members = await dms.memberIds(req.params.id);
      gateway.broadcastDm(members, {
        type: EVENTS.DM_CONVERSATION_UPDATED,
        conversationId: req.params.id,
        conversation: out,
        reason: 'member_removed',
        userId: targetId,
      });
      // The person removed is not in the room any more, so the room broadcast
      // does not reach them. They are told directly, and the notification is
      // persisted for the next time they open the app.
      try {
        const { notification, held } = await notifications.create(
          targetId, 'group_member_removed', req.user.id, req.params.id
        );
        if (notification) {
          if (!held) gateway.sendToUser(targetId, { type: EVENTS.NOTIFICATION, notification });
          gateway.sendToUser(targetId, {
            type: EVENTS.DM_CONVERSATION_UPDATED,
            conversationId: req.params.id,
            reason: 'removed',
            userId: targetId,
          });
        }
      } catch { /* removal already happened */ }
      res.json(out);
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
