// What a client can ask for over an open socket.
//
// Nine frame types, and they are not peers of each other. Six are room bookkeeping -
// join this, leave that - and cost nothing. Two are typing indicators, which are never
// stored. One, 'msg', is a write: it creates a message row, and it is the only path here
// that does anything durable.
//
// The reason 'msg' is 120 lines rather than 20 is that it has to behave exactly like the
// REST post. A socket send is a second way to write a message, and a second way to write
// a thing is a second set of answers to every question about it: is it length-capped or
// truncated, is a reply target validated, does a timed-out member get refused, does the
// sequence get assigned, do embeds and webhooks and reply notifications still fire. Each
// of those has an answer below and it is the same answer the HTTP route gives, because
// the alternative is two implementations of "post a message" that drift.

const db = require('../db');
const { now, uuid, visibleChannel, isMember } = require('../util');
const { hasChannelPermission } = require('../services/permissions');
const dms = require('../services/dms');
const uploads = require('../services/uploads');
const threads = require('../services/threads');
const replies = require('../services/replies');
const embeds = require('../services/embeds');
const webhooks = require('../services/webhooks');
const { nextSeq } = require('../routes/messages');

// Matches the REST send path. Declared here rather than imported so the socket gateway
// keeps no dependency on a route module beyond the sequence allocator it genuinely needs.
const MAX_CONTENT = 2000;

// Per-socket flood control. The window is a count rather than a token bucket because the
// thing being defended is the database and the broadcast fan-out, not bandwidth.
const MSG_WINDOW_MS = 10 * 1000;
const MSG_WINDOW_MAX = 90;
const MSG_STRIKE_LIMIT = 6;

// Returns false when the frame has been answered by closing the socket, which is what a
// sustained flood earns. A strike rather than an instant close, so a client that bursts
// because a reconnect dumped its queue gets one chance to behave.
function admitFrame(ws, nowMs) {
  ws.msgTimes = ws.msgTimes.filter((t) => nowMs - t < MSG_WINDOW_MS);
  if (ws.msgTimes.length < MSG_WINDOW_MAX) {
    ws.msgTimes.push(nowMs);
    return true;
  }
  ws.strikes += 1;
  if (ws.strikes > MSG_STRIKE_LIMIT) {
    try { ws.close(1008, 'rate limited'); } catch { /* closing */ }
    return false;
  }
  return false;
}

