// Recovery and key backup.
//
// A device's private material is sealed under a key derived from the
// account holder's recovery key. The server stores the sealed blob and
// cannot open it, because the recovery key never reaches the server - not
// when the blob is stored, and not when it is recovered.
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
// sees the old private key, and never sees the new private key: it
// receives the new public keys and the new sealed blob.
//
// The new device is a new device. It does not take the old device's
// identity, so recovering does not silently hand anybody the ability to
// speak as the lost device - the lost device's key is still lost, and the
// old device can be revoked once the new one is in place.

'use strict';

const db = require('../../db');
const { now } = require('../../clock');
const primitives = require('./primitives');
const protocol = require('./protocol');
const { protocolError } = require('./envelope');
const devices = require('./devices');
const sql = require('./sql');

/**
 * The bytes the old device signs to prove it can be recovered.
 *
 * The statement names the account and the new device, so a signature
 * cannot be lifted from one recovery and used for another.
 */
function proofBytes(userId, sourceDeviceId, newDeviceId) {
  return protocol.canonical(
    ['context', protocol.RECOVERY_PROOF_CONTEXT],
    ['version', protocol.PROTOCOL_VERSION],
    ['user', userId],
    ['source', sourceDeviceId],
    ['device', newDeviceId]
  );
}

/**
 * Recover a device.
 *
 * The proof is a signature by the source device's identity key over the
 * recovery statement. A caller who cannot produce it cannot recover: the
 * statement is what the holder of the recovery key can make and nobody
 * else can.
 */
async function recover(userId, input) {
  const sourceDeviceId = String(input.sourceDeviceId || '');
  const device = input.device || {};
  const newDeviceId = String(device.id || '');
  if (!sourceDeviceId || !newDeviceId) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a recovery names the device lost and the device new', 400);
  }
  const source = await devices.owned(userId, sourceDeviceId);
  if (source.revoked_at) {
    throw protocolError('E2EE_DEVICE_REVOKED', 'that device has already been revoked', 403);
  }
  if (!device.identityKey || !device.identityDhKey || !device.signedPreKey) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the new device needs its three public keys', 400);
  }
  if (device.identityKey === source.identity_key) {
    // A recovered device that keeps the old identity would be the old
    // device, wearing a new label: whoever holds the old private key could
    // read what the old device reads, and the revocation of the old device
    // would not mean anything. Recovery mints a new identity.
    throw protocolError(
      'E2EE_VALIDATION_ERROR',
      'a recovered device must have a new identity key; it cannot reuse the lost one',
      400
    );
  }
  let proofOk = false;
  try {
    proofOk = primitives.verify(
      primitives.importPublic('ed25519', primitives.unb64(source.identity_key)),
      proofBytes(userId, sourceDeviceId, newDeviceId),
      primitives.unb64(String(input.recoveryProof || ''))
    );
  } catch {
    proofOk = false;
  }
  if (!proofOk) {
    throw protocolError(
      'E2EE_INVALID_SIGNATURE',
      'the recovery proof does not verify against the lost device',
      403
    );
  }

  const registered = await devices.register(userId, device);
  return { device: registered, recoveredFrom: sourceDeviceId };
}

/**
 * Store an encrypted key backup.
 *
 * The blob is the user's own: encrypted under a key derived from their
 * recovery key, and opaque to the server. What the server keeps beside it
 * is the salt and the iteration count, which it needs for nothing except
 * telling the client what it uploaded.
 */
async function saveBackup(userId, input) {
  if (!input.salt || !input.iv || !input.ciphertext || !input.tag) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a backup needs its salt, nonce, ciphertext and tag', 400);
  }
  const iterations = Number(input.iterations) || protocol.RECOVERY_PBKDF2_ITERATIONS;
  const timestamp = now();
  const statement = sql.upsert(
    'e2ee_backups',
    ['user_id', 'salt', 'iterations', 'iv', 'ciphertext', 'tag', 'created_at', 'updated_at'],
    ['user_id'],
    {
      salt: sql.proposed('salt'),
      iterations: sql.proposed('iterations'),
      iv: sql.proposed('iv'),
      ciphertext: sql.proposed('ciphertext'),
      tag: sql.proposed('tag'),
      updated_at: sql.proposed('updated_at'),
    }
  );
  await db.run(statement, [
    userId, input.salt, iterations, input.iv, input.ciphertext, input.tag, timestamp, timestamp,
  ]);
  return { userId, iterations, updatedAt: timestamp };
}

/** The user's encrypted key backup, as they uploaded it. */
async function getBackup(userId) {
  const row = await db.get('SELECT * FROM e2ee_backups WHERE user_id = ?', [userId]);
  if (!row) return null;
  return {
    userId: row.user_id,
    salt: row.salt,
    iterations: Number(row.iterations) || 0,
    iv: row.iv,
    ciphertext: row.ciphertext,
    tag: row.tag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { proofBytes, recover, saveBackup, getBackup };
