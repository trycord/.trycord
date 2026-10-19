// The truth about a conversation's encryption, and the safety number.
//
// The state a conversation reports is computed from the keys that are
// actually held, not from a flag somebody set. A conversation is encrypted
// only when every live member device holds the current key. When some hold
// it and some do not, the answer is "mixed", and a client that says
// "encrypted" there is telling the user something untrue.
//
// The safety number is a fingerprint of the two sides' identity keys. Two
// people who read the same number over a channel they trust have the same
// keys, and a third party who rewrote a bundle in the middle would produce
// a different number. It changes when a device is added or revoked, which
// is exactly when a person should look again.

'use strict';

const primitives = require('./primitives');
const { protocolError } = require('./envelope');
const membership = require('./membership');
const devices = require('./devices');
const group = require('./group');

const ENCRYPTED = 'encrypted';
const NOT_ENCRYPTED = 'not-encrypted';
const MIXED = 'mixed';
const KEY_CHANGED = 'key-changed';

/**
 * The encryption state of a conversation, as it actually is.
 *
 * @param {string} conversationId
 * @param {string} userId the caller
 */
async function conversationState(conversationId, userId) {
  const found = await membership.members(conversationId);
  if (!found) throw protocolError('E2EE_NOT_FOUND', 'no such conversation', 404);
  if (!found.userIds.includes(userId)) {
    throw protocolError('E2EE_FORBIDDEN', 'you are not in this conversation', 403);
  }

  const epoch = await group.currentEpoch(conversationId);
  const epochs = await group.deviceEpochs(conversationId);

  const memberDevices = [];
  for (const memberId of found.userIds) {
    const list = await devices.liveDevicesOf(memberId);
    for (const device of list) {
      const held = epochs[device.id] || 0;
      memberDevices.push({
        deviceId: device.id,
        userId: device.user_id,
        label: device.label,
        hasKey: epoch > 0 && held >= epoch,
        epoch: held,
      });
    }
  }

  const missing = memberDevices.filter((d) => !d.hasKey).map((d) => d.deviceId);
  const outdated = memberDevices
    .filter((d) => d.epoch > 0 && d.epoch < epoch)
    .map((d) => d.deviceId);
  const holders = memberDevices.filter((d) => d.hasKey);
  const mine = memberDevices.filter((d) => d.userId === userId);
  const mineBehind = mine.filter((d) => !d.hasKey);

  let state;
  if (!epoch || holders.length === 0) {
    // No key has been published, or nobody holds it: the conversation is
    // not encrypted for anyone, and saying otherwise would be a lie.
    state = NOT_ENCRYPTED;
  } else if (missing.length === 0) {
    state = ENCRYPTED;
  } else if (mineBehind.length) {
    // The caller's own devices are the ones that have not caught up with
    // the current key: the key changed and they have not rekeyed yet.
    state = KEY_CHANGED;
  } else {
    state = MIXED;
  }

  return {
    conversationId,
    kind: found.kind,
    state,
    encrypted: state === ENCRYPTED,
    epoch,
    memberDevices,
    missingDevices: missing,
    outdatedDevices: outdated,
    holderCount: holders.length,
    deviceCount: memberDevices.length,
  };
}

/**
 * The safety number for a conversation between two people.
 *
 * Sixty digits, in twelve groups of five, derived from the SHA-512 of both
 * sides' identity keys taken in a fixed order. The order is the sorted
 * order of the keys, so the number does not depend on which side is
 * computing it, and a device that joins changes it.
 */
async function safetyNumber(userId, peerUserId) {
  const mine = await devices.liveDevicesOf(userId);
  const theirs = await devices.liveDevicesOf(peerUserId);
  const all = mine.concat(theirs);
  if (!all.length) {
    throw protocolError('E2EE_NOT_FOUND', 'neither account has a device', 404);
  }
  const entries = all
    .map((device) => ({
      userId: device.user_id,
      deviceId: device.id,
      identityKey: device.identity_key,
    }))
    .sort((a, b) => (a.identityKey < b.identityKey ? -1 : a.identityKey > b.identityKey ? 1 : 0));

  const parts = [];
  for (const entry of entries) {
    parts.push(Buffer.from(entry.userId, 'utf8'), Buffer.from([0]));
    parts.push(Buffer.from(entry.deviceId, 'utf8'), Buffer.from([0]));
    parts.push(primitives.unb64(entry.identityKey));
  }
  const digest = primitives.sha512(Buffer.concat(parts));

  // Twelve groups of five decimal digits, the way a person reads a safety
  // number aloud and compares it in blocks.
  const groups = [];
  for (let i = 0; i < 12; i++) {
    const slice = digest.subarray(i * 5, i * 5 + 5);
    groups.push(BigInt('0x' + slice.toString('hex')).toString().padStart(5, '0').slice(-5));
  }
  return {
    userId,
    peerUserId,
    digits: groups.join(''),
    display: groups.join(' '),
    deviceCount: entries.length,
  };
}

module.exports = {
  ENCRYPTED,
  NOT_ENCRYPTED,
  MIXED,
  KEY_CHANGED,
  conversationState,
  safetyNumber,
};
