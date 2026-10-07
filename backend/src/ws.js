// Realtime gateway: authenticated sockets join channels or DM conversations, post
// channel messages, send typing signals, and receive broadcasts. Shares the HTTP server.
//
// This file is the composition root and nothing else. It creates the WebSocket server,
// authenticates a connection, wires the pieces together and runs the heartbeat. Every
// question it used to answer - who is connected, which room is this socket in, who hears
// about a presence flip, what a client may ask for, how a handshake token is issued -
// now lives in a module named for that question, under ./ws/.
//
// Handshake security:
//   - Clients POST /api/auth/ws/ticket for a short-lived (60s), single-use ticket, then
//     connect with ?ticket=... The JWT never appears in a URL (it would leak through
//     logs, proxies, and referrers).
//   - Legacy ?token= sockets are refused outright.
//   - The ticket's claims are re-validated against revocation and the password-changed /
//     sign-out markers before the socket is tracked.
//
// Resource limits (each verified socket is still just one peer):
//   - maxPayload caps incoming frames at WS_MAX_PAYLOAD.
//   - Per-socket message rate limiting with a strike escalation that ends in a close(1008)
//     if the flood persists. See ./ws/frames.js.
//   - Per-user connection cap: the newest connection wins, the oldest open socket is
//     terminated, so reconnect storms cannot pin a user offline. See ./ws/registry.js.
//   - Heartbeat pings every 30s; unresponsive sockets are terminated.

const WebSocket = require('ws');
const db = require('./db');
const { tokenStale, enforced: authEnforced } = require('./middleware/auth');

const createTickets = require('./ws/tickets');
const createRegistry = require('./ws/registry');
const createRooms = require('./ws/rooms');
const createPresence = require('./ws/presence');
const createFrames = require('./ws/frames');

// 200 KB is generous for JSON chat traffic and far too small to buffer abuse.
const MAX_PAYLOAD = parseInt(process.env.WS_MAX_PAYLOAD || '', 10) || 200 * 1024;
const HEARTBEAT_MS = 30 * 1000;

function createGateway(server) {
  const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_PAYLOAD });

  const tickets = createTickets();
  const registry = createRegistry();
  const rooms = createRooms({ registry });
  const presence = createPresence({ registry });
  const frames = createFrames({ rooms, registry });

  // The registry cannot call presence directly without the two importing each other. The
  // gateway owns the wiring, so the dependency runs one way: registry knows a hook
  // exists, presence knows a registry exists, and neither knows about the other.
  registry.setPresenceHooks({
    onFirstOpen: (userId) => presence.announceQuiet(userId, 'online'),
    onLastClose: (userId) => presence.announceQuiet(userId, 'offline'),
  });

  // Reject a handshake before a socket is ever tracked. Returns the claims, or null with
  // the reason already sent as a close frame.
  async function authenticate(ws, params) {
    // Backwards-incompatible on purpose: bearer JWTs never belong in URLs.
    if (params.get('token')) {
      ws.close(1008, 'token auth is not supported');
      return null;
    }
    const ticket = params.get('ticket');
    if (!ticket) {
      ws.close(1008, 'ticket required');
      return null;
    }
    const claims = tickets.consume(ticket);
    if (!claims) {
      ws.close(1008, 'invalid or expired ticket');
      return null;
    }

    if (claims.jti) {
      const revoked = await db.get('SELECT 1 FROM revoked_tokens WHERE jti = ?', [claims.jti]);
      if (revoked) {
        ws.close(1008, 'session revoked');
        return null;
      }
    }
    // Mirror the HTTP layer: tickets issued before a password change or "sign out
    // everywhere" are dead. Socket sessions must never outlive them.
    const row = await db.get(
      'SELECT password_changed_at, sessions_invalidated_at, enforcement_state, enforcement_expires_at,'
      + ' email_verified_at FROM users WHERE id = ?',
      [claims.id]
    );
    if (!row) {
      ws.close(1008, 'user not found');
      return null;
    }
    if (tokenStale(claims, row)) {
      ws.close(1008, 'session revoked');
      return null;
    }
    // A socket cannot open while the account is under enforcement, matching the HTTP gate
    // exactly (same helper, same semantics).
    if (authEnforced(claims, row)) {
      ws.close(1008, 'account enforced');
      return null;
    }
    return { claims, row };
  }

  wss.on('connection', (ws, req) => {
    let params;
    try {
      params = new URL(`ws://${req.headers.host}${req.url}`).searchParams;
    } catch {
      ws.close();
      return;
    }

    authenticate(ws, params).then((auth) => {
      if (!auth) return;
      const { claims: user, row } = auth;

      ws.user = user;
      // Authoritative verification state for this socket. Cached, and re-read on demand
      // by the frame handler, so verifying mid-session unblocks without a reconnect.
      ws.verified = !!row.email_verified_at;
      ws.dmIds = new Set();
      ws.msgTimes = [];
      ws.strikes = 0;
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => { /* avoid an uncaught from racing terminate() */ });

      registry.enforceCap(ws, user.id);
      registry.trackOpen(ws, user.id);

      ws.on('close', () => {
        rooms.leaveRoom(ws);
        rooms.leaveServerRoom(ws);
        registry.trackClose(ws, user.id);
      });

      ws.on('message', (raw) => {
        if (!frames.admitFrame(ws, Date.now())) return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        frames.dispatch(ws, user, data).catch(() => { /* malformed payload: ignore */ });
      });
    }).catch(() => ws.close());
  });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Heartbeat: sockets that miss a ping/pong round are dead weight. The interval is
  // unref'd so it never keeps the process alive on its own.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
      if (c.isAlive === false) {
        try { c.terminate(); } catch { /* already gone */ }
        return;
      }
      c.isAlive = false;
      try { c.ping(); } catch { c.terminate(); }
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    broadcast: rooms.broadcast,
    broadcastDm: rooms.broadcastDm,
    broadcastServer: rooms.broadcastServer,
    sendToUser: registry.sendToUser,
    isOnline: registry.isOnline,
    getPresence: registry.getPresence,
    issueTicket: tickets.issue,
    disconnectUser: registry.disconnectUser,
    evictUserFromServer: rooms.evictUserFromServer,
    invalidateMembers: rooms.invalidateMembers,
  };
}

module.exports = createGateway;
