// A device's key material: what it holds, how it is published, and how it
// is sealed at rest.
//
// A device owns three long-lived key pairs and a supply of one-time prekeys:
//
//   ik    X25519   identity, in the Diffie-Hellman role of X3DH
//   sk    Ed25519  identity, in the signing role: it signs the prekey bundle
//   spk   X25519   the signed prekey the server publishes and hands out
//   opk   X25519   one-time prekeys, published in batches, consumed once
//
// The Ed25519 identity key is what makes the bundle unforgeable: the server
// publishes a bundle and the device signs it, so a server that substitutes
// its own key in place of the device's produces a bundle a client rejects.
// That is the answer to a server that tries to sit in the middle.
//
// The private halves never reach the server in the clear. What the server
// stores is the private material sealed under a key derived from a secret
// only the account holder has - the recovery key - so the server holds a
// blob it cannot open. Recovery works the other way round: the holder of the
// recovery key opens the blob locally, and proves to the server that it
// holds the old device's signing key, which the server can check against
// public data alone.

'use strict';

const crypto = require('node:crypto');

const primitives = require('./primitives');
const protocol = require('./protocol');

/** The names of the three long-lived key pairs, in a fixed order. */
const KEY_NAMES = ['ik', 'sk', 'spk'];

/**
 * A fresh set of long-lived key pairs for one device.
 *
 * @returns {{ik: {publicKey: Buffer, privateKey: Buffer},
 *            sk: {publicKey: Buffer, privateKey: Buffer},
 *            spk: {publicKey: Buffer, privateKey: Buffer}}}
 */
function generateKeySet() {
  return {
    ik: primitives.generateKeyPair('x25519'),
    sk: primitives.generateKeyPair('ed25519'),
    spk: primitives.generateKeyPair('x25519'),
  };
}

/** The public halves of a key set, base64url, in the shape the API uses. */
function publicKeySet(keySet) {
  return {
    identityKey: primitives.b64(keySet.sk.publicKey),
    identityDhKey: primitives.b64(keySet.ik.publicKey),
    signedPreKey: primitives.b64(keySet.spk.publicKey),
  };
}

/** The private halves of a key set, base64url. Never leaves the client. */
function privateKeySet(keySet) {
  const out = {};
  for (const name of KEY_NAMES) {
    out[name] = {
      publicKey: primitives.b64(keySet[name].publicKey),
      privateKey: primitives.b64(keySet[name].privateKey),
    };
  }
  return out;
}

/**
 * A key set from its halves.
 *
 * The halves are paired rather than trusted: the private half of each pair
 * must belong to the public half beside it, or the key set is not a key set.
 *
 * @param {Object<string, {publicKey: string, privateKey: string}>} halves
 * @returns {{ik: object, sk: object, spk: object}}
 */
function restoreKeySet(halves) {
  const out = {};
  for (const name of KEY_NAMES) {
    out[name] = {
      publicKey: primitives.unb64(halves[name].publicKey),
      privateKey: primitives.unb64(halves[name].privateKey),
    };
  }
  return out;
}

/**
 * The fingerprint of an identity key: the hex SHA-256 of the raw public
 * key. Two devices with the same fingerprint hold the same identity key,
 * which is what a reader compares.
 */
function fingerprint(identityPublicKey) {
  return primitives.sha256(primitives.unb64(identityPublicKey)).toString('hex');
}

/**
 * A recovery key: 32 random bytes, base64url.
 *
 * The user keeps it. The server never sees it - not even at recovery time.
 */
function generateRecoveryKey() {
  return primitives.b64(primitives.randomBytes(32));
}

/**
 * The wrapping key for a recovery key.
 *
 * PBKDF2-HMAC-SHA256 with 200 000 iterations and a per-device random salt.
 * The count is stored beside the blob so it can be raised later without
 * invalidating what is already sealed.
 */
function deriveWrappingKey(recoveryKey, salt, iterations) {
  const count = Number(iterations) || protocol.RECOVERY_PBKDF2_ITERATIONS;
  const derived = crypto.pbkdf2Sync(
    Buffer.from(String(recoveryKey), 'utf8'),
    Buffer.from(salt),
    count,
    32,
    'sha256'
  );
  // A second derivation step, so the PBKDF2 output is not used directly as
  // an AES key: the two are separated by their labels, exactly as every
  // other key in this protocol is.
  return primitives.hkdf(derived, protocol.ZERO_SALT, protocol.RECOVERY_WRAP_INFO, 32);
}

/**
 * Seal a device's private key material under a recovery key.
 *
 * @param {object} keySet       as generateKeySet() returns
 * @param {string} recoveryKey  the secret only the account holder has
 * @returns {{salt: string, iterations: number, iv: string, ciphertext: string, tag: string}}
 */
function sealPrivateMaterial(keySet, recoveryKey, options = {}) {
  const salt = options.salt
    ? primitives.unb64(options.salt)
    : primitives.randomBytes(protocol.RECOVERY_SALT_BYTES);
  const iterations = Number(options.iterations) || protocol.RECOVERY_PBKDF2_ITERATIONS;
  const wrappingKey = deriveWrappingKey(recoveryKey, salt, iterations);
  const iv = primitives.randomBytes(primitives.GCM_IV_BYTES);
  const sealed = primitives.encrypt(
    wrappingKey,
    iv,
    Buffer.from(JSON.stringify(privateKeySet(keySet)), 'utf8'),
    Buffer.from(protocol.RECOVERY_WRAP_INFO, 'utf8')
  );
  return {
    salt: primitives.b64(salt),
    iterations,
    iv: primitives.b64(sealed.iv),
    ciphertext: primitives.b64(sealed.ciphertext),
    tag: primitives.b64(sealed.tag),
  };
}

/**
 * Open a sealed private key material blob.
 *
 * Throws when the recovery key is wrong: the GCM tag does not verify, and
 * that is the answer. There is no "maybe" here - an unopenable blob is
 * unusable, and pretending otherwise would hand back a corrupted key set.
 */
function openPrivateMaterial(sealed, recoveryKey) {
  const wrappingKey = deriveWrappingKey(recoveryKey, primitives.unb64(sealed.salt), sealed.iterations);
  const plaintext = primitives.decrypt(
    wrappingKey,
    primitives.unb64(sealed.iv),
    primitives.unb64(sealed.ciphertext),
    primitives.unb64(sealed.tag),
    Buffer.from(protocol.RECOVERY_WRAP_INFO, 'utf8')
  );
  const halves = JSON.parse(plaintext.toString('utf8'));
  return restoreKeySet(halves);
}

module.exports = {
  KEY_NAMES,
  generateKeySet,
  publicKeySet,
  privateKeySet,
  restoreKeySet,
  fingerprint,
  generateRecoveryKey,
  deriveWrappingKey,
  sealPrivateMaterial,
  openPrivateMaterial,
};
