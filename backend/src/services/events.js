// One place for realtime fan-out, so routes never touch sockets directly.
// Wired once from server.js.
//
// Two scopes. `emit` goes to everyone in a community; `emitTo` goes to one
// person's own sockets.
let gateway = {
  broadcast: () => {}, broadcastChannel: () => {}, sendToUser: () => {},
  evict: () => {}, invalidate: () => {},
};

function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

// Swallowed deliberately: a dropped realtime event is bad, a failed write
// because realtime blew up is worse.
function emit(serverId, type, payload) {
  try {
    gateway.broadcast(String(serverId), Object.assign({ type }, payload));
  } catch { /* ignore */ }
}

// Channel-scoped counterpart of emit(), for anything that happens inside a
// channel - a message, a deletion, an embed arriving. The server-room path above
// is for structural changes that belong to no single channel, and a message
// posted by an application is the same message a user would post, so it takes
// the same room.
//
// A separate gateway entry rather than a reused broadcast(), because the two
// have different arities: calling the server-room one with three arguments
// silently ships the channel id to every member as the payload.
function emitChannel(serverId, channelId, payload) {
  try {
    gateway.broadcastChannel(String(serverId), String(channelId), payload);
  } catch { /* ignore */ }
}

// Includes the socket that made the change. It already applied its own answer,
// so getting the event back is the cheapest proof the two agree - and a client
// that dropped the echo would hide exactly the disagreement we'd want to see.
//
// Payload is the caller's to keep safe: for an account event that means nothing
// about anyone but the account holder.
function emitTo(userId, type, payload) {
  if (!userId) return;
  try {
    gateway.sendToUser(String(userId), Object.assign({ type }, payload));
  } catch { /* ignore */ }
}

// Needed after any server_members write, or a kicked member keeps receiving that
// community's events until the membership cache expires.
function invalidateMembership(serverId) {
  try {
    gateway.invalidate(serverId === undefined ? undefined : String(serverId));
  } catch { /* ignore */ }
}

// Kick / ban / leave. A removed member has to stop receiving that community's
// events immediately, not when the membership cache happens to expire.
function evict(serverId, userId, reason) {
  invalidateMembership(serverId);
  try {
    gateway.evict(String(serverId), String(userId), reason);
  } catch { /* ignore */ }
}

module.exports = { setGateway, emit, emitChannel, emitTo, evict, invalidateMembership };
