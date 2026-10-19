// Conversation keys: one key per conversation, sealed to each member
// device, and rekeyed whenever the membership changes.
//
// The server holds the conversation's key in the only form it can hold:
// sealed, one seal per member device. A member device opens its own seal
// with its identity key and gets the key; nobody else can, including the
// server and including the other members.
//
// A membership change mints a new epoch and a new key. The seals of the
// previous epoch are kept rather than deleted, because a device that has
// not caught up has to be told which epoch it is missing - a client that
// simply found nothing would have no way to tell a new conversation from a
// key it was not given.

'use strict';

const db = require('../../db');
const { now } = require('../../clock');
const events = require('../events');
const { E2EE_EVENTS } = require('./eventNames');
const { protocolError } = require('./envelope');
const protocol = require('./protocol');
const membership = require('./membership');
const devices = require('./devices');
const sql = require('./sql');

/** The conversation's current epoch, or 0 when it has no key yet. */
async function currentEpoch(conversationId) {
  const row = await db.get('SELECT epoch FROM e2ee_group_sessions WHERE id = ?', [conversationId]);
  return row ? Number(row.epoch) || 0 : 0;
}

/** The newest epoch each device holds a key for. */
async function deviceEpochs(conversationId) {
  const rows = await db.all(
    'SELECT device_id, MAX(epoch) AS epoch FROM e2ee_group_keys WHERE conversation_id = ? GROUP BY device_id',
    [conversationId]
  );
  const out = {};
  for (const row of rows) out[row.device_id] = Number(row.epoch) || 0;
  return out;
}

/** The seal a device holds for the conversation's current epoch. */
async function sealForDevice(conversationId, deviceId) {
  const epoch = await currentEpoch(conversationId);
  if (!epoch) return null;
  const row = await db.get(
    'SELECT sealed_key FROM e2ee_group_keys WHERE conversation_id = ? AND device_id = ? AND epoch = ?',
    [conversationId, deviceId, epoch]
  );
  if (!row) return null;
  return { epoch, seal: JSON.parse(row.sealed_key) };
}

/**
 * Publish a conversation key.
 *
 * The caller is one of the members, and it seals the key to the devices it
 * names. The server does not choose the recipients: it records the seals
 * and refuses a key published for a device that is not in the conversation,
 * because a seal for a stranger is a key the stranger did not ask for.
 */
async function publishKey(conversationId, userId, deviceId, input) {
  const group = await membership.requireMembership(conversationId, userId);
  const epoch = Number(input.epoch);
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a conversation key needs an epoch', 400);
  }
  const existing = await currentEpoch(conversationId);
  if (epoch < existing) {
    throw protocolError('E2EE_CONFLICT', 'this conversation is already at epoch ' + existing, 409);
  }
  const seals = Array.isArray(input.sealedKeys) ? input.sealedKeys : [];
  if (!seals.length) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a conversation key needs at least one sealed copy', 400);
  }
  const memberUserIds = new Set(group.userIds);
  for (const entry of seals) {
    const device = await devices.get(entry.deviceId);
    if (!device) {
      throw protocolError('E2EE_VALIDATION_ERROR', 'unknown device in the sealed key list', 400);
    }
    if (!memberUserIds.has(device.user_id)) {
      throw protocolError('E2EE_FORBIDDEN', 'a device outside the conversation cannot be given the key', 403);
    }
    if (device.revoked_at) {
      throw protocolError('E2EE_DEVICE_REVOKED', 'a revoked device cannot be given the key', 403);
    }
  }

  const timestamp = now();
  const keyUpsert = sql.upsert(
    'e2ee_group_keys',
    ['conversation_id', 'device_id', 'epoch', 'sealed_key', 'created_at'],
    ['conversation_id', 'device_id', 'epoch'],
    { sealed_key: sql.proposed('sealed_key') }
  );
  const sessionUpsert = sql.upsert(
    'e2ee_group_sessions',
    ['id', 'epoch', 'created_by', 'created_at', 'updated_at'],
    ['id'],
    { epoch: sql.proposed('epoch'), updated_at: sql.proposed('updated_at') }
  );
  await db.transaction(async (t) => {
    for (const entry of seals) {
      await t.run(keyUpsert, [
        conversationId, entry.deviceId, epoch, JSON.stringify(entry.seal || entry), timestamp,
      ]);
    }
    await t.run(sessionUpsert, [conversationId, epoch, userId, timestamp, timestamp]);
  });

  // Everybody in the conversation is told, so the devices that were not
  // given the key know to ask for it.
  for (const memberId of group.userIds) {
    events.emitTo(memberId, E2EE_EVENTS.KEY_CHANGE, {
      conversationId,
      epoch,
      changed: epoch !== existing,
    });
  }

  return { conversationId, epoch, devices: seals.map((s) => s.deviceId) };
}

/** The conversation's key material for one device. */
async function keyForDevice(conversationId, deviceId) {
  const found = await sealForDevice(conversationId, deviceId);
  if (!found) return { conversationId, epoch: await currentEpoch(conversationId), seal: null };
  return { conversationId, epoch: found.epoch, seal: found.seal };
}

/**
 * The associated data a conversation key seal is bound to.
 *
 * The client seals and opens with exactly these bytes, so a seal cannot be
 * moved to another conversation or replayed under an earlier epoch.
 */
function sealAad(conversationId, epoch) {
  return protocol.canonical(
    ['context', protocol.GROUP_SEAL_INFO],
    ['conversation', conversationId],
    ['epoch', epoch]
  );
}

module.exports = {
  currentEpoch,
  deviceEpochs,
  sealForDevice,
  publishKey,
  keyForDevice,
  sealAad,
};
