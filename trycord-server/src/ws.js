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
const { now, uuid, visibleChannel } = require('./util');
const { hasPermission } = require('./services/permissions');
const { tokenStale } = require('./middleware/auth');
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

  function broadcast(serverId, channelId, payload) {
    const data = JSON.stringify(payload);
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && c.serverId === serverId && c.channelId === channelId) {
        c.send(data);
      }
    });
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

  // Users who should hear about this user's presence flips: DM peers plus
  // friends. Best-effort: presence must never break messaging.
  async function affectedUsers(userId) {
    try {
      const peers = await db.all(
        `SELECT om.user_id AS id FROM dm_members m
         JOIN dm_members om ON om.conversation_id = m.conversation_id
         WHERE m.user_id = ? AND om.user_id != ?`,
        [userId, userId]
      );
      const friends = await db.all('SELECT friend_id AS id FROM friendships WHERE user_id = ?', [userId]);
      const ids = new Set();
      peers.concat(friends).forEach((r) => ids.add(String(r.id)));
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
      const row = await db.get('SELECT password_changed_at, sessions_invalidated_at FROM users WHERE id = ?', [user.id]);
      if (!row) { ws.close(1008, 'user not found'); return; }
      if (tokenStale(user, row)) { ws.close(1008, 'session revoked'); return; }

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
      ws.on('close', () => trackClose(ws, user.id));
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
            ws.serverId = ch.server_id;
            ws.channelId = ch.id;
          } else if (data.type === 'msg') {
            if (!ws.channelId) return;
            const content = String(data.content || '').trim().slice(0, 2000);
            const ids = uploads.sanitizeIds(data.attachments);
            if (!content && !ids.length) return;
            const ch = await visibleChannel(ws.channelId, user.id);
            if (!ch) return;
            // Same gate as the HTTP post: membership alone is not enough.
            if (!(await hasPermission(user.id, ch.server_id, 'SEND_MESSAGES'))) return;
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

  return { broadcast, broadcastDm, sendToUser, isOnline, getPresence, issueTicket };
}

module.exports = createGateway;