// Sessions: the server's record of a pairwise conversation between two
// devices.
//
// The row holds two things. The ratchet state, sealed under a key derived
// from the session secret - the server stores it and cannot read it, so
// compromising the database does not reveal a conversation. And the counters
// in the clear, because refusing a replayed message is the server's job and
// it cannot do that with a blob it cannot open.
//
// The counters are the server's replay protection. A client pushes its
// state after every message; the send counter has to move forward, so a
// replayed push - the same message offered twice - is refused with a
// conflict instead of being stored as the newest state.

'use strict';

const db = require('../../db');
const { now, uuid } = require('../../clock');
const { protocolError } = require('./envelope');
const devices = require('./devices');

const ACTIVE = 'active';
const DEAD = 'dead';

/** A session row, without the sealed state. */
function shape(row) {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    peerDeviceId: row.peer_device_id,
    peerUserId: row.peer_user_id,
    conversationId: row.conversation_id || null,
    sendCounter: Number(row.send_counter) || 0,
    recvCounter: Number(row.recv_counter) || 0,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Create a session.
 *
 * The client has already run the key agreement; what arrives here is the
 * sealed ratchet state and the counters that go with it.
 */
async function create(input) {
  const id = String(input.id || uuid());
  const timestamp = now();
  const existing = await db.get('SELECT * FROM e2ee_sessions WHERE id = ?', [id]);
  if (existing) {
    if (existing.user_id !== input.userId || existing.device_id !== input.deviceId) {
      throw protocolError('E2EE_FORBIDDEN', 'that session id belongs to somebody else', 403);
    }
    return shape(existing);
  }
  await db.run(
    `INSERT INTO e2ee_sessions
       (id, user_id, device_id, peer_device_id, peer_user_id, conversation_id,
        ratchet_state, send_counter, recv_counter, status, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.userId, input.deviceId, input.peerDeviceId, input.peerUserId || '',
      input.conversationId || null, stateText(input.ratchetState),
      Number(input.sendCounter) || 0, Number(input.recvCounter) || 0,
      ACTIVE, timestamp, timestamp]
  );
  await devices.touch(input.deviceId);
  return shape(await db.get('SELECT * FROM e2ee_sessions WHERE id = ?', [id]));
}

/**
 * The sealed ratchet state as the text the column holds.
 *
 * The blob is opaque to the server: it is ciphertext the client produced,
 * and the server stores it and hands it back without being able to read it.
 */
function stateText(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A session of the caller's own.
 *
 * A session that exists but belongs to somebody else is refused rather than
 * reported as missing: it holds key material, and the answer is that it is
 * not the caller's to have.
 */
async function owned(userId, sessionId) {
  const row = await db.get('SELECT * FROM e2ee_sessions WHERE id = ?', [sessionId]);
  if (!row) throw protocolError('E2EE_NOT_FOUND', 'no such session', 404);
  if (row.user_id !== userId) {
    throw protocolError('E2EE_FORBIDDEN', 'that session belongs to somebody else', 403);
  }
  return row;
}

/** A session with its sealed ratchet state, for its owner. */
async function get(userId, sessionId) {
  const row = await owned(userId, sessionId);
  const out = shape(row);
  out.ratchetState = row.ratchet_state ? parseState(row.ratchet_state) : null;
  return out;
}

/** The sealed state as the client sent it. */
function parseState(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Every session of a device. */
async function listForDevice(userId, deviceId) {
  const rows = await db.all(
    'SELECT * FROM e2ee_sessions WHERE user_id = ? AND device_id = ? ORDER BY created_at DESC',
    [userId, deviceId]
  );
  return rows.map(shape);
}

/**
 * Store the new ratchet state and the counters that go with it.
 *
 * The send counter must move forward. A push that does not is refused: it
 * is either a replay or a state the client has already replaced, and
 * accepting it would move the session backwards to a state an attacker
 * could then rewind.
 */
async function update(userId, sessionId, input) {
  const row = await owned(userId, sessionId);
  const sendCounter = Number(input.sendCounter);
  if (!Number.isInteger(sendCounter) || sendCounter < 0) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the send counter is not a counter', 400);
  }
  if (sendCounter <= Number(row.send_counter)) {
    throw protocolError(
      'E2EE_REPLAY',
      'this session has already reached counter ' + row.send_counter,
      409
    );
  }
  const timestamp = now();
  await db.run(
    `UPDATE e2ee_sessions
        SET ratchet_state = ?, send_counter = ?, recv_counter = ?, status = ?, last_seen_at = ?
      WHERE id = ?`,
    [input.ratchetState ? stateText(input.ratchetState) : row.ratchet_state,
      sendCounter,
      Math.max(Number(input.recvCounter) || 0, Number(row.recv_counter) || 0),
      ACTIVE, timestamp, sessionId]
  );
  await devices.touch(row.device_id);
  return shape(await db.get('SELECT * FROM e2ee_sessions WHERE id = ?', [sessionId]));
}

/** Mark a session dead. Used when a device is revoked or a peer is lost. */
async function markDead(userId, sessionId) {
  await owned(userId, sessionId);
  await db.run("UPDATE e2ee_sessions SET status = ?, last_seen_at = ? WHERE id = ?",
    [DEAD, now(), sessionId]);
  return shape(await db.get('SELECT * FROM e2ee_sessions WHERE id = ?', [sessionId]));
}

/** The sessions a device has with one peer. */
async function findPair(userId, deviceId, peerDeviceId) {
  const row = await db.get(
    `SELECT * FROM e2ee_sessions
      WHERE user_id = ? AND device_id = ? AND peer_device_id = ?
      ORDER BY created_at DESC LIMIT 1`,
    [userId, deviceId, peerDeviceId]
  );
  return row ? shape(row) : null;
}

module.exports = {
  ACTIVE,
  DEAD,
  shape,
  create,
  owned,
  get,
  listForDevice,
  update,
  markDead,
  findPair,
};
