// The bytes a device signs.
//
// The signature over a prekey bundle is the device's proof that it holds the
// private half of its identity key, and it is the same signature a peer
// checks when it fetches the bundle. One signature, two jobs: the server
// learns the registrant is not posting somebody else's key, and a client
// learns the bundle it was handed is the one the device published.
//
// These are the server's byte strings, field for field and label for label.
// A client that signs different bytes produces bundles the server refuses and
// signatures the peer does not accept.

import { canonical } from './protocol.js';
import { PREKEY_SIGNATURE_CONTEXT, PROTOCOL_VERSION } from './protocol.js';
import { verify } from './primitives.js';
import { unb64 } from './bytes.js';

/**
 * The bytes a device signs when it registers and publishes.
 *
 * @param {object} fields { userId, deviceId, identityKey, identityDhKey, signedPreKey }
 */
export function bundleSignatureBytes(fields) {
  return canonical(
    ['context', PREKEY_SIGNATURE_CONTEXT],
    ['version', PROTOCOL_VERSION],
    ['user', fields.userId],
    ['device', fields.deviceId],
    ['identity', fields.identityKey],
    ['identityDh', fields.identityDhKey],
    ['signedPreKey', fields.signedPreKey],
  );
}

/**
 * The bytes a device signs for one of its one-time prekeys.
 *
 * The prekey's signature commits to the device's bundle as well, so a prekey
 * cannot be moved to another device and used to start a session under keys
 * the peer did not expect.
 */
export function prekeySignatureBytes(fields) {
  return canonical(
    ['context', PREKEY_SIGNATURE_CONTEXT],
    ['version', PROTOCOL_VERSION],
    ['user', fields.userId],
    ['device', fields.deviceId],
    ['identity', fields.identityKey],
    ['identityDh', fields.identityDhKey],
    ['signedPreKey', fields.signedPreKey],
    ['prekeyId', fields.prekeyId],
    ['prekey', fields.publicKey],
  );
}

/** Whether a signature verifies against an identity key. */
export function signatureVerifies(identityKey, message, signature) {
  if (!identityKey || !signature) return false;
  try {
    return verify(unb64(identityKey), message, unb64(signature));
  } catch {
    return false;
  }
}
