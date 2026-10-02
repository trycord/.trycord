// Realtime gateway: authenticated sockets join channels or DM conversations,
// post channel messages, send typing signals, and receive broadcasts.
// Presence is derived from actual socket state: a user is online while at
// least one of their sockets is open. Shares the HTTP server.
//
// Handshake security:
//   - Clients POST /api/auth/ws/ticket for a short-lived (60s), single-use
//     ticket, then connect with ?ticket=... The JWT never appears in a URL
//     (it would leak through logs, proxies, and referrers).
//   - Legacy ?token= sockets are refused outright.
//   - The ticket's claims are re-validated against revocation and the
//     password-changed/sign-out markers before the socket is tracked.
// Resource limits (each verified socket is still just one peer):
//   - maxPayload caps incoming frames at WS_MAX_PAYLOAD.
//   - Per-socket message rate limiting with a strike escalation that ends
//     in a close(1008) if the flood persists.
//   - Per-user connection cap: the newest connection wins, the oldest open
//     socket is terminated, so reconnect storms cannot pin a user offline.
//   - Heartbeat pings every 30s; unresponsive sockets are terminated.
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('./db');
const { now, uuid, visibleChannel, isMember } = require('./util');
const { hasChannelPermission } = require('./services/permissions');
const { tokenStale, enforced: authEnforced } = require('./middleware/auth');
const dms = require('./services/dms');
const uploads = require('./services/uploads');
const threads = require('./services/threads');
const replies = require('./services/replies');
const embeds = require('./services/embeds');
const webhooks = require('./services/webhooks');
const { nextSeq } = require('./routes/messages');

const TICKET_TTL_MS = 60 * 1000;
const MAX_PER_USER_SOCKETS = 8;
// 200 KB is generous for JSON chat traffic and far too small to buffer abuse.
const MAX_PAYLOAD = parseInt(process.env.WS_MAX_PAYLOAD || '', 10) || 200 * 1024;
const MSG_WINDOW_MS = 10 * 1000;
const MSG_WINDOW_MAX = 90;
const MSG_STRIKE_LIMIT = 6;
const HEARTBEAT_MS = 30 * 1000;
// A socket that stops reading would otherwise buffer frames without bound and
// stall delivery for every other member of its room, since broadcast walks the
// room synchronously. Past this many queued bytes the socket is dropped;
// clients reconnect and resync over HTTP.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

