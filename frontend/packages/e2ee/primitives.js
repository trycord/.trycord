// The cryptographic primitives the E2EE subsystem is built from.
//
// Four published algorithms, and nothing else:
//
//   X25519        Diffie-Hellman (RFC 7748)
//   Ed25519       signatures (RFC 8032)
//   HKDF-SHA256   key derivation (RFC 5869)
//   AES-256-GCM   authenticated encryption (NIST SP 800-38D)
//
// No primitive is invented here. The curves come from @noble/curves, vendored
// beside this file; the rest come from the browser's own WebCrypto, which has
// carried AES-GCM, HMAC, SHA-2 and PBKDF2 in every engine that matters for
// years.
//
// The curves are the vendored part because WebCrypto does not offer them
// everywhere. As of 2026 X25519 is in Chrome 133, Firefox 130 and Safari 17,
// and Ed25519 in Chrome 137, Firefox 129 and Safari 17 - so an engine from
// before 2024, a Firefox ESR 128 or an old mobile webview, has neither. A
// client that cannot do the arithmetic cannot take part in an encrypted
// conversation at all, so the client carries its own. One implementation for
// every engine is also one implementation for the tests, which is what makes
// the client and the server comparable.
//
// The derivation labels, the byte encodings and the base64url are the
// server's, exactly. A key schedule that differs by a byte produces keys that
// do not open, and the failure would look like a bug in the protocol rather
// than in the schedule.
//
// Every function here is asynchronous because WebCrypto is. The shapes and the
// lengths are the server's: raw 32-byte keys, a 12-byte GCM nonce and a
// 16-byte tag, kept apart on the wire the way the server keeps them apart.

import { x25519, ed25519 } from '../vendor/noble-curves.js';
import { concatBytes, b64, unb64, randomBytes, utf8 } from './bytes.js';

export const KEY_BYTES = 32;        // X25519 and Ed25519 keys are 32 bytes
export const SIGNATURE_BYTES = 64;  // Ed25519 signatures are 64 bytes
export const GCM_IV_BYTES = 12;     // the AES-GCM nonce length
export const GCM_TAG_BYTES = 16;    // the AES-GCM authentication tag length
export const SALT_BYTES = 32;       // HKDF salt, as in RFC 5869 section 2.2

const subtle = () => globalThis.crypto.subtle;

/**
 * A fresh key pair of the named curve.
 *
 * @param {'x25519'|'ed25519'} curve
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array}} raw 32-byte halves
 */
export function generateKeyPair(curve) {
  if (curve === 'x25519') {
    const privateKey = x25519.utils.randomSecretKey();
    return { publicKey: x25519.getPublicKey(privateKey), privateKey };
  }
  if (curve === 'ed25519') {
    const privateKey = ed25519.utils.randomSecretKey();
    return { publicKey: ed25519.getPublicKey(privateKey), privateKey };
  }
  throw new Error('unknown curve: ' + curve);
}

/**
 * The X25519 shared secret.
 *
 * The output is refused when it is all zeroes, which is the one value an
 * attacker can force by sending a low-order point. The library refuses it
 * already; the check is kept so the guarantee is visible where it is relied
 * upon.
 */
export function ecdh(privateKey, publicKey) {
  const secret = x25519.getSharedSecret(privateKey, publicKey);
  if (secret.length !== KEY_BYTES) throw new Error('unexpected shared secret length');
  let zero = true;
  for (const byte of secret) {
    if (byte !== 0) { zero = false; break; }
  }
  if (zero) throw new Error('degenerate shared secret');
  return secret;
}

/** One HMAC-SHA256 of the data under the key. */
async function hmacSha256(key, data) {
  const cryptoKey = await subtle().importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', cryptoKey, data));
}

/**
 * HKDF-SHA256 (RFC 5869).
 *
 * The extract and the expand are the ones the document describes, over the
 * browser's HMAC-SHA256. A salt that is not given is 32 zero bytes, as
 * RFC 5869 says; a salt that is given is used as it is.
 *
 * @param {Uint8Array} ikm   input key material
 * @param {Uint8Array} salt  the extraction salt
 * @param {Uint8Array|string} info  the context string that separates domains
 * @param {number} length  bytes of output
 */
export async function hkdf(ikm, salt, info, length) {
  const saltBytes = salt ? salt : new Uint8Array(SALT_BYTES);
  const infoBytes = typeof info === 'string' ? utf8(info) : info;
  const prk = await hmacSha256(saltBytes, ikm);

  const out = new Uint8Array(length);
  let block = new Uint8Array(0);
  let at = 0;
  let counter = 1;
  while (at < length) {
    block = await hmacSha256(prk, concatBytes(block, infoBytes, new Uint8Array([counter])));
    const take = Math.min(block.length, length - at);
    out.set(block.subarray(0, take), at);
    at += take;
    counter += 1;
  }
  return out;
}

/** SHA-256 of a byte string. */
export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

/** SHA-512 of a byte string. Long enough to be read out as sixty digits. */
export async function sha512(bytes) {
  return new Uint8Array(await subtle().digest('SHA-512', bytes));
}

/**
 * PBKDF2-HMAC-SHA256.
 *
 * Used for one thing only: turning a human-held recovery phrase into a
 * wrapping key.
 */
export async function pbkdf2(password, salt, iterations, length) {
  const key = await subtle().importKey(
    'raw', utf8(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, length * 8);
  return new Uint8Array(bits);
}

async function importAesKey(key) {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM needs a 32-byte key');
  return subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * AES-256-GCM encryption.
 *
 * The nonce is supplied by the caller and must never repeat under the same
 * key. The tag is returned separately, as the wire format carries it apart
 * from the ciphertext.
 */
export async function encrypt(key, iv, plaintext, aad) {
  if (iv.length !== GCM_IV_BYTES) throw new Error('AES-256-GCM needs a 12-byte nonce');
  const cryptoKey = await importAesKey(key);
  const params = { name: 'AES-GCM', iv, tagLength: GCM_TAG_BYTES * 8 };
  if (aad !== undefined && aad !== null) params.additionalData = aad;
  const sealed = new Uint8Array(await subtle().encrypt(params, cryptoKey, plaintext));
  return {
    iv,
    ciphertext: sealed.subarray(0, sealed.length - GCM_TAG_BYTES),
    tag: sealed.subarray(sealed.length - GCM_TAG_BYTES),
  };
}

/**
 * AES-256-GCM decryption.
 *
 * Throws when the ciphertext, the tag or the associated data has been
 * altered: that failure is the whole point of the AEAD, so it is not
 * swallowed here and never becomes a "false" return value.
 */
export async function decrypt(key, iv, ciphertext, tag, aad) {
  if (iv.length !== GCM_IV_BYTES) throw new Error('AES-256-GCM needs a 12-byte nonce');
  if (tag.length !== GCM_TAG_BYTES) throw new Error('AES-256-GCM needs a 16-byte tag');
  const cryptoKey = await importAesKey(key);
  const params = { name: 'AES-GCM', iv, tagLength: GCM_TAG_BYTES * 8 };
  if (aad !== undefined && aad !== null) params.additionalData = aad;
  const opened = await subtle().decrypt(params, cryptoKey, concatBytes(ciphertext, tag));
  return new Uint8Array(opened);
}

/** An Ed25519 signature over a message. */
export function sign(privateKey, message) {
  const signature = ed25519.sign(message, privateKey);
  if (signature.length !== SIGNATURE_BYTES) throw new Error('unexpected signature length');
  return signature;
}

/**
 * Whether an Ed25519 signature is valid.
 *
 * A malformed signature is a false, not an exception: the caller is deciding
 * whether to trust a bundle, and an unparseable one is simply not trusted.
 */
export function verify(publicKey, message, signature) {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export { b64, unb64, randomBytes, utf8 };
