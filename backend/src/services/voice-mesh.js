// In-house WebRTC mesh for small voice rooms.
//
// This is the self-hosted first-party media path: no SFU, no Cloudflare, no
// external media service. Audio flows directly peer-to-peer (browser DTLS/SRTP)
// and Trycord's server is only the signaling and room-coordination boundary.
//
// Limits: mesh scales as O(N^2) packet streams, so the room is capped. The cap
// is a setting now - voice.mesh.maxParticipants - and the default of six keeps
// CPU and bandwidth predictable on a Raspberry Pi-class host. For larger rooms
// (or one-to-many stage scenarios) an operator points the instance at an SFU.
//
// The room itself is in memory: it belongs to this process and to nobody else.
// The database holds who is in the channel and which provider carries them, so
// a restart does not leave a room that says it is full.
const { now, uuid } = require('../util');
const voice = require('./voice');
const voiceConfig = require('./voice/config');

// The default size of a mesh room. The setting can lower it or raise it; this
// is what a fresh instance runs with.
const MESH_MAX = 6;

// room state keyed by channelId
const rooms = new Map(); // channelId -> Map<userId, session>

function roomOf(channelId) { return rooms.get(String(channelId)); }
function roomMut(channelId) {
  const key = String(channelId);
  if (!rooms.has(key)) rooms.set(key, new Map());
  return rooms.get(key);
}

// The permission question, asked of the same place every other provider asks
// it. The mesh used to answer it on its own and could not: it called a
// permission helper that does not exist, and the failure was treated as a
// yes - so anybody who could reach the route could sit in a channel they had
// no right to be in.
async function authorize(userId, channelId) {
  const verdict = await voice.authorizeVoice(channelId, userId);
  if (!verdict.ok) return verdict;
  return { ok: true, channel: verdict.channel, serverId: verdict.channel.server_id };
}

// Whether this process holds a room for the channel.
//
// The mesh keeps its rooms in memory, so a room that is empty in memory but
// full in the database is a room left behind by a previous run of the process.
function hasRoom(channelId) {
  const room = roomOf(channelId);
  return !!room && room.size > 0;
}

// The seat in this room, or null.
//
// The caller has already asked whether the person may join: the permission
// checks and the participant limit are the same for every provider, and they
// are asked of Trycord's own data before a session is created.
async function join(channelId, userId) {
  const room = roomMut(channelId);
  const limit = voiceConfig.limit('mesh');
  if (room.size >= limit) {
    return {
      ok: false,
      code: 'CAPACITY_EXCEEDED',
      message: 'This mesh room holds ' + limit + ' participants; the media travels between all of them',
      status: 429,
    };
  }

  const session = { userId, joinedAt: now(), sessionId: uuid() };
  room.set(userId, session);
  const otherIds = Array.from(room.keys()).filter((id) => String(id) !== String(userId));
  return {
    ok: true,
    sessionId: session.sessionId,
    participants: otherIds,
    iceServers: iceServers(userId),
    maxParticipants: limit,
  };
}

// The seat is gone. The roster the database holds is cleared with it.
async function leave(channelId, userId) {
  const room = roomOf(channelId);
  if (room) room.delete(userId);
  await voice.endParticipant(channelId, userId);
  return { ok: true };
}

async function participants(channelId) {
  const room = roomOf(channelId);
  const ids = room ? Array.from(room.keys()) : [];
  return { ok: true, participants: ids, count: ids.length };
}

// Relay a signaling message between two peers. The server is never in the media path.
function relay(channelId, fromUserId, toUserId, kind, payload) {
  const room = roomOf(channelId);
  if (!room || !room.has(fromUserId) || !room.has(toUserId)) return false;
  // Emitted through the realtime gateway which owns the sockets.
  if (global.voiceRelayBridge) {
    try { global.voiceRelayBridge.sendToUser(String(toUserId), { type: 'voice.mesh.' + kind, channelId: String(channelId), from: String(fromUserId), payload }); } catch {}
  }
  return true;
}

function cleanupChannel(channelId) {
  const r = roomOf(channelId);
  if (r) r.clear();
  rooms.delete(channelId);
}

function cleanupUser(userId) {
  for (const [chId, room] of rooms.entries()) {
    if (room.has(userId)) {
      room.delete(userId);
      // The roster the database holds follows the seat out of the room.
      voice.endParticipant(chId, userId).catch((error) => {
        console.error('[voice] could not clear a voice participant', (error && error.message) || error);
      });
    }
    if (room.size === 0) rooms.delete(chId);
  }
}

// The ICE servers the peers are given.
//
// With nothing configured the instance's own relay is used: the instance ships
// a STUN and TURN server, so an operator should not have to write down the
// address of a server the instance already runs. The credential that goes with
// it is minted here, for this caller, and is never part of an answer that
// everybody receives.
function iceServers(userId) {
  return voiceConfig.iceServers('mesh', { credentials: true, userId });
}

// The state of this room as the mesh knows it.
async function roomState(channelId) {
  const room = roomOf(channelId);
  const seats = room ? Array.from(room.entries()) : [];
  return {
    provider: 'mesh',
    participants: seats.map(([userId, session]) => ({
      userId,
      sessionId: session.sessionId,
      joinedAt: session.joinedAt,
    })),
    count: seats.length,
  };
}

module.exports = {
  MESH_MAX,
  authorize,
  hasRoom,
  join,
  leave,
  participants,
  relay,
  cleanupChannel,
  cleanupUser,
  iceServers,
  roomState,
};
