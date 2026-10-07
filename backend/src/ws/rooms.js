// Room membership and fan-out.
//
// Two kinds of room, because the app has two kinds of event:
//
//   channel rooms - serverId/channelId -> sockets watching that channel. Broadcasts walk
//     the room rather than every connected socket, so one busy channel never taxes people
//     reading a quiet one.
//
//   server rooms - serverId -> sockets that opened that community. Roles, channels,
//     members, invites and settings all change without belonging to any one channel, so
//     there is nowhere else to send them. Joining is membership-gated exactly like a
//     channel join, and delivery re-checks membership per send, so a socket belonging to
//     someone who has since been removed cannot keep receiving events for that community
//     even if the eviction missed it.
//
// Membership in each Map mirrors a field on the socket itself (ws.serverId/ws.channelId,
// ws.serverRoom) under the same delivery rule. The duplication is deliberate: the socket
// fields are what the connection handler reads on close, and keeping one source means a
// join and its matching leave cannot disagree.

const db = require('../db');

// Several structural events fire back to back for the same community - a role change
// updates roles, permissions and the member count - and the delivery check needs the
// membership list each time. Memoised for a moment, not indefinitely: this is not a
// cache with an invalidation scheme, it is a two-second window on a value that is only
// used to decide who not to send to.
const MEMBER_CACHE_MS = 2000;

module.exports = function createRooms({ registry }) {
  const channelRooms = new Map();
  const serverRooms = new Map();
  const memberCache = new Map();

  function roomKey(serverId, channelId) {
    return String(serverId) + '/' + String(channelId);
  }

  function leaveRoom(ws) {
    if (ws.serverId === undefined || ws.channelId === undefined) return;
    const key = roomKey(ws.serverId, ws.channelId);
    const set = channelRooms.get(key);
    if (!set) return;
    set.delete(ws);
    if (!set.size) channelRooms.delete(key);
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
    const set = channelRooms.get(roomKey(serverId, channelId));
    if (!set) return;
    const data = JSON.stringify(payload);
    set.forEach((c) => registry.deliver(c, data));
  }

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
    const key = String(serverId);
    ws.serverRoom = key;
    if (!serverRooms.has(key)) serverRooms.set(key, new Set());
    serverRooms.get(key).add(ws);
  }

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
    const set = serverRooms.get(String(serverId));
    if (!set || !set.size) return;
    let ids;
    try {
      ids = await memberIdsFor(serverId);
    } catch {
      // Cannot confirm membership, so nobody is told. Sending on a guess would leak a
      // community's events to someone just removed from it.
      return;
    }
    const data = JSON.stringify(payload);
    for (const c of [...set]) {
      if (!registry.isOpen(c)) continue;
      if (!c.user) continue;
      if (!ids.has(String(c.user.id))) continue;
      registry.deliver(c, data);
    }
  }

  // Remove one user's sockets from a community's rooms - kick, ban, leave. They stop
  // receiving that community immediately. The socket stays up so other communities and
  // DMs keep working, which is why broadcastServer checks membership per send as well.
  function evictUserFromServer(serverId, userId) {
    const target = String(serverId);
    const who = String(userId);

    const servers = serverRooms.get(target);
    if (servers) {
      for (const c of [...servers]) {
        if (!c.user || String(c.user.id) !== who) continue;
        servers.delete(c);
        if (c.serverRoom !== undefined && String(c.serverRoom) === target) c.serverRoom = undefined;
      }
      if (!servers.size) serverRooms.delete(target);
    }

    const prefix = target + '/';
    for (const [key, room] of [...channelRooms]) {
      if (!key.startsWith(prefix)) continue;
      for (const c of [...room]) {
        if (!c.user || String(c.user.id) !== who) continue;
        room.delete(c);
        if (c.serverId !== undefined && String(c.serverId) === target) {
          c.serverId = undefined;
          c.channelId = undefined;
        }
      }
      if (!room.size) channelRooms.delete(key);
    }
  }

  // DM delivery: every open socket of every participant. Clients dedupe by message id,
  // because the sender's other tabs receive the event too.
  function broadcastDm(memberIds, payload) {
    const data = JSON.stringify(payload);
    const cid = String(payload.conversationId);
    (memberIds || []).forEach((id) => {
      registry.socketsOf(id).forEach((c) => {
        if (c.dmIds && c.dmIds.has(cid)) registry.deliver(c, data);
      });
    });
  }

  return {
    joinRoom,
    leaveRoom,
    broadcast,
    joinServerRoom,
    leaveServerRoom,
    broadcastServer,
    evictUserFromServer,
    broadcastDm,
    invalidateMembers,
    memberIdsFor,
  };
};
