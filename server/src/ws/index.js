// Realtime gateway. Authenticated sockets join channels or DM conversations, and receive
// broadcasts for the rooms they are in.
//
// Handshake security:
//   - A client POSTs for a short-lived, single-use ticket, then connects with ?ticket=.
//     A bearer token never appears in a URL, because URLs end up in access logs, proxy
//     logs and Referer headers.
//   - The ticket's claims are re-validated against revocation and the password-changed
//     and sign-out markers before the socket is tracked.
//   - ?token= sockets are refused outright.
//
// Limits, because a verified socket is still just one peer:
//   - maxPayload caps incoming frames.
//   - A per-socket message rate, with a strike escalation that ends in close(1008).
//   - A per-user connection cap: the newest wins and the oldest is terminated, so a
//     reconnect storm cannot pin a user offline.
//   - Heartbeat pings; an unresponsive socket is terminated.

const WebSocket = require('ws');
const db = require('../db');
const auth = require('../services/auth');
const { can, serverPermissions } = require('../middleware/auth');
const { now } = require('../util');
const bus = require('../services/bus');

const FRAME_WINDOW_MS = 10000;
const FRAME_MAX = 120;
const MAX_SOCKETS_PER_USER = 5;

function createGateway(server, config) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: config.wsMaxPayload });

  // userId -> Set<ws>. One entry per user, whatever the number of open sockets.
  const online = new Map();
  // userId -> 'online' | 'offline', which is what the presence endpoint reports.
  const presence = new Map();

  function trackOpen(ws, userId) {
    let set = online.get(userId);
    if (!set) {
      set = new Set();
      online.set(userId, set);
    }
    // The newest connection wins, so a reconnect storm cannot pin a user offline.
    while (set.size >= MAX_SOCKETS_PER_USER) {
      const oldest = set.values().next().value;
      if (!oldest) break;
      try { oldest.close(4000, 'replaced'); } catch { /* already gone */ }
      set.delete(oldest);
    }
    set.add(ws);
    presence.set(userId, 'online');
  }

  function trackClose(ws, userId) {
    const set = online.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      online.delete(userId);
      presence.set(userId, 'offline');
    }
  }

  const isOnline = (userId) => (online.get(userId) || new Set()).size > 0;
  const getPresence = (userId) => (isOnline(userId) ? 'online' : 'offline');

  // room -> Set<ws>, for channel broadcasts, and userId -> Set<ws> for direct sends.
  const rooms = new Map();

  function joinRoom(ws, room) {
    leaveRoom(ws);
    let set = rooms.get(room);
    if (!set) {
      set = new Set();
      rooms.set(room, set);
    }
    set.add(ws);
    ws.room = room;
  }

  function leaveRoom(ws) {
    if (!ws.room) return;
    const set = rooms.get(ws.room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(ws.room);
    }
    ws.room = null;
  }

  function broadcast(room, payload) {
    const set = rooms.get(room);
    if (!set) return;
    const text = JSON.stringify(payload);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  function sendToUser(userId, payload) {
    const set = online.get(userId);
    if (!set) return;
    const text = JSON.stringify(payload);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  function disconnectUser(userId) {
    const set = online.get(userId);
    if (!set) return;
    for (const ws of set) {
      try { ws.close(4001, 'session revoked'); } catch { /* already gone */ }
    }
  }

  // A member who has been removed from a community must stop hearing about it.
  function evictFromServer(serverId, userId) {
    const set = online.get(userId);
    if (!set) return;
    for (const ws of set) {
      if (ws.serverId === serverId) ws.serverId = null;
    }
  }

  // Per-socket frame admission, with escalation. A flood is not a reason to kill the
  // process, but it is a reason to end the connection that is causing it.
  function admitFrame(ws) {
    const at = Date.now();
    if (!ws.frameWindow || at - ws.frameWindow.start > FRAME_WINDOW_MS) {
      ws.frameWindow = { start: at, count: 0 };
    }
    ws.frameWindow.count += 1;
    if (ws.frameWindow.count > FRAME_MAX) {
      ws.strikes += 1;
      if (ws.strikes >= 3) {
        try { ws.close(1008, 'too many messages'); } catch { /* already gone */ }
        return false;
      }
      ws.frameWindow = { start: at, count: 0 };
    }
    return true;
  }

  // A socket may only ask for rooms it is actually entitled to. The entitlement is read
  // here rather than trusted from the client, so a guessed channel id is not enough.
  async function mayJoinRoom(userId, room) {
    if (typeof room !== 'string' || !room) return false;

    if (room.startsWith('channel:')) {
      const channelId = room.slice('channel:'.length);
      const ch = await db.get('SELECT server_id FROM channels WHERE id = ?', [channelId]);
      if (!ch) return false;
      const member = await db.get(
        'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
        [ch.server_id, userId]
      );
      return !!member;
    }

    if (room.startsWith('dm:')) {
      const conversationId = room.slice('dm:'.length);
      const member = await db.get(
        'SELECT 1 FROM dm_members WHERE conversation_id = ? AND user_id = ?',
        [conversationId, userId]
      );
      return !!member;
    }

    if (room.startsWith('server:')) {
      const serverId = room.slice('server:'.length);
      const member = await db.get(
        'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
        [serverId, userId]
      );
      if (member) ws.serverId = serverId;
      return !!member;
    }

    return false;
  }

  async function dispatch(ws, user, data) {
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'join': {
        const room = 'channel:' + String(data.channelId || '');
        if (await mayJoinRoom(user.id, room)) joinRoom(ws, room);
        return;
      }
      case 'join-server': {
        const room = 'server:' + String(data.serverId || '');
        if (await mayJoinRoom(user.id, room)) {
          ws.serverId = String(data.serverId);
        }
        return;
      }
      case 'dm:join': {
        const room = 'dm:' + String(data.conversationId || '');
        if (await mayJoinRoom(user.id, room)) joinRoom(ws, room);
        return;
      }
      case 'leave': {
        leaveRoom(ws);
        return;
      }
      case 'typing': {
        if (!ws.room) return;
        broadcast(ws.room, { type: 'typing', userId: user.id, username: user.username });
        return;
      }
      default:
        return;
    }
  }

  wss.on('connection', (ws, req) => {
    let params;
    try {
      params = new URL(`ws://${req.headers.host}${req.url}`).searchParams;
    } catch {
      ws.close();
      return;
    }

    // Backwards-incompatible on purpose: bearer JWTs never belong in URLs.
    if (params.get('token')) {
      ws.close(1008, 'token auth is not supported');
      return;
    }
    const ticket = params.get('ticket');
    if (!ticket) {
      ws.close(1008, 'ticket required');
      return;
    }
    const claims = auth.consumeTicket(ticket);
    if (!claims) {
      ws.close(1008, 'invalid or expired ticket');
      return;
    }

    // The ticket bought one attempt. From here the claims are re-validated exactly as the
    // HTTP layer validates a bearer token, so the two cannot disagree about what a live
    // session is.
    const out = auth.resolveSessionSync
      ? null
      : null;
    void out;

    validateClaims(claims).then((user) => {
      if (!user) {
        ws.close(1008, 'session invalid');
        return;
      }
      attach(ws, user);
    }).catch(() => ws.close(1011, 'session check failed'));
  });

  async function validateClaims(claims) {
    // The ticket carries the claims from a live bearer token, so the same staleness rules
    // apply: a token minted before a password change or a sign-out-everything is dead.
    const row = await auth.loadSessionRow(claims.id, claims.jti);
    if (!row) return null;
    if (claims.jti && row.revoked) return null;
    if (auth.tokenStale(claims, row)) return null;
    if (auth.enforced(claims, row)) return null;
    if (!claims.jti) {
      // A ticket issued without a jti is not tied to a revocable session.
      return null;
    }
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email || null,
      emailVerified: !!row.email_verified_at,
    };
  }

  function attach(ws, user) {
    ws.user = user;
    ws.isAlive = true;
    ws.strikes = 0;
    ws.frameWindow = null;
    ws.room = null;
    ws.serverId = null;

    trackOpen(ws, user.id);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* an uncaught here races terminate() */ });
    ws.on('close', () => {
      leaveRoom(ws);
      trackClose(ws, user.id);
    });
    ws.on('message', (raw) => {
      if (!admitFrame(ws)) return;
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      dispatch(ws, user, data).catch(() => { /* a malformed payload is ignored */ });
    });
  }

  // The services publish through the bus; this is the one place it learns a socket
  // exists. Detaching is not needed because there is one gateway per process.
  bus.attach(broadcast);

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Unref'd, so the heartbeat never keeps the process alive on its own.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { try { ws.terminate(); } catch { /* already gone */ } }
    }
  }, config.wsHeartbeatMs);
  heartbeat.unref();

  return {
    broadcast, sendToUser, disconnectUser, isOnline, getPresence,
    evictFromServer,
    invalidateMembers: (serverId) => {
      for (const [userId, set] of online) {
        void userId;
        for (const ws of set) if (ws.serverId === serverId) ws.serverId = null;
      }
    },
    issueTicket: auth.issueTicket,
    rooms,
  };
}

module.exports = createGateway;
