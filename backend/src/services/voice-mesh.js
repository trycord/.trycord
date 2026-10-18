// In-house WebRTC mesh for small voice rooms.
//
// This is the self-hosted first-party media path: no SFU, no Cloudflare, no
// external media service. Audio flows directly peer-to-peer (browser DTLS/SRTP)
// and Trycord's server is only the signaling and room-coordination boundary.
//
// Limits: mesh scales as O(N^2) packet streams, so this is intentionally
// capped at MESH_MAX. For larger rooms (or one-to-many stage scenarios)
// operate with a Cloudflare SFU or a dedicated Mediasoup/SFU-style node behind
// a future, honest implementation. The default cap of 6 keeps CPU and bandwidth
// predictable on a Raspberry Pi-class host.
const MESH_MAX = 6;
const { now } = require('../util');
const db = require('../db');
const permissions = require('./permissions');

// room state keyed by channelId
const rooms = new Map(); // channelId -> Map<userId, session>

function roomOf(channelId) { return rooms.get(String(channelId)); }
function roomMut(channelId) {
  const key = String(channelId);
  if (!rooms.has(key)) rooms.set(key, new Map());
  return rooms.get(key);
}

async function authorize(userId, channelId) {
  const channel = await db.get('SELECT id, server_id, type FROM channels WHERE id = ?', [channelId]);
  if (!channel) return { ok: false, code: 'NOT_FOUND', message: 'channel not found', status: 404 };
  const serverId = channel.server_id || channel.serverId;
  if (!serverId) return { ok: false, code: 'NOT_FOUND', message: 'channel not found', status: 404 };
  let canJoin;
  try { canJoin = permissions.can(serverId, userId, 'CONNECT'); } catch { canJoin = true; }
  if (canJoin === false) return { ok: false, code: 'FORBIDDEN', message: 'you cannot join this voice channel', status: 403 };
  return { ok: true, channel, serverId };
}

async function join(channelId, userId) {
  const v = await authorize(userId, channelId);
  if (!v.ok) return v;
  const room = roomMut(channelId);
  if (room.size >= MESH_MAX) {
    return { ok: false, code: 'CAPACITY_EXCEEDED', message: 'mesh room at ' + MESH_MAX + ' participants; use a larger room or SFU', status: 429 };
  }
  const session = { userId, joinedAt: now() };
  room.set(userId, session);
  const otherIds = Array.from(room.keys()).filter((id) => String(id) !== String(userId));
  return { ok: true, participants: otherIds, iceServers: iceServers(), maxParticipants: MESH_MAX };
}

async function leave(channelId, userId) {
  const room = roomOf(channelId);
  if (room) room.delete(userId);
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
    if (room.has(userId)) room.delete(userId);
    if (room.size === 0) rooms.delete(chId);
  }
}

// Operator must supply at least one STUN (and, for restrictive/relay-only scenarios,
// a TURN) endpoint. The truth lives in the configuration centre as before and is read
// through the features module, so a saved change - not only an environment one -
// reaches the peers. An empty list leaves the room joinable but warns the client:
// connections then only form on the same network.
function iceServers() {
  const features = require('../features');
  return features.iceServers(features.current);
}

module.exports = {
  MESH_MAX,
  authorize,
  join,
  leave,
  participants,
  relay,
  cleanupChannel,
  cleanupUser,
  iceServers,
};