// Prekey bundles: how two devices find each other's keys, and how the
// server is stopped from pretending to be one of them.
//
// A bundle is the device's public identity, its signed prekey, and - when
// one is available - a single one-time prekey. The device signs the bundle
// with its Ed25519 identity key, and a client checks that signature before
// it uses anything in the bundle.
//
// That check is what a server cannot forge: the server holds the public
// keys, so it could hand a client a bundle of its own making, but it
// cannot sign that bundle with the device's identity key. A server that
// rewrites a bundle produces one whose signature does not verify, and the
// client refuses it.
//
// The one-time prekey is consumed on the way out. The consumption is a
// conditional update inside the same transaction that reads it, so two
// initiators racing for the same prekey cannot both get it: the second one
// updates zero rows and moves on. A prekey that has been used cannot be
// used again, which is what lets the responder delete its private half
// afterwards and still be safe.

'use strict';

const db = require('../../db');
const { now } = require('../../clock');
const primitives = require('./primitives');
const protocol = require('./protocol');
const { protocolError } = require('./envelope');
const devices = require('./devices');

const ONE_TIME = 'one-time';
const LAST_RESORT = 'last-resort';

/**
 * The bytes a device signs when it registers and publishes.
 *
 * The signature over these bytes is the device's proof that it holds the
 * private half of its identity key, and it is the same signature a peer
 * checks when it fetches the bundle. One signature, two jobs: the server
 * learns the registrant is not posting somebody else's key, and a client
 * learns the bundle it was handed is the one the device published.
 */
function bundleSignatureBytes(fields) {
  return protocol.canonical(
    ['context', protocol.PREKEY_SIGNATURE_CONTEXT],
    ['version', protocol.PROTOCOL_VERSION],
    ['user', fields.userId],
    ['device', fields.deviceId],
    ['identity', fields.identityKey],
    ['identityDh', fields.identityDhKey],
    ['signedPreKey', fields.signedPreKey]
  );
}

/**
 * The bytes a device signs for one of its one-time prekeys.
 *
 * The prekey's signature commits to the device's bundle as well, so a
 * prekey cannot be moved to another device and used to start a session
 * under keys the peer did not expect.
 */
function prekeySignatureBytes(fields) {
  return protocol.canonical(
    ['context', protocol.PREKEY_SIGNATURE_CONTEXT],
    ['version', protocol.PROTOCOL_VERSION],
    ['user', fields.userId],
    ['device', fields.deviceId],
    ['identity', fields.identityKey],
    ['identityDh', fields.identityDhKey],
    ['signedPreKey', fields.signedPreKey],
    ['prekeyId', fields.prekeyId],
    ['prekey', fields.publicKey]
  );
}

/** Whether a signature verifies against an identity key. */
function signatureVerifies(identityKey, message, signature) {
  if (!identityKey || !signature) return false;
  try {
    return primitives.verify(
      primitives.importPublic('ed25519', primitives.unb64(identityKey)),
      message,
      primitives.unb64(signature)
    );
  } catch {
    return false;
  }
}

/**
 * Publish a bundle.
 *
 * The published keys must be the ones the device registered with, and both
 * the bundle and every prekey must carry a valid signature from the
 * device's identity key. A bundle that fails either check is refused: the
 * server will not hand out material it cannot vouch for, because a client
 * that trusts it would be trusting a bundle nobody signed.
 */
