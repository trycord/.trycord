// Conversation keys: one key per conversation, sealed to each member device,
// and rekeyed whenever the membership changes.
//
// The server holds the conversation's key in the only form it can hold:
// sealed, one seal per member device. A member device opens its own seal
// with its identity key and gets the key; nobody else can, including the
// server and including the other members.
//
// A membership change mints a new epoch and a new key. The seals of the
// previous epoch are kept rather than deleted, because a device that has not
// caught up has to be told which epoch it is missing - a client that simply
// found nothing would have no way to tell a new conversation from a key it
// was not given.
//
// The epoch is what the server enforces: a key published again at the epoch
// that is already current has to be sealed to the same set of devices, so a
// member who left - and still holds the key they were given - is only cut
// off when the epoch moves.

import { randomBytes, b64, unb64 } from './bytes.js';
import { seal, open } from './sealing.js';
import { canonical, GROUP_SEAL_INFO } from './protocol.js';

/**
 * The associated data a conversation key seal is bound to.
 *
 * The client seals and opens with exactly these bytes, so a seal cannot be
 * moved to another conversation or replayed under an earlier epoch.
 */
export function sealAad(conversationId, epoch) {
  return canonical(
    ['context', GROUP_SEAL_INFO],
    ['conversation', conversationId],
    ['epoch', epoch],
  );
}

/**
 * Seal a conversation key to one device.
 *
 * @param {Uint8Array} key  the conversation key
 * @param {string} deviceId  the device the key is for
 * @param {string} identityDhPublic  the device's X25519 identity public key
 */
export async function sealForDevice(key, deviceId, identityDhPublic, conversationId, epoch) {
  const sealValue = await seal(
    key,
    unb64(identityDhPublic),
    sealAad(conversationId, epoch),
    GROUP_SEAL_INFO,
  );
  return { deviceId, seal: sealValue };
}

/**
 * Open a conversation key seal with the device's own identity key.
 */
export function openForDevice(sealValue, device, conversationId, epoch) {
  return open(
    sealValue,
    device.keys.ik.privateKey,
    device.keys.ik.publicKey,
    sealAad(conversationId, epoch),
    GROUP_SEAL_INFO,
  );
}

/** A fresh conversation key. */
export function newConversationKey() {
  return randomBytes(32);
}

/**
 * Publish a conversation key, sealed to the devices that are in the
 * conversation now.
 *
 * The epoch is the server's to police: a key published at an epoch that is
 * already current has to be sealed to the same devices, and one published
 * below the current one is refused. So a rekey is a new epoch.
 *
 * @param {object} deps { api, device, peerKeys }
 * @param {object} options { conversationId, epoch, memberDevices }
 */
export async function publishKey(deps, options) {
  const key = newConversationKey();
  const sealedKeys = [];
  for (const member of options.memberDevices) {
    const keys = await deps.peerKeys(member.deviceId);
    sealedKeys.push(await sealForDevice(
      key,
      member.deviceId,
      keys.identityDhKey,
      options.conversationId,
      options.epoch,
    ));
  }
  const result = await deps.api.publishConversationKey(options.conversationId, {
    deviceId: deps.device.id,
    epoch: options.epoch,
    sealedKeys,
  });
  return {
    key,
    epoch: options.epoch,
    devices: sealedKeys.map((entry) => entry.deviceId),
    result,
  };
}

/**
 * The conversation key this device holds, if it holds one.
 *
 * @param {object} deps { api, device }
 * @param {object} options { conversationId }
 */
export async function keyForDevice(deps, options) {
  const answer = await deps.api.conversationKey(options.conversationId, deps.device.id);
  if (!answer || !answer.seal) return null;
  const key = await openForDevice(answer.seal, deps.device, options.conversationId, answer.epoch);
  return { key, epoch: answer.epoch };
}

export { b64 };
