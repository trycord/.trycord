// The E2EE subsystem, as the API sees it.
//
// The modules underneath do the work; this file is the list of operations
// the HTTP layer is allowed to perform, and it is where the realtime
// notifications are sent from. A route that reaches past this file is
// reaching past the contract.
//
// The notifications are the same three names the gateway will carry:
//
//   e2ee:device         a device appeared or was revoked
//   e2ee:key-change     a conversation key was published or rekeyed
//   e2ee:safety-number  the safety number for a peer changed

'use strict';

const events = require('../events');
const db = require('../../db');
const { E2EE_EVENTS } = require('./eventNames');
const { protocolError } = require('./envelope');

const devices = require('./devices');
const prekeys = require('./prekeys');
const sessions = require('./sessions');
const group = require('./group');
const attachments = require('./attachments');
const recovery = require('./recovery');
const status = require('./status');
const membership = require('./membership');
const bodies = require('./bodies');

/** Register a device and tell the account's other devices about it. */
async function registerDevice(userId, input) {
  const device = await devices.register(userId, input);
  events.emitTo(userId, E2EE_EVENTS.DEVICE, {
    deviceId: device.id,
    action: 'registered',
    label: device.label,
  });
  events.emitTo(userId, E2EE_EVENTS.SAFETY_NUMBER, {
    deviceId: device.id,
    action: 'registered',
  });
  return device;
}

/** Every device of the caller's account. */
async function listDevices(userId) {
  return devices.listForUser(userId);
}

/**
 * Revoke a device.
 *
 * The device's prekeys are deleted, its sessions are marked dead, and the
 * account is told, because every other device of that account has to
 * rekey whatever it shared with the lost one.
 */
async function revokeDevice(userId, deviceId) {
  const device = await devices.revoke(userId, deviceId);
  events.emitTo(userId, E2EE_EVENTS.DEVICE, {
    deviceId: device.id,
    action: 'revoked',
    label: device.label,
  });
  events.emitTo(userId, E2EE_EVENTS.SAFETY_NUMBER, {
    deviceId: device.id,
    action: 'revoked',
  });
  return device;
}

/** Publish a prekey bundle. */
async function publishPrekeys(userId, deviceId, input) {
  const result = await prekeys.publish(userId, deviceId, input);
  events.emitTo(userId, E2EE_EVENTS.KEY_CHANGE, {
    deviceId,
    action: 'prekeys-published',
    availablePreKeys: result.availablePreKeys,
  });
  return result;
}

/**
 * Tell the members of a community that its conversation key has to move.
 *
 * A membership change means the devices sealed at the current epoch no
 * longer match the member devices: somebody arrived, or somebody left, and
 * the group the key was shared with is not the group it is now. The devices
 * that are still members have to be told, or they keep using a key the group
 * no longer shares.
 *
 * This is a **notification**, not a rekey. The server cannot reseal the key —
 * it holds no conversation key — so it tells the members, and a member's
 * client fetches the new key and seals it for the devices that need it.
 *
 * A community with no published key has nothing to move, and asking about it
 * would be a query per member for nothing.
 */
async function announceKeyChange(serverId, reason) {
  const rows = await db.all(
    'SELECT id FROM e2ee_group_sessions WHERE id = ?',
    [serverId]
  );
  if (!rows.length) return { notified: 0 };

  // The members of the community. A member with no registered device has
  // nothing to rekey, so it is not told.
  const devices = await db.all(
    'SELECT user_id FROM e2ee_devices WHERE user_id IN (SELECT user_id FROM server_members WHERE server_id = ?)',
    [serverId]
  );
  const userIds = [...new Set(devices.map((d) => d.user_id))];
  for (const userId of userIds) {
    events.emitTo(userId, E2EE_EVENTS.KEY_CHANGE, {
      conversationId: serverId,
      action: 'membership-changed',
      reason: reason || 'membership',
    });
  }
  return { notified: userIds.length };
}

/** Take a peer's prekey bundle, consuming a one-time prekey. */
async function fetchPrekeyBundle(deviceId) {
  return prekeys.fetchBundle(deviceId);
}

/**
 * Claim a one-time prekey for a session.
 *
 * The responder claims the prekey the initiator used, so the same prekey
 * cannot start a second session.
 */
async function claimPrekey(userId, deviceId, prekeyId) {
  return prekeys.claim(userId, deviceId, prekeyId);
}

/** Put a prekey the server consumed but that no session used back. */
async function releasePrekeys(userId, deviceId) {
  return prekeys.releaseUnclaimed(userId, deviceId);
}

