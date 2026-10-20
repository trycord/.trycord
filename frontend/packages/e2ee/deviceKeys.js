// A device's key material: what it holds, how it is published, and how it is
// sealed at rest.
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

import { b64, unb64, utf8, fromUtf8 } from './bytes.js';
import {
  generateKeyPair,
  hkdf,
  pbkdf2,
  randomBytes,
  sha256,
  encrypt,
  decrypt,
  GCM_IV_BYTES,
  KEY_BYTES,
} from './primitives.js';
import { RECOVERY_PBKDF2_ITERATIONS, RECOVERY_SALT_BYTES, RECOVERY_WRAP_INFO, ZERO_SALT } from './protocol.js';
import { hex } from './bytes.js';

/** The names of the three long-lived key pairs, in a fixed order. */
export const KEY_NAMES = ['ik', 'sk', 'spk'];

/**
 * A fresh set of long-lived key pairs for one device.
 *
 * @returns {{ik: {publicKey: Uint8Array, privateKey: Uint8Array},
 *            sk: {publicKey: Uint8Array, privateKey: Uint8Array},
 *            spk: {publicKey: Uint8Array, privateKey: Uint8Array}}}
 */
export function generateKeySet() {
  return {
    ik: generateKeyPair('x25519'),
    sk: generateKeyPair('ed25519'),
    spk: generateKeyPair('x25519'),
  };
}

/** The public halves of a key set, base64url, in the shape the API uses. */
export function publicKeySet(keySet) {
  return {
    identityKey: b64(keySet.sk.publicKey),
    identityDhKey: b64(keySet.ik.publicKey),
    signedPreKey: b64(keySet.spk.publicKey),
  };
}

/** The private halves of a key set, base64url. Never leaves the client. */
export function privateKeySet(keySet) {
  const out = {};
  for (const name of KEY_NAMES) {
    out[name] = {
      publicKey: b64(keySet[name].publicKey),
      privateKey: b64(keySet[name].privateKey),
    };
  }
  return out;
}

/**
 * A key set from its halves.
 *
 * The halves are paired rather than trusted: the private half of each pair
 * must belong to the public half beside it, or the key set is not a key set.
 */
export function restoreKeySet(halves) {
  const out = {};
  for (const name of KEY_NAMES) {
    out[name] = {
      publicKey: unb64(halves[name].publicKey),
      privateKey: unb64(halves[name].privateKey),
    };
  }
  return out;
}

/**
 * The fingerprint of an identity key: the hex SHA-256 of the raw public key.
 * Two devices with the same fingerprint hold the same identity key, which is
 * what a reader compares.
 */
export async function fingerprint(identityPublicKey) {
  return hex(await sha256(unb64(identityPublicKey)));
}

/**
 * A recovery key: 32 random bytes, base64url.
 *
 * The user keeps it. The server never sees it - not even at recovery time.
 */
export function generateRecoveryKey() {
  return b64(randomBytes(32));
}

/**
 * The wrapping key for a recovery key.
 *
 * PBKDF2-HMAC-SHA256 with 200 000 iterations and a per-device random salt.
 * The count is stored beside the blob so it can be raised later without
 * invalidating what is already sealed.
 */
export async function deriveWrappingKey(recoveryKey, salt, iterations) {
  const count = Number(iterations) || RECOVERY_PBKDF2_ITERATIONS;
  const derived = await pbkdf2(String(recoveryKey), salt, count, KEY_BYTES);
  // A second derivation step, so the PBKDF2 output is not used directly as
  // an AES key: the two are separated by their labels, exactly as every
  // other key in this protocol is.
  return hkdf(derived, ZERO_SALT, RECOVERY_WRAP_INFO, KEY_BYTES);
}

/**
 * Seal a device's private key material under a recovery key.
 *
 * @param {object} keySet       as generateKeySet() returns
 * @param {string} recoveryKey  the secret only the account holder has
 * @returns {Promise<{salt: string, iterations: number, iv: string, ciphertext: string, tag: string}>}
 */
export async function sealPrivateMaterial(keySet, recoveryKey, options = {}) {
  const salt = options.salt ? unb64(options.salt) : randomBytes(RECOVERY_SALT_BYTES);
  const iterations = Number(options.iterations) || RECOVERY_PBKDF2_ITERATIONS;
  const wrappingKey = await deriveWrappingKey(recoveryKey, salt, iterations);
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = await encrypt(
    wrappingKey,
    iv,
    utf8(JSON.stringify(privateKeySet(keySet))),
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
 * Seal a private half under a recovery key.
 *
 * The one-time prekeys are sealed this way: the device keeps the private half
 * and the server keeps a sealed copy, so a device that has lost its store can
 * still open a session that used one of its prekeys.
 */
export async function sealPrivateBytes(bytes, recoveryKey, options = {}) {
  const salt = options.salt ? unb64(options.salt) : randomBytes(RECOVERY_SALT_BYTES);
  const iterations = Number(options.iterations) || RECOVERY_PBKDF2_ITERATIONS;
  const wrappingKey = await deriveWrappingKey(recoveryKey, salt, iterations);
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = await encrypt(wrappingKey, iv, bytes, utf8(RECOVERY_WRAP_INFO));
  return {
    salt: b64(salt),
    iterations,
    iv: b64(sealed.iv),
    ciphertext: b64(sealed.ciphertext),
    tag: b64(sealed.tag),
  };
}

/**
 * Open a sealed private half.
 *
 * Throws when the recovery key is wrong: the tag does not verify, and that is
 * the answer.
 */
export async function openPrivateBytes(sealed, recoveryKey) {
  const wrappingKey = await deriveWrappingKey(recoveryKey, unb64(sealed.salt), sealed.iterations);
  const plaintext = await decrypt(
    wrappingKey,
    unb64(sealed.iv),
    unb64(sealed.ciphertext),
    unb64(sealed.tag),
    utf8(RECOVERY_WRAP_INFO),
  );
  return new Uint8Array(plaintext);
}

/**
 * Open a sealed private key material blob.
 *
 * Throws when the recovery key is wrong: the GCM tag does not verify, and
 * that is the answer. There is no "maybe" here - an unopenable blob is
 * unusable, and pretending otherwise would hand back a corrupted key set.
 */
export async function openPrivateMaterial(sealed, recoveryKey) {
  const wrappingKey = await deriveWrappingKey(recoveryKey, unb64(sealed.salt), sealed.iterations);
  const plaintext = await decrypt(
    wrappingKey,
    unb64(sealed.iv),
    unb64(sealed.ciphertext),
    unb64(sealed.tag),
    utf8(RECOVERY_WRAP_INFO),
  );
  const halves = JSON.parse(fromUtf8(plaintext));
  return restoreKeySet(halves);
}
