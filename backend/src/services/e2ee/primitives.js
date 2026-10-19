// The cryptographic primitives the E2EE subsystem is built from.
//
// Four published algorithms, all from node:crypto, and nothing else:
//
//   X25519        Diffie-Hellman (RFC 7748)
//   Ed25519       signatures (RFC 8032)
//   HKDF-SHA256   key derivation (RFC 5869)
//   AES-256-GCM   authenticated encryption (NIST SP 800-38D)
//
// No primitive is invented here and none is imported from a library. The
// protocol is these four plus the key schedule in ../x3dh.js and ../ratchet.js.
//
// Keys are handled as raw 32-byte strings, base64url-encoded on the wire and
// in the database. A raw key is what the algorithms consume, so keeping one
// representation end to end removes a class of encoding bug (a key encoded
// one way and decoded another) rather than papering over it.

'use strict';

const crypto = require('node:crypto');

const KEY_BYTES = 32;        // X25519 and Ed25519 keys are 32 bytes
const SIGNATURE_BYTES = 64;  // Ed25519 signatures are 64 bytes
const GCM_IV_BYTES = 12;     // the AES-GCM nonce length
const GCM_TAG_BYTES = 16;    // the AES-GCM authentication tag length
const SALT_BYTES = 32;       // HKDF salt, as in RFC 5869 section 2.2

// The curve names, in the two spellings node:crypto uses: the key
// generator takes the lower-case name, the JWK format the upper-case one.
const CURVES = {
  x25519: 'X25519',
  ed25519: 'Ed25519',
};

/** A random buffer of the requested length. */
function randomBytes(length) {
  return crypto.randomBytes(length);
}

/** base64url without padding: the encoding used for every key on the wire. */
function b64(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/** The inverse of b64(). Throws on anything that is not base64url. */
function unb64(text) {
  if (typeof text !== 'string' || !text.length) {
    throw new Error('expected a base64url string');
  }
  return Buffer.from(text, 'base64url');
}

/**
 * A fresh key pair of the named curve.
 *
 * @param {'x25519'|'ed25519'} curve
 * @returns {{publicKey: Buffer, privateKey: Buffer}} raw 32-byte halves
 */
function generateKeyPair(curve) {
  const kind = CURVES[curve];
  if (!kind) throw new Error('unknown curve: ' + curve);
  const pair = crypto.generateKeyPairSync(curve);
  return { publicKey: exportPublic(pair.publicKey), privateKey: exportPrivate(pair.privateKey) };
}

/** The raw 32-byte public half of a key object. */
function exportPublic(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('key object has no public half');
  return unb64(jwk.x);
}

/** The raw 32-byte private half of a key object. */
function exportPrivate(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  if (!jwk.d) throw new Error('key object has no private half');
  return unb64(jwk.d);
}

/** A raw key half: bytes as they are, or the base64url the wire uses. */
function rawKey(value) {
  return Buffer.isBuffer(value) ? value : unb64(value);
}

/** A public key object from a raw 32-byte half. */
function importPublic(curve, raw) {
  const kind = CURVES[curve];
  if (!kind) throw new Error('unknown curve: ' + curve);
  const bytes = rawKey(raw);
  if (bytes.length !== KEY_BYTES) throw new Error('a ' + curve + ' public key is 32 bytes');
  return crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: kind, x: bytes.toString('base64url') },
  });
}

/**
 * A private key object from its raw halves.
 *
 * The public half is required as well: a JWK private key carries both, and
 * Node refuses to import one without it. Every caller has it - the public
 * halves are published and stored in the clear.
 */
function importPrivate(curve, rawPrivate, rawPublic) {
  const kind = CURVES[curve];
  if (!kind) throw new Error('unknown curve: ' + curve);
  const d = rawKey(rawPrivate);
  const x = rawKey(rawPublic);
  if (d.length !== KEY_BYTES || x.length !== KEY_BYTES) {
    throw new Error('a ' + curve + ' key pair is two 32-byte halves');
  }
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: kind, x: x.toString('base64url'), d: d.toString('base64url') },
  });
}

/**
 * The X25519 shared secret.
 *
 * The output is rejected when it is all zeroes, which is the one value an
 * attacker can force by sending a low-order point. Node already refuses to
 * produce it, and this check makes the guarantee explicit at the call site
 * that depends on it.
 */
function ecdh(privateKeyObject, publicKeyObject) {
  const secret = crypto.diffieHellman({ privateKey: privateKeyObject, publicKey: publicKeyObject });
  if (secret.length !== KEY_BYTES) throw new Error('unexpected shared secret length');
  if (secret.every((byte) => byte === 0)) throw new Error('degenerate shared secret');
  return secret;
}

/**
 * HKDF-SHA256.
 *
 * @param {Buffer} ikm   input key material
 * @param {Buffer} salt  the extraction salt
 * @param {Buffer|string} info  the context string that separates domains
 * @param {number} length  bytes of output
 */
function hkdf(ikm, salt, info, length) {
  const saltBytes = salt ? Buffer.from(salt) : Buffer.alloc(SALT_BYTES);
  const infoBytes = Buffer.isBuffer(info) ? info : Buffer.from(String(info), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm), saltBytes, infoBytes, length));
}

/** SHA-256 of a buffer. */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

/** SHA-512 of a buffer. Long enough to be read out as sixty digits. */
function sha512(buffer) {
  return crypto.createHash('sha512').update(buffer).digest();
}


/**
 * AES-256-GCM encryption.
 *
 * The nonce is supplied by the caller and must never repeat under the same
 * key. The tag is returned separately, as the wire format carries it apart
 * from the ciphertext.
 */
function encrypt(key, iv, plaintext, aad) {
  if (key.length !== 32) throw new Error('AES-256-GCM needs a 32-byte key');
  if (iv.length !== GCM_IV_BYTES) throw new Error('AES-256-GCM needs a 12-byte nonce');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

/**
 * AES-256-GCM decryption.
 *
 * Throws when the ciphertext, the tag or the associated data has been
 * altered: that failure is the whole point of the AEAD, so it is not
 * swallowed here and never becomes a "false" return value.
 */
function decrypt(key, iv, ciphertext, tag, aad) {
  if (key.length !== 32) throw new Error('AES-256-GCM needs a 32-byte key');
  if (iv.length !== GCM_IV_BYTES) throw new Error('AES-256-GCM needs a 12-byte nonce');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
}

/** An Ed25519 signature over a message. */
function sign(privateKeyObject, message) {
  const signature = crypto.sign(null, Buffer.from(message), privateKeyObject);
  if (signature.length !== SIGNATURE_BYTES) throw new Error('unexpected signature length');
  return signature;
}

/**
 * Whether an Ed25519 signature is valid.
 *
 * A malformed signature is a false, not an exception: the caller is deciding
 * whether to trust a bundle, and an unparseable one is simply not trusted.
 */
function verify(publicKeyObject, message, signature) {
  const sig = Buffer.from(signature);
  if (sig.length !== SIGNATURE_BYTES) return false;
  try {
    return crypto.verify(null, Buffer.from(message), publicKeyObject, sig);
  } catch {
    return false;
  }
}

module.exports = {
  KEY_BYTES,
  SIGNATURE_BYTES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  SALT_BYTES,
  randomBytes,
  b64,
  unb64,
  generateKeyPair,
  exportPublic,
  exportPrivate,
  importPublic,
  importPrivate,
  ecdh,
  hkdf,
  sha256,
  sha512,
  encrypt,
  decrypt,
  sign,
  verify,
};