async function publish(userId, deviceId, input) {
  const device = await devices.owned(userId, deviceId);
  if (device.revoked_at) {
    throw protocolError('E2EE_DEVICE_REVOKED', 'this device has been revoked', 403);
  }
  if (input.identityKey !== device.identity_key
    || input.identityDhKey !== device.identity_dh_key
    || input.signedPreKey !== device.signed_pre_key) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the bundle does not match the registered device', 400);
  }
  const bundle = {
    userId,
    deviceId,
    identityKey: input.identityKey,
    identityDhKey: input.identityDhKey,
    signedPreKey: input.signedPreKey,
  };
  const signature = input.signature || device.signature;
  if (!signatureVerifies(input.identityKey, bundleSignatureBytes(bundle), signature)) {
    throw protocolError('E2EE_INVALID_SIGNATURE', 'the bundle signature does not verify', 400);
  }

  const published = Array.isArray(input.oneTimePreKeys) ? input.oneTimePreKeys : [];
  if (published.length > 200) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'too many one-time prekeys in one publish', 400);
  }
  for (const prekey of published) {
    if (!prekey.id || !prekey.publicKey) {
      throw protocolError('E2EE_VALIDATION_ERROR', 'a one-time prekey needs an id and a public key', 400);
    }
    const signed = prekeySignatureBytes({
      userId,
      deviceId,
      identityKey: input.identityKey,
      identityDhKey: input.identityDhKey,
      signedPreKey: input.signedPreKey,
      prekeyId: prekey.id,
      publicKey: prekey.publicKey,
    });
    if (!signatureVerifies(input.identityKey, signed, prekey.signature)) {
      throw protocolError('E2EE_INVALID_SIGNATURE', 'a one-time prekey signature does not verify', 400);
    }
  }

  const timestamp = now();
  await db.run('UPDATE e2ee_devices SET signature = ?, last_seen_at = ? WHERE id = ?',
    [signature, timestamp, deviceId]);

  // The published one-time prekeys replace the previous unpublished ones:
  // a prekey that was published and not used is stale, and keeping it
  // would only give an attacker more material to work with.
  await db.run(
    "DELETE FROM e2ee_prekeys WHERE device_id = ? AND consumed_at IS NULL AND kind = 'one-time'",
    [deviceId]
  );
  for (const prekey of published) {
    await db.run(
      `INSERT INTO e2ee_prekeys
         (id, device_id, user_id, public_key, signature, sealed_private_key, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [prekey.id, deviceId, userId, prekey.publicKey, prekey.signature,
        prekey.sealedPrivateKey || null, ONE_TIME, timestamp]
    );
  }
  if (input.lastResortPreKey && input.lastResortPreKey.id && input.lastResortPreKey.publicKey) {
    const signed = prekeySignatureBytes({
      userId,
      deviceId,
      identityKey: input.identityKey,
      identityDhKey: input.identityDhKey,
      signedPreKey: input.signedPreKey,
      prekeyId: input.lastResortPreKey.id,
      publicKey: input.lastResortPreKey.publicKey,
    });
    if (!signatureVerifies(input.identityKey, signed, input.lastResortPreKey.signature)) {
      throw protocolError('E2EE_INVALID_SIGNATURE', 'the last-resort prekey signature does not verify', 400);
    }
    await db.run(
      "DELETE FROM e2ee_prekeys WHERE device_id = ? AND consumed_at IS NULL AND kind = 'last-resort'",
      [deviceId]
    );
    await db.run(
      `INSERT INTO e2ee_prekeys
         (id, device_id, user_id, public_key, signature, sealed_private_key, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.lastResortPreKey.id, deviceId, userId, input.lastResortPreKey.publicKey,
        input.lastResortPreKey.signature, input.lastResortPreKey.sealedPrivateKey || null,
        LAST_RESORT, timestamp]
    );
  }

  const counts = await db.get(
    `SELECT
        SUM(CASE WHEN kind = 'one-time' AND consumed_at IS NULL THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN kind = 'last-resort' AND consumed_at IS NULL THEN 1 ELSE 0 END) AS lastResort
       FROM e2ee_prekeys WHERE device_id = ?`,
    [deviceId]
  );
  return {
    deviceId,
    availablePreKeys: Number(counts && counts.available) || 0,
    lastResortPreKeys: Number(counts && counts.lastResort) || 0,
  };
}

/**
 * Take a bundle from the server, consuming a one-time prekey.
 *
 * The prekey is consumed in the same transaction that reads it, with a
 * conditional update, so the consumption happens exactly once however many
 * callers arrive at the same moment.
 */