function createGateway(server) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_PAYLOAD });
  // userId -> Set<ws>. The single source of truth for presence.
  const userSockets = new Map();
  // ticket -> { claims, exp }. Single-use, short-lived.
  const tickets = new Map();

  function socketsOf(userId) {
    return userSockets.get(String(userId)) || new Set();
  }

  function isOnline(userId) {
    const s = userSockets.get(String(userId));
    return !!s && [...s].some((c) => c.readyState === WebSocket.OPEN);
  }

  function getPresence(ids) {
    const out = {};
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      out[String(id)] = isOnline(id) ? 'online' : 'offline';
    });
    return out;
  }

  function sendToUser(userId, payload) {
    const data = JSON.stringify(payload);
    socketsOf(userId).forEach((c) => deliver(c, data));
  }

  function deliver(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      try { ws.close(1013, 'client too slow'); } catch { /* already gone */ }
      return;
    }
    try { ws.send(data); } catch { /* dead socket: cleaned on close */ }
  }

  // Channel rooms: serverId/channelId -> sockets currently joined there.
  // Broadcasts walk the room instead of every connected socket, so one
  // busy channel never taxes users in other channels. Membership in the
  // set mirrors ws.serverId/ws.channelId exactly (same delivery rule).
  const channelRooms = new Map();
  function roomKey(serverId, channelId) {
    return String(serverId) + '/' + String(channelId);
  }
  function leaveRoom(ws) {
    if (ws.serverId === undefined || ws.channelId === undefined) return;
    const set = channelRooms.get(roomKey(ws.serverId, ws.channelId));
    if (set) {
      set.delete(ws);
      if (!set.size) channelRooms.delete(roomKey(ws.serverId, ws.channelId));
    }
  }
  function joinRoom(ws, serverId, channelId) {
    leaveRoom(ws);
    ws.serverId = serverId;
    ws.channelId = channelId;
    const key = roomKey(serverId, channelId);
    if (!channelRooms.has(key)) channelRooms.set(key, new Set());
    channelRooms.get(key).add(ws);
  }

  function broadcast(serverId, channelId, payload) {
    const data = JSON.stringify(payload);
    const set = channelRooms.get(roomKey(serverId, channelId));
    if (!set) return;
    set.forEach((c) => deliver(c, data));
  }

  // Server rooms: serverId -> sockets that opened the community. Structural
  // changes (roles, channels, members, invites, settings) have no single
  // channel to broadcast on, so they fan out here. Join is membership-gated
  // exactly like channel join; delivery additionally requires the socket to
  // still be a member, so a removed socket can never linger on events.
  const serverRooms = new Map();
  function leaveServerRoom(ws) {
    if (ws.serverRoom === undefined) return;
    const set = serverRooms.get(String(ws.serverRoom));
    if (set) {
      set.delete(ws);
      if (!set.size) serverRooms.delete(String(ws.serverRoom));
    }
    ws.serverRoom = undefined;
  }
  function joinServerRoom(ws, serverId) {
    leaveServerRoom(ws);
    ws.serverRoom = String(serverId);
    const key = String(serverId);
    if (!serverRooms.has(key)) serverRooms.set(key, new Set());
    serverRooms.get(key).add(ws);
  }
  // Delivery re-checks membership, so a removed socket cannot linger on
  // events. That check used to run once per socket: a 10k-member community
  // meant 10k queries for one role change. It is now one query for the whole
  // room, and the set of member ids is memoised for a moment because several
  // structural events fire back to back for the same community.
  const memberCache = new Map();
  const MEMBER_CACHE_MS = 2000;
  async function memberIdsFor(serverId) {
    const key = String(serverId);
    const hit = memberCache.get(key);
    const nowMs = Date.now();
    if (hit && nowMs - hit.at < MEMBER_CACHE_MS) return hit.ids;
    const rows = await db.all('SELECT user_id FROM server_members WHERE server_id = ?', [key]);
    const ids = new Set(rows.map((r) => String(r.user_id)));
    memberCache.set(key, { at: nowMs, ids });
    return ids;
  }
  function invalidateMembers(serverId) {
    if (serverId === undefined) memberCache.clear();
    else memberCache.delete(String(serverId));
  }

  async function broadcastServer(serverId, payload) {
    const data = JSON.stringify(payload);
    const set = serverRooms.get(String(serverId));
    if (!set || !set.size) return;
    let ids;
    try {
      ids = await memberIdsFor(serverId);
    } catch {
      return; // cannot confirm membership, so nobody is told
    }
    for (const c of [...set]) {
      if (c.readyState !== WebSocket.OPEN) continue;
      if (!c.user) continue;
      if (!ids.has(String(c.user.id))) continue;
      deliver(c, data);
    }
  }
  // Remove one user's sockets from a server's rooms (kick/ban/leave): they
  // stop receiving that community immediately. The socket itself stays up
  // so other servers and DMs keep working; broadcastServer additionally
  // re-checks membership per send, so removal is enforced twice.
  function evictUserFromServer(serverId, userId) {
    const set = serverRooms.get(String(serverId));
    if (set) {
      [...set].forEach((c) => {
        if (c.user && String(c.user.id) === String(userId)) {
          set.delete(c);
          if (c.serverRoom !== undefined && String(c.serverRoom) === String(serverId)) c.serverRoom = undefined;
        }
      });
      if (!set.size) serverRooms.delete(String(serverId));
    }
    if (channelRooms.size) {
      for (const [key, room] of channelRooms) {
        if (!key.startsWith(String(serverId) + '/')) continue;
        [...room].forEach((c) => {
          if (c.user && String(c.user.id) === String(userId)) {
            room.delete(c);
            if (c.serverId !== undefined && String(c.serverId) === String(serverId)) {
              c.serverId = undefined; c.channelId = undefined;
            }
          }
        });
        if (!room.size) channelRooms.delete(key);
      }
    }
  }

  // DM delivery: every connected socket of every participant. Clients
  // dedupe by message id (the sender's own tabs get the event too).
  function broadcastDm(memberIds, payload) {
    const data = JSON.stringify(payload);
    (memberIds || []).forEach((id) => {
      socketsOf(id).forEach((c) => {
        if (c.dmIds && c.dmIds.has(String(payload.conversationId))) deliver(c, data);
      });
    });
  }

  // Users who should hear about this user's presence flips: DM peers,
  // friends, plus fellow members of every shared community (so member
  // lists can show live online/offline state). Best-effort: presence must
  // never break messaging. Fan-out stays bounded: announcePresence only
  // sends to currently-online targets.
  async function affectedUsers(userId) {
    try {
      const peers = await db.all(
        `SELECT om.user_id AS id FROM dm_members m
         JOIN dm_members om ON om.conversation_id = m.conversation_id
         WHERE m.user_id = ? AND om.user_id != ?`,
        [userId, userId]
      );
      const friends = await db.all('SELECT friend_id AS id FROM friendships WHERE user_id = ?', [userId]);
      const members = await db.all(
        `SELECT m2.user_id AS id FROM server_members m
         JOIN server_members m2 ON m2.server_id = m.server_id
         WHERE m.user_id = ? AND m2.user_id != ?`,
        [userId, userId]
      );
      const ids = new Set();
      peers.concat(friends).concat(members).forEach((r) => ids.add(String(r.id)));
      ids.delete(String(userId));
      return [...ids];
    } catch {
      return [];
    }
  }

  async function announcePresence(userId, presence) {
    const targets = await affectedUsers(userId);
    targets.forEach((id) => {
      if (isOnline(id)) sendToUser(id, { type: 'presence', userId: String(userId), presence });
    });
  }

  function trackOpen(ws, userId) {
    const id = String(userId);
    if (!userSockets.has(id)) userSockets.set(id, new Set());
    const first = ![...userSockets.get(id)].some((c) => c !== ws && c.readyState === WebSocket.OPEN);
    userSockets.get(id).add(ws);
    if (first) announcePresence(id, 'online').catch(() => {});
  }

  function trackClose(ws, userId) {
    const id = String(userId);
    const set = userSockets.get(id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      userSockets.delete(id);
      announcePresence(id, 'offline').catch(() => {});
    }
  }

  // Cut every live socket for a user — used the instant enforcement lands,
  // so a banned/suspended account cannot keep an existing connection open.
  // A graceful close frame (1008) is sent; no hard terminate, so the peer
  // actually observes the reason. Stuck sockets are reaped by the heartbeat.
  function disconnectUser(userId, reason) {
    const id = String(userId);
    const set = userSockets.get(id);
    if (!set) return;
    [...set].forEach((c) => {
      try { c.close(1008, String(reason || 'session closed')); } catch { /* gone already */ }
    });
  }

  // Ticket issuance/consumption. One HTTP call = one socket attempt.
  function issueTicket(claims) {
    const t = crypto.randomUUID();
    tickets.set(t, { claims, exp: Date.now() + TICKET_TTL_MS });
    if (tickets.size > 2048) {
      const guestCut = Date.now();
      for (const [k, v] of tickets) if (guestCut >= v.exp) tickets.delete(k);
    }
    return t;
  }

  function consumeTicket(t) {
    const rec = tickets.get(t);
    if (!rec) return null;
    tickets.delete(t);
    if (Date.now() > rec.exp) return null;
    return rec.claims;
  }

  wss.on('connection', (ws, req) => {
    let params = null;
    try {
      params = new URL(`ws://${req.headers.host}${req.url}`).searchParams;
    } catch { ws.close(); return; }
    // Backwards-incompatible on purpose: bearer JWTs never belong in URLs.
    if (params.get('token')) { ws.close(1008, 'token auth is not supported'); return; }
    const ticket = params.get('ticket');
    if (!ticket) { ws.close(1008, 'ticket required'); return; }
    const claims = consumeTicket(ticket);
    if (!claims) { ws.close(1008, 'invalid or expired ticket'); return; }
    const user = claims;
    (async () => {
      if (user.jti) {
        const revoked = await db.get('SELECT 1 FROM revoked_tokens WHERE jti = ?', [user.jti]);
        if (revoked) { ws.close(1008, 'session revoked'); return; }
      }
      // Mirror the HTTP layer: tickets issued before a password change or
      // "sign out everywhere" are dead. Socket sessions must never outlive them.
      const row = await db.get('SELECT password_changed_at, sessions_invalidated_at, enforcement_state, enforcement_expires_at, email_verified_at FROM users WHERE id = ?', [user.id]);
      if (!row) { ws.close(1008, 'user not found'); return; }
      if (tokenStale(user, row)) { ws.close(1008, 'session revoked'); return; }
      // A socket cannot open while the account is under enforcement, matching
      // the HTTP gate exactly (same helper, same semantics).
      if (authEnforced(user, row)) { ws.close(1008, 'account enforced'); return; }

      ws.user = user;
      // Authoritative verification state for this socket. Re-read on
      // demand below so verifying mid-session unblocks without reconnect.
      ws.verified = !!row.email_verified_at;
      ws.dmIds = new Set();
      ws.msgTimes = [];
      ws.strikes = 0;
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => { /* avoid uncaught from racing terminate() */ });

      // Per-user cap: newest connection wins so a reconnect storm cannot
      // wedge a user out; the oldest OPEN socket is dropped.
      const key = String(user.id);
      if (!userSockets.has(key)) userSockets.set(key, new Set());
      const set = userSockets.get(key);
      if ([...set].filter((c) => c !== ws && c.readyState === WebSocket.OPEN).length >= MAX_PER_USER_SOCKETS) {
        const oldest = [...set].find((c) => c !== ws && c.readyState === WebSocket.OPEN);
        if (oldest) { try { oldest.terminate(); } catch { /* gone already */ } }
      }

      trackOpen(ws, user.id);
      ws.on('close', () => { leaveRoom(ws); leaveServerRoom(ws); trackClose(ws, user.id); });
      ws.on('message', (raw) => {
        const nowMs = Date.now();
        ws.msgTimes = ws.msgTimes.filter((t) => nowMs - t < MSG_WINDOW_MS);
        if (ws.msgTimes.length >= MSG_WINDOW_MAX) {
          ws.strikes += 1;
          if (ws.strikes > MSG_STRIKE_LIMIT) {
            try { ws.close(1008, 'rate limited'); } catch { /* closing */ }
          }
          return;
        }
        ws.msgTimes.push(nowMs);
        (async () => {
          let data;
          try { data = JSON.parse(raw); } catch { return; }
          if (data.type === 'join') {
            const ch = await visibleChannel(data.channelId, user.id);
            if (!ch) return;
            joinRoom(ws, ch.server_id, ch.id);
          } else if (data.type === 'join-server') {
            // Open a community: membership verified, same as channel join.
            // Structural events for this server fan out to this room.
            const sid = String(data.serverId || '');
            if (!sid) return;
            if (!(await isMember(user.id, sid))) return;
            joinServerRoom(ws, sid);
          } else if (data.type === 'leave-server') {
            leaveServerRoom(ws);
          } else if (data.type === 'msg') {
            if (!ws.channelId) return;
            // Email verification gate, same as REST posts. Re-read once
            // when cached false so a verification that lands mid-session
            // takes effect without forcing a reconnect.
            if (!ws.verified) {
              try {
                const v = await db.get('SELECT email_verified_at FROM users WHERE id = ?', [user.id]);
                ws.verified = !!(v && v.email_verified_at);
              } catch { /* stay unverified on read failure */ }
              if (!ws.verified) return;
            }
            const content = String(data.content || '').trim().slice(0, 2000);
            const ids = uploads.sanitizeIds(data.attachments);
            if (!content && !ids.length) return;
            const ch = await visibleChannel(ws.channelId, user.id);
            // Same reply contract as the REST post, including refusing a target
            // that is not in this channel rather than posting flat.
            const threadRootId = await threads.resolveRoot('channel', ch.id, data.replyToId);
            if (!ch) return;
            // Same gate as the HTTP post: membership alone is not enough.
            if (!(await hasChannelPermission(user.id, ch.server_id, ch.id, 'SEND_MESSAGES'))) return;
            // Timed-out members stay connected (read-only) but cannot post.
            try {
              const t = await db.get(
                'SELECT timeout_expires_at FROM server_members WHERE server_id = ? AND user_id = ?',
                [ch.server_id, user.id]
              );
              if (t && t.timeout_expires_at && new Date(t.timeout_expires_at).getTime() > Date.now()) return;
            } catch { /* fail open to the permission gate above */ }
            const msg = {
              id: uuid(), channel_id: ch.id, server_id: ch.server_id,
              author_id: user.id, user: user.username, content, created_at: now(),
              edited_at: null, thread_root_id: threadRootId,
            };
            // The per-channel sequence is what the history cursor pages on, so
            // a socket post without one is invisible to every later read.
            let inserted = false;
            for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
              const seq = await nextSeq(ch.id);
              try {
                await db.run(
                  'INSERT INTO messages (id, channel_id, author_id, content, created_at, seq, thread_root_id)' +
                  ' VALUES (?, ?, ?, ?, ?, ?, ?)',
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
            broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
            // Same after-the-fact work as the REST post, so a message submitted
            // over the socket behaves identically.
            if (/https?:\/\//i.test(content)) {
              embeds.queue({ kind: 'channel', messageId: msg.id }, content).then((cards) => {
                if (!cards.length) return;
                broadcast(ch.server_id, ch.id, { type: 'message_embeds', channel_id: ch.id, server_id: ch.server_id, messageId: msg.id, embeds: cards });
              }).catch(() => {});
            }
            webhooks.emit(ch.server_id, 'message.created', {
              serverId: ch.server_id, channelId: ch.id,
              message: { id: msg.id, authorId: user.id, content },
            }).catch(() => {});
            // Same reply notification the REST post sends, so the reply behaves
            // the same however the message was submitted.
            if (threadRootId) {
              try {
                const r = await replies.notifyReply({
                  kind: 'channel', scopeId: ch.id, rootId: threadRootId,
                  replyId: msg.id, authorId: user.id,
                });
                if (r) sendToUser(r.userId, { type: 'notification', notification: r.notification });
              } catch { /* a missing notification must not fail the post */ }
            }
          } else if (data.type === 'dm:join') {
            // Join a DM room to receive its events. Membership verified.
            const seen = await dms.visibleConversation(data.conversationId, user.id);
            if (!seen) return;
            ws.dmIds.add(String(data.conversationId));
          } else if (data.type === 'dm:leave') {
            // Leave a DM room (F3): without pruning, a long-lived socket
            // accumulates every DM ever opened and keeps receiving them.
            if (data.conversationId !== undefined && data.conversationId !== null) {
              ws.dmIds.delete(String(data.conversationId));
            }
          } else if (data.type === 'dm:typing') {
            // Ephemeral: never stored. Clients throttle before sending.
            const cid = String(data.conversationId || '');
            if (!cid || !ws.dmIds.has(cid)) return;
            const members = await dms.memberIds(cid);
            if (members.indexOf(String(user.id)) === -1) return;
            broadcastDm(members.filter((id) => String(id) !== String(user.id)), {
              type: 'dm:typing', conversationId: cid, userId: user.id, username: user.username,
            });
          }
        })().catch(() => { /* malformed payload: ignore */ });
      });
    })().catch(() => ws.close());
  });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Heartbeat: sockets that miss a ping/pong round are dead weight. pings
  // are unref'd so they never keep the process alive on their own.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
      if (c.isAlive === false) { try { c.terminate(); } catch { /* already gone */ } return; }
      c.isAlive = false;
      try { c.ping(); } catch { c.terminate(); }
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return { broadcast, broadcastDm, sendToUser, isOnline, getPresence, issueTicket, disconnectUser,
    broadcastServer, evictUserFromServer, invalidateMembers };
}

module.exports = createGateway;