// Recovery and key backup.
//
// A device's private material is sealed under a key derived from the account
// holder's recovery key. The server stores the sealed blob and cannot open
// it, because the recovery key never reaches the server - not when the blob
// is stored, and not when it is recovered.
//
// Recovery therefore works by proof rather than by surrender:
//
//   1. The holder of the recovery key opens the sealed blob locally, with
//      the recovery key, on their own machine.
//   2. They generate a NEW device identity - new keys, new fingerprint -
//      and sign a recovery statement with the OLD device's identity key.
//   3. They present that signature to the server.
//
// The server checks the signature against the old device's published
// identity key, which is public data. It never sees the recovery key, never
// sees the old private key, and never sees the new private key: it receives
// the new public keys and the new sealed blob.
//
// The new device is a new device. It does not take the old device's
// identity, so recovering does not silently hand anybody the ability to
// speak as the lost device - the lost device's key is still lost, and the
// old device can be revoked once the new one is in place.

import { b64, unb64, utf8, fromUtf8 } from './bytes.js';
import { sign } from './primitives.js';
import { canonical, PROTOCOL_VERSION, RECOVERY_PROOF_CONTEXT, RECOVERY_WRAP_INFO } from './protocol.js';
import { deriveWrappingKey, privateKeySet, restoreKeySet } from './deviceKeys.js';
import { encrypt, decrypt, randomBytes, GCM_IV_BYTES } from './primitives.js';
import { RECOVERY_PBKDF2_ITERATIONS, RECOVERY_SALT_BYTES } from './protocol.js';

/**
 * The bytes the old device signs to prove it can be recovered.
 *
 * The statement names the account and the new device, so a signature cannot
 * be lifted from one recovery and used for another.
 */
export function proofBytes(userId, sourceDeviceId, newDeviceId) {
  return canonical(
    ['context', RECOVERY_PROOF_CONTEXT],
    ['version', PROTOCOL_VERSION],
    ['user', userId],
    ['source', sourceDeviceId],
    ['device', newDeviceId],
  );
}

/**
 * Seal the account's key material under the recovery key.
 *
 * The blob holds the device's private halves and the secrets of the sessions
 * the device holds, so a device that is recovered can carry on with the
 * conversations it was in. The server keeps the blob and cannot open it.
 *
 * @param {object} material { keys, sessions }
 * @param {string} recoveryKey
 */
export async function sealBackup(material, recoveryKey, options = {}) {
  const salt = options.salt ? unb64(options.salt) : randomBytes(RECOVERY_SALT_BYTES);
  const iterations = Number(options.iterations) || RECOVERY_PBKDF2_ITERATIONS;
  const wrappingKey = await deriveWrappingKey(recoveryKey, salt, iterations);
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = await encrypt(
    wrappingKey,
    iv,
    utf8(JSON.stringify(material)),
    utf8(RECOVERY_WRAP_INFO),
  );
  return {
    salt: b64(salt),
    iterations,
    iv: b64(sealed.iv),
    ciphertext: b64(sealed.ciphertext),
    tag: b64(sealed.tag),
  };
}

/**
 * Open a key backup.
 *
 * Throws when the recovery key is wrong: the tag does not verify, and that is
 * the answer.
 */
export async function openBackup(blob, recoveryKey) {
  const wrappingKey = await deriveWrappingKey(recoveryKey, unb64(blob.salt), blob.iterations);
  const plaintext = await decrypt(
    wrappingKey,
    unb64(blob.iv),
    unb64(blob.ciphertext),
    unb64(blob.tag),
    utf8(RECOVERY_WRAP_INFO),
  );
  const material = JSON.parse(fromUtf8(plaintext));
  if (!material || typeof material !== 'object') {
    throw new Error('the key backup does not hold what it should');
  }
  return material;
}

/** The material a backup holds, in the shape the backup expects. */
export function backupMaterial(device, sessions) {
  const secrets = {};
  for (const session of sessions || []) {
    secrets[session.id] = session.secret;
  }
  return {
    keys: privateKeySet(device.keys),
    sessions: secrets,
    deviceId: device.id,
  };
}

/** The device a backup holds, restored from its halves. */
export function deviceFromBackup(material) {
  return restoreKeySet(material.keys);
}

/**
 * Recover a device from the one that was lost.
 *
 * The proof is a signature by the source device's identity key over the
 * recovery statement. The new device's own keys are new: a recovered device
 * that kept the old identity would be the old device wearing a new label.
 *
 * @param {object} deps { api }
 * @param {object} options { userId, sourceDeviceId, sourceKeys, newDevice }
 */
export async function recover(deps, options) {
  const proof = b64(sign(options.sourceKeys.sk.privateKey, proofBytes(
    options.userId,
    options.sourceDeviceId,
    options.newDevice.id,
  )));
  const body = await options.newDevice.registrationBody({ sealedPrivateKey: options.sealedPrivateKey });
  return deps.api.recoverDevice({
    sourceDeviceId: options.sourceDeviceId,
    recoveryProof: proof,
    device: body,
  });
}