async function fetchBundle(deviceId) {
  const device = await devices.get(deviceId);
  if (!device) throw protocolError('E2EE_NOT_FOUND', 'no such device', 404);
  if (device.revoked_at) {
    throw protocolError('E2EE_DEVICE_REVOKED', 'this device has been revoked', 403);
  }
  if (!device.signature) {
    throw protocolError('E2EE_NOT_FOUND', 'this device has published no prekeys', 404);
  }

  const consumed = await db.transaction(async (t) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await t.get(
        `SELECT * FROM e2ee_prekeys
          WHERE device_id = ? AND consumed_at IS NULL AND kind = ?
          ORDER BY created_at ASC LIMIT 1`,
        [deviceId, ONE_TIME]
      );
      if (!candidate) break;
      const result = await t.run(
        'UPDATE e2ee_prekeys SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
        [now(), candidate.id]
      );
      if (result.changes === 1) return candidate;
    }
    // No one-time prekey left: the last-resort one, which is consumed the
    // same way. A device publishes a fresh one as soon as this is used.
    const fallback = await t.get(
      `SELECT * FROM e2ee_prekeys
        WHERE device_id = ? AND consumed_at IS NULL AND kind = ?
        ORDER BY created_at ASC LIMIT 1`,
      [deviceId, LAST_RESORT]
    );
    if (!fallback) return null;
    const result = await t.run(
      'UPDATE e2ee_prekeys SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
      [now(), fallback.id]
    );
    return result.changes === 1 ? fallback : null;
  });

  const bundle = {
    version: protocol.PROTOCOL_VERSION,
    userId: device.user_id,
    deviceId: device.id,
    label: device.label,
    identityKey: device.identity_key,
    identityDhKey: device.identity_dh_key,
    signedPreKey: device.signed_pre_key,
    signature: device.signature,
    keyFingerprint: device.key_fingerprint,
    oneTimePreKey: consumed
      ? { id: consumed.id, publicKey: consumed.public_key, signature: consumed.signature }
      : null,
  };
  return bundle;
}

/**
 * Claim a prekey the server has handed out.
 *
 * The responder calls this with the prekey id the initiator used, so the
 * prekey cannot be used for two sessions. The claim is conditional: a
 * prekey that has already been claimed is not claimed again.
 *
 * The claim is also what tells the responder which private half belongs to
 * the prekey: the row comes back with it, sealed under the account
 * holder's recovery key if the client uploaded it that way.
 */
async function claim(userId, deviceId, prekeyId) {
  const device = await devices.owned(userId, deviceId);
  if (!prekeyId) return null;
  const result = await db.run(
    `UPDATE e2ee_prekeys SET claimed_at = ?
      WHERE id = ? AND device_id = ? AND consumed_at IS NOT NULL AND claimed_at IS NULL`,
    [now(), prekeyId, device.id]
  );
  if (result.changes !== 1) {
    throw protocolError('E2EE_PREKEY_GONE', 'that prekey has already been used', 409);
  }
  const row = await db.get('SELECT * FROM e2ee_prekeys WHERE id = ?', [prekeyId]);
  return {
    id: row.id,
    deviceId: row.device_id,
    publicKey: row.public_key,
    kind: row.kind,
    sealedPrivateKey: row.sealed_private_key || null,
  };
}

/**
 * Release a prekey the server consumed but that no session used.
 *
 * When an initiator takes a bundle and does not use the one-time prekey in
 * it, the prekey has still been consumed. Releasing it puts it back into
 * circulation rather than wasting it.
 */
async function releaseUnclaimed(userId, deviceId) {
  const device = await devices.owned(userId, deviceId);
  const result = await db.run(
    `UPDATE e2ee_prekeys SET consumed_at = NULL
      WHERE device_id = ? AND consumed_at IS NOT NULL AND claimed_at IS NULL`,
    [device.id]
  );
  return { released: Number(result.changes) || 0 };
}

module.exports = {
  ONE_TIME,
  LAST_RESORT,
  bundleSignatureBytes,
  prekeySignatureBytes,
  signatureVerifies,
  publish,
  fetchBundle,
  claim,
  releaseUnclaimed,
};
