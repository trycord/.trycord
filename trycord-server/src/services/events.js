// Community and account event bus: the single fan-out point for mutations that
// other clients have to learn about. Wired once in server.js to the WebSocket
// gateway; services and routes emit here so they never touch sockets directly,
// and there is exactly one realtime protocol (no parallel systems).
//
// Two scopes, because they answer different questions. A community event goes to
// everyone in that community and is about shared state - a channel, a role, a
// membership. An account event goes to one person's own sockets and is about
// their own account: a preference changed here and on their phone, a session
// revoked from elsewhere, two-factor turned on. Account events carry nothing
// about anyone else - a session revocation is the extreme case where the
// listener must be told something they would otherwise not know.
let gateway = { broadcast: () => {}, sendToUser: () => {}, evict: () => {}, invalidate: () => {} };

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

/**
 * Fan out to every socket a person has open, including the one that made the
 * change.
 *
 * Including the origin is deliberate. The client that issued the write has
 * already applied its own answer, so an event arriving back for the same write
 * is the cheapest available proof that the server's idea and the client's idea
 * agree. A client that suppressed the echo would hide exactly the disagreement
 * this exists to expose.
 *
 * The payload is the caller's, so it must already exclude anything the listener
 * is not entitled to - which for an account event is everything except the
 * account holder.
 */
function emitTo(userId, type, payload) {
  if (!userId) return;
  try {
    gateway.sendToUser(String(userId), Object.assign({ type }, payload));
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

module.exports = { setGateway, emit, emitTo, evict, invalidateMembership };
