// Who is connected, and how to reach them.
//
// This is the only module that knows a socket exists. Everything else in the gateway
// asks it "is this user online", "send them this", or hands it a socket when one opens
// or closes. Presence is derived from this and nothing else: a user is online exactly
// while at least one of their sockets is open, so there is no second source of truth to
// drift out of step with the first.
//
// It also owns the two limits that protect the process rather than the user - the
// per-user socket cap and the buffered-bytes ceiling - because both are statements about
// a socket's right to keep existing.

const WebSocket = require('ws');

// A socket that stops reading would otherwise buffer frames without bound and stall
// delivery for every other member of its room, since broadcast walks the room
// synchronously. Past this many queued bytes the socket is dropped; clients reconnect
// and resync over HTTP.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// Newest connection wins, so a reconnect storm cannot pin a user offline by holding all
// of their slots.
const MAX_PER_USER_SOCKETS = 8;

module.exports = function createRegistry() {
  // userId -> Set<ws>. The single source of truth for presence.
  const userSockets = new Map();

  // Set by the gateway once presence exists. Kept as a hook rather than a direct call so
  // this module never has to know that presence exists, and so the two cannot import each
  // other into a cycle.
  let onFirstOpen = null;
  let onLastClose = null;

  function socketsOf(userId) {
    return userSockets.get(String(userId)) || new Set();
  }

  function isOpen(ws) {
    return ws.readyState === WebSocket.OPEN;
  }

  function isOnline(userId) {
    const set = userSockets.get(String(userId));
    return !!set && [...set].some(isOpen);
  }

  function getPresence(ids) {
    const out = {};
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      out[String(id)] = isOnline(id) ? 'online' : 'offline';
    });
    return out;
  }

  function deliver(ws, data) {
    if (!isOpen(ws)) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      try { ws.close(1013, 'client too slow'); } catch { /* already gone */ }
      return;
    }
    try { ws.send(data); } catch { /* dead socket: cleaned on close */ }
  }

  function sendToUser(userId, payload) {
    const data = JSON.stringify(payload);
    socketsOf(userId).forEach((c) => deliver(c, data));
  }

  // Cut every live socket for a user - used the instant enforcement lands, so a banned or
  // suspended account cannot keep an existing connection open. A graceful close frame
  // (1008) is sent rather than a hard terminate, so the peer actually observes the
  // reason. Anything stuck is reaped by the heartbeat.
  function disconnectUser(userId, reason) {
    const set = userSockets.get(String(userId));
    if (!set) return;
    [...set].forEach((c) => {
      try { c.close(1008, String(reason || 'session closed')); } catch { /* gone already */ }
    });
  }

  // Enforce the per-user cap by dropping the oldest open socket. Called before tracking,
  // so the cap is never briefly exceeded.
  function enforceCap(ws, userId) {
    const key = String(userId);
    if (!userSockets.has(key)) userSockets.set(key, new Set());
    const set = userSockets.get(key);
    const others = [...set].filter((c) => c !== ws && isOpen(c));
    if (others.length < MAX_PER_USER_SOCKETS) return;
    try { others[0].terminate(); } catch { /* gone already */ }
  }

  // `first` is only true when this socket is the user's *first* live one, and it is what
  // presence hangs its online announcement on. A user with four tabs open is one online
  // user, not four.
  function trackOpen(ws, userId) {
    const key = String(userId);
    if (!userSockets.has(key)) userSockets.set(key, new Set());
    const first = ![...userSockets.get(key)].some((c) => c !== ws && isOpen(c));
    userSockets.get(key).add(ws);
    if (first && onFirstOpen) onFirstOpen(key);
  }

  function trackClose(ws, userId) {
    const key = String(userId);
    const set = userSockets.get(key);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      userSockets.delete(key);
      if (onLastClose) onLastClose(key);
    }
  }

  return {
    socketsOf,
    isOpen,
    isOnline,
    getPresence,
    deliver,
    sendToUser,
    disconnectUser,
    enforceCap,
    trackOpen,
    trackClose,
    setPresenceHooks(hooks) {
      onFirstOpen = hooks.onFirstOpen || null;
      onLastClose = hooks.onLastClose || null;
    },
    maxPerUserSockets: MAX_PER_USER_SOCKETS,
  };
};
