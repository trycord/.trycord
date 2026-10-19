// Package signatures.
//
// Signing is optional and configurable, because most packages are not signed
// and pretending otherwise would be a lie about the registry. What this
// module does is narrow and real: given a package document, a signature and
// the keys the operator trusts, it says whether the signature is good.
//
// Two algorithms, both from Node's own crypto module and neither requiring a
// dependency:
//
//   hmac-sha256  a shared secret. The operator and the packager both hold
//                it. Simple, and honest about what it is: it proves the
//                package came from somebody who holds the secret.
//   ed25519      a public key. The operator holds the public half and the
//                packager keeps the private half, so the operator can verify
//                without being able to sign.
//
// The signature covers a canonical form of the package document: the same
// bytes every time, whatever order the JSON was written in.

const crypto = require('crypto');

// A deterministic rendering of a JSON value: object keys are sorted, arrays
// keep their order, and undefined members are left out. Two documents that
// mean the same thing produce the same string.
function canonicalise(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonicalise(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * The bytes a signature is computed over.
 *
 * The signature member itself is excluded: it is the thing being checked, and
 * including it would make every document its own unsatisfiable equation.
 */
function signingBytes(document) {
  const copy = Object.assign({}, document || {});
  delete copy.signature;
  return Buffer.from(JSON.stringify(canonicalise(copy)), 'utf8');
}

function hmacMatches(secret, expected, actual) {
  const computed = crypto.createHmac('sha256', String(secret)).update(expected).digest('hex');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(String(actual || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Check a package signature.
 *
 * @param {object} document    the package document as it arrived
 * @param {object} signature   { keyId, algorithm, value } or null
 * @param {object} keys        keyId -> { type, secret } or { type, publicKey }
 * @returns {object} { status, keyId, reason }
 */
function verify(document, signature, keys) {
  if (!signature || !signature.keyId || !signature.value) {
    return { status: 'unsigned', keyId: null, reason: 'the package carries no signature' };
  }
  const key = (keys || {})[signature.keyId];
  if (!key) {
    return {
      status: 'unverifiable',
      keyId: signature.keyId,
      reason: 'no trusted key is configured for "' + signature.keyId + '"',
    };
  }
  const bytes = signingBytes(document);
  if (signature.algorithm === 'hmac-sha256') {
    if (key.type !== 'hmac-sha256' || !key.secret) {
      return { status: 'unverifiable', keyId: signature.keyId, reason: 'the configured key is not an HMAC key' };
    }
    const ok = hmacMatches(key.secret, bytes, signature.value);
    return ok
      ? { status: 'verified', keyId: signature.keyId, reason: 'the HMAC signature matches' }
      : { status: 'failed', keyId: signature.keyId, reason: 'the HMAC signature does not match the package' };
  }
  if (signature.algorithm === 'ed25519') {
    if (key.type !== 'ed25519' || !key.publicKey) {
      return { status: 'unverifiable', keyId: signature.keyId, reason: 'the configured key is not an ed25519 key' };
    }
    let ok = false;
    try {
      ok = crypto.verify(null, bytes, key.publicKey, Buffer.from(signature.value, 'base64'));
    } catch (e) {
      return {
        status: 'failed',
        keyId: signature.keyId,
        reason: 'the signature could not be checked: ' + String((e && e.message) || e),
      };
    }
    return ok
      ? { status: 'verified', keyId: signature.keyId, reason: 'the ed25519 signature is valid' }
      : { status: 'failed', keyId: signature.keyId, reason: 'the ed25519 signature is not valid for this package' };
  }
  return {
    status: 'unverifiable',
    keyId: signature.keyId,
    reason: 'unsupported signature algorithm: ' + signature.algorithm,
  };
}

/**
 * Sign a document with an HMAC secret. Used by whoever publishes a registry
 * to produce the value a mirror will carry.
 */
function signHmac(document, secret) {
  return crypto.createHmac('sha256', String(secret)).update(signingBytes(document)).digest('hex');
}

module.exports = { canonicalise, signingBytes, verify, signHmac };