/** Record a session the client has established. */
async function createSession(userId, input) {
  if (!input.deviceId) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a session names the device it belongs to', 400);
  }
  await devices.owned(userId, input.deviceId);
  if (!input.peerDeviceId) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a session names the device it is with', 400);
  }
  if (!(await devices.get(input.peerDeviceId))) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'no such peer device', 400);
  }
  return sessions.create({
    id: input.id,
    userId,
    deviceId: input.deviceId,
    peerDeviceId: input.peerDeviceId,
    peerUserId: input.peerUserId,
    conversationId: input.conversationId,
    ratchetState: input.ratchetState,
    sendCounter: input.sendCounter,
    recvCounter: input.recvCounter,
  });
}

/** A session of the caller's own, with its sealed ratchet state. */
async function getSession(userId, sessionId) {
  return sessions.get(userId, sessionId);
}

/** Every session of one of the caller's devices. */
async function listSessions(userId, deviceId) {
  await devices.owned(userId, deviceId);
  return sessions.listForDevice(userId, deviceId);
}

/** Store the new ratchet state after a message. */
async function updateSession(userId, sessionId, input) {
  return sessions.update(userId, sessionId, input);
}

/** End a session. */
async function closeSession(userId, sessionId) {
  return sessions.markDead(userId, sessionId);
}

/** Publish a conversation key, sealed to each member device. */
async function publishConversationKey(userId, input) {
  const result = await group.publishKey(input.conversationId, userId, input.deviceId, input);
  return result;
}

/** The conversation key material for one of the caller's own devices. */
async function conversationKey(userId, conversationId, deviceId) {
  await devices.owned(userId, deviceId);
  await membership.requireMembership(conversationId, userId);
  return group.keyForDevice(conversationId, deviceId);
}

/** The encryption state of a conversation, as it actually is. */
async function conversationState(userId, conversationId) {
  return status.conversationState(conversationId, userId);
}

/**
 * Whether a conversation is encrypted, for a write that has to know.
 *
 * The answer is the status service's: whether a conversation is encrypted
 * is a fact about the keys its member devices hold, and nothing a client
 * says in a request body can change it.
 */
async function conversationEncryption(userId, conversationId) {
  return status.encryptionSummary(conversationId, userId);
}

/**
 * Check a message body against the conversation it is going into.
 *
 * In an encrypted conversation the body has to be an envelope, and a body
 * the server cannot validate is refused: there is no plaintext path into an
 * encrypted conversation and no "store it as a link" path out of one. In a
 * conversation that is not encrypted the body is text and it is stored the
 * way it always was.
 */
async function acceptMessageBody(userId, conversationId, body) {
  return bodies.accept(conversationId, userId, body);
}

/**
 * What a stored message body holds.
 *
 * A stored body is either an envelope or text, and this says which.
 */
function readMessageBody(text) {
  return bodies.readStored(text);
}

/**
 * Mark a stored message row: an envelope row says it is one, and carries no
 * text.
 */
function shapeMessage(row) {
  return bodies.applyToRow(row);
}

/** Record an encrypted attachment and its sealed key material. */
async function registerAttachment(userId, input) {
  return attachments.register(userId, input);
}

/**
 * Store an encrypted attachment: the ciphertext, and the key sealed to each
 * member device.
 *
 * The key is never sent to the server. There is no field for it.
 */
async function storeEncryptedAttachment(userId, input) {
  return attachments.store(userId, input);
}

/** An encrypted attachment, with the seals belonging to the caller's devices. */
async function attachment(userId, attachmentId) {
  return attachments.get(userId, attachmentId);
}

/** Store an encrypted key backup. */
async function saveBackup(userId, input) {
  return recovery.saveBackup(userId, input);
}

/** The caller's encrypted key backup. */
async function fetchBackup(userId) {
  return recovery.getBackup(userId);
}

/** Recover a device from the one that was lost. */
async function recoverDevice(userId, input) {
  const result = await recovery.recover(userId, input);
  events.emitTo(userId, E2EE_EVENTS.DEVICE, {
    deviceId: result.device.id,
    action: 'recovered',
    label: result.device.label,
    recoveredFrom: result.recoveredFrom,
  });
  return result;
}

/** The safety number for a peer. */
async function safetyNumber(userId, peerUserId) {
  return status.safetyNumber(userId, peerUserId);
}

module.exports = {
  E2EE_EVENTS,
  devices,
  registerDevice,
  listDevices,
  revokeDevice,
  publishPrekeys,
  fetchPrekeyBundle,
  claimPrekey,
  releasePrekeys,
  createSession,
  getSession,
  listSessions,
  updateSession,
  closeSession,
  publishConversationKey,
  conversationKey,
  conversationState,
  conversationEncryption,
  announceKeyChange,
  acceptMessageBody,
  readMessageBody,
  shapeMessage,
  registerAttachment,
  storeEncryptedAttachment,
  attachment,
  saveBackup,
  fetchBackup,
  recoverDevice,
  safetyNumber,
};