module.exports = function createFrames({ rooms, registry }) {
  async function postChannelMessage(ws, user, data) {
    // Email verification gate, same as REST posts. Re-read once when cached false, so a
    // verification that lands mid-session takes effect without forcing a reconnect.
    if (!ws.verified) {
      try {
        const v = await db.get('SELECT email_verified_at FROM users WHERE id = ?', [user.id]);
        ws.verified = !!(v && v.email_verified_at);
      } catch { /* stay unverified on read failure */ }
      if (!ws.verified) return;
    }

    // Capped, not truncated, for the same reason the REST paths are: a socket send has
    // to behave identically to an HTTP one, and a silently shortened message looks like
    // a successful send of something the writer did not write.
    const rawContent = String(data.content == null ? '' : data.content).trim();
    // Refused rather than truncated. Every other rejection in this handler is a silent
    // return, and the client posts over HTTP, so this is a defence-in-depth alignment
    // rather than a path it takes: a socket must not be the one way to write a message
    // the HTTP path would reject.
    if (rawContent.length > MAX_CONTENT) return;

    const ids = uploads.sanitizeIds(data.attachments);
    if (!rawContent && !ids.length) return;

    const ch = await visibleChannel(ws.channelId, user.id);
    if (!ch) return;

    // Same reply contract as the REST post, including refusing a target that is not in
    // this channel rather than posting flat.
    const threadRootId = await threads.resolveRoot('channel', ch.id, data.replyToId);

    // Membership alone is not enough.
    if (!(await hasChannelPermission(user.id, ch.server_id, ch.id, 'SEND_MESSAGES'))) return;

    // Timed-out members stay connected and read-only, but cannot post.
    try {
      const t = await db.get(
        'SELECT timeout_expires_at FROM server_members WHERE server_id = ? AND user_id = ?',
        [ch.server_id, user.id]
      );
      if (t && t.timeout_expires_at && new Date(t.timeout_expires_at).getTime() > Date.now()) return;
    } catch { /* fail open to the permission gate above */ }

    const msg = {
      id: uuid(), channel_id: ch.id, server_id: ch.server_id,
      author_id: user.id, user: user.username, content: rawContent, created_at: now(),
      edited_at: null, thread_root_id: threadRootId,
    };

    // The per-channel sequence is what the history cursor pages on, so a socket post
    // without one is invisible to every later read. Retried on a sequence collision
    // because two sockets posting at once is normal and neither should lose its message.
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const seq = await nextSeq(ch.id);
      try {
        await db.run(
          'INSERT INTO messages (id, channel_id, author_id, content, created_at, seq, thread_root_id)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
          [msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at, seq, threadRootId]
        );
        msg.seq = seq;
        inserted = true;
      } catch (e) {
        const dupSeq = /unique/i.test(String(e && e.message)) || (e && e.code === 'SQLITE_CONSTRAINT');
        if (!dupSeq || attempt === 4) return;
      }
    }
    if (!inserted) return;

    msg.attachments = ids.length
      ? await uploads.attachToMessage(ids, msg.id, user.id, { channelId: ch.id })
      : [];

    rooms.broadcast(ch.server_id, ch.id, { type: 'message', ...msg });

    // Same after-the-fact work as the REST post, so a message submitted over the socket
    // behaves identically.
    if (data.suppressEmbeds !== true && /https?:\/\//i.test(rawContent)) {
      embeds.queue({ kind: 'channel', messageId: msg.id }, rawContent).then((cards) => {
        if (!cards.length) return;
        rooms.broadcast(ch.server_id, ch.id, {
          type: 'message_embeds', channel_id: ch.id, server_id: ch.server_id,
          messageId: msg.id, embeds: cards,
        });
      }).catch(() => {});
    }

    webhooks.emit(ch.server_id, 'message.created', {
      serverId: ch.server_id, channelId: ch.id,
      message: { id: msg.id, authorId: user.id, content: rawContent },
    }).catch(() => {});

    // Same reply notification the REST post sends, so a reply behaves the same however
    // the message was submitted.
    if (threadRootId) {
      try {
        const r = await replies.notifyReply({
          kind: 'channel', scopeId: ch.id, rootId: threadRootId,
          replyId: msg.id, authorId: user.id,
        });
        if (r && !r.held) {
          registry.sendToUser(r.userId, { type: 'notification', notification: r.notification });
        }
      } catch { /* a missing notification must not fail the post */ }
    }
  }

  async function dispatch(ws, user, data) {
    switch (data.type) {
      case 'join': {
        const ch = await visibleChannel(data.channelId, user.id);
        if (!ch) return;
        rooms.joinRoom(ws, ch.server_id, ch.id);
        return;
      }
      case 'join-server': {
        // Open a community: membership verified, same as channel join. Structural events
        // for this server fan out to this room.
        const sid = String(data.serverId || '');
        if (!sid) return;
        if (!(await isMember(user.id, sid))) return;
        rooms.joinServerRoom(ws, sid);
        return;
      }
      case 'leave-server':
        rooms.leaveServerRoom(ws);
        return;

      case 'msg':
        if (!ws.channelId) return;
        await postChannelMessage(ws, user, data);
        return;

      case 'dm:join': {
        // Join a DM room to receive its events. Membership verified.
        const seen = await dms.visibleConversation(data.conversationId, user.id);
        if (!seen) return;
        ws.dmIds.add(String(data.conversationId));
        return;
      }
      case 'dm:leave':
        // Without pruning, a long-lived socket accumulates every DM ever opened and keeps
        // receiving them.
        if (data.conversationId !== undefined && data.conversationId !== null) {
          ws.dmIds.delete(String(data.conversationId));
        }
        return;

      case 'dm:typing': {
        // Ephemeral: never stored. Clients throttle before sending.
        const cid = String(data.conversationId || '');
        if (!cid || !ws.dmIds.has(cid)) return;
        const members = await dms.memberIds(cid);
        if (members.indexOf(String(user.id)) === -1) return;
        rooms.broadcastDm(members.filter((id) => String(id) !== String(user.id)), {
          type: 'dm:typing', conversationId: cid, userId: user.id, username: user.username,
        });
        return;
      }
      default:
        // An unknown frame type is not an error worth a reply. Newer clients talking to
        // an older gateway is normal during a rolling deploy.
    }
  }

  return { dispatch, admitFrame };
};
