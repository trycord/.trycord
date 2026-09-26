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
const { hasPermission } = require('./services/permissions');
const { tokenStale, enforced: authEnforced } = require('./middleware/auth');
const dms = require('./services/dms');
const uploads = require('./services/uploads');

const TICKET_TTL_MS = 60 * 1000;
const MAX_PER_USER_SOCKETS = 8;
// 200 KB is generous for JSON chat traffic and far too small to buffer abuse.
const MAX_PAYLOAD = parseInt(process.env.WS_MAX_PAYLOAD || '', 10) || 200 * 1024;
const MSG_WINDOW_MS = 10 * 1000;
const MSG_WINDOW_MAX = 90;
const MSG_STRIKE_LIMIT = 6;
const HEARTBEAT_MS = 30 * 1000;

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
    socketsOf(userId).forEach((c) => {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(data); } catch { /* dead socket: cleaned on close */ }
      }
    });
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
    set.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(data); } catch { /* dead socket: cleaned on close */ }
      }
    });
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
  async function broadcastServer(serverId, payload) {
    const data = JSON.stringify(payload);
    const set = serverRooms.get(String(serverId));
    if (!set) return;
    for (const c of [...set]) {
      if (c.readyState !== WebSocket.OPEN) continue;
      if (!c.user) continue;
      try {
        if (!(await isMember(c.user.id, serverId))) continue;
      } catch { continue; }
      try { c.send(data); } catch { /* dead socket: cleaned on close */ }
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
        if (c.readyState === WebSocket.OPEN && c.dmIds && c.dmIds.has(String(payload.conversationId))) {
          try { c.send(data); } catch { /* dead socket */ }
        }
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
      const row = await db.get('SELECT password_changed_at, sessions_invalidated_at, enforcement_state, enforcement_expires_at FROM users WHERE id = ?', [user.id]);
      if (!row) { ws.close(1008, 'user not found'); return; }
      if (tokenStale(user, row)) { ws.close(1008, 'session revoked'); return; }
      // A socket cannot open while the account is under enforcement, matching
      // the HTTP gate exactly (same helper, same semantics).
      if (authEnforced(user, row)) { ws.close(1008, 'account enforced'); return; }

      ws.user = user;
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
            const content = String(data.content || '').trim().slice(0, 2000);
            const ids = uploads.sanitizeIds(data.attachments);
            if (!content && !ids.length) return;
            const ch = await visibleChannel(ws.channelId, user.id);
            if (!ch) return;
            // Same gate as the HTTP post: membership alone is not enough.
            if (!(await hasPermission(user.id, ch.server_id, 'SEND_MESSAGES'))) return;
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
              edited_at: null,
            };
            try {
              await db.run(
                'INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
                [msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at]
              );
            } catch { return; }
            msg.attachments = ids.length
              ? await uploads.attachToMessage(ids, msg.id, user.id, ch.id)
              : [];
            broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
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

  return { broadcast, broadcastDm, sendToUser, isOnline, getPresence, issueTicket, disconnectUser, broadcastServer, evictUserFromServer };
}

module.exports = createGateway;