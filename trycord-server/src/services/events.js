// Community event bus: the single fan-out point for server-scoped
// mutations (members, roles, channels, categories, invites, settings).
// Wired once in server.js to the WebSocket gateway; services emit here so
// routes never touch sockets directly, and there is exactly one realtime
// protocol for community state (no parallel systems).
let gateway = { broadcast: () => {}, evict: () => {}, invalidate: () => {} };

function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

// Fan out a typed event to a server's room. Realtime delivery must never
// break the underlying mutation, so emission failures are swallowed.
function emit(serverId, type, payload) {
  try {
    gateway.broadcast(String(serverId), Object.assign({ type }, payload));
  } catch { /* ignore */ }
}

// Drop the gateway's memoised membership for a community. Required after any
// change to server_members: without it a kicked member would keep receiving
// that community's events until the cache window expired, which is the exact
// leak the membership re-check exists to prevent.
function invalidateMembership(serverId) {
  try {
    gateway.invalidate(serverId === undefined ? undefined : String(serverId));
  } catch { /* ignore */ }
}

// Remove a user's sockets from a server's rooms (kick/ban/leave): a
// removed member must stop receiving that community's events immediately.
function evict(serverId, userId, reason) {
  invalidateMembership(serverId);
  try {
    gateway.evict(String(serverId), String(userId), reason);
  } catch { /* ignore */ }
}

module.exports = { setGateway, emit, evict, invalidateMembership };
