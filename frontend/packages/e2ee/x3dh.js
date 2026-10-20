// Session establishment: X3DH, as published by Signal.
//
// The design this follows is https://signal.org/docs/specifications/x3dh/.
// A session starts with four Diffie-Hellman agreements between the two
// devices, so that the session secret is not derived from a single key
// exchange the server could replace:
//
//   DH1 = DH(IK_b, SPK_a)   the responder's identity key with the
//                            initiator's signed prekey
//   DH2 = DH(EK_a, IK_b)    the initiator's ephemeral key with the
//                            responder's identity key
//   DH3 = DH(EK_a, SPK_b)   the initiator's ephemeral key with the
//                            responder's signed prekey
//   DH4 = DH(EK_a, OPK_b)   the initiator's ephemeral key with the
//                            responder's one-time prekey, when one was
//                            published
//
//   SK = HKDF-SHA256(DH1 || DH2 || DH3 [|| DH4], salt = 32 zero bytes,
//                    info = "trycord-x3dh-v1", 32 bytes)
//
// The server holds IK_b, SPK_b and OPK_b, and the ephemeral key EK_a once
// the initiator publishes it in the first message. It holds none of the
// private halves, so it can compute none of the DH outputs and cannot compute
// SK. The one-time prekey is what makes the responder's copy of SK safe to
// erase: it is consumed on use, so an attacker who copies the server's rows
// later cannot derive the session.
//
// This is the server's x3dh.js, in the client's terms: the same four
// agreements, in the same order, over the same label.

import { ecdh, generateKeyPair, hkdf } from './primitives.js';
import { KEY_BYTES } from './primitives.js';
import { X3DH_INFO, ZERO_SALT } from './protocol.js';
import { concatBytes } from './bytes.js';

/** The session secret from a list of Diffie-Hellman outputs. */
export async function deriveSecret(dhValues) {
  if (!dhValues.length) throw new Error('a session secret needs at least one DH output');
  return hkdf(concatBytes(...dhValues), ZERO_SALT, X3DH_INFO, KEY_BYTES);
}

/**
 * The initiator's half of the agreement.
 *
 * @param {object} params
 * @param {Uint8Array} params.ownSignedPreKeyPrivate  the initiator's SPK private half
 * @param {Uint8Array} params.ownSignedPreKeyPublic   the initiator's SPK public half
 * @param {object} params.peer  the responder's published bundle:
 *        identityDhKey (X25519 public), signedPreKey (X25519 public),
 *        oneTimePreKey (X25519 public or null), oneTimePreKeyId (string or null)
 * @returns {Promise<{secret: Uint8Array, ephemeralPublicKey: Uint8Array,
 *   oneTimePreKeyId: string|null}>}
 */
export async function initiate(params) {
  const ephemeral = generateKeyPair('x25519');
  const dh = [];
  // DH1 = DH(IK_b, SPK_a)
  dh.push(ecdh(params.ownSignedPreKeyPrivate, params.peer.identityDhKey));
  // DH2 = DH(EK_a, IK_b)
  dh.push(ecdh(ephemeral.privateKey, params.peer.identityDhKey));
  // DH3 = DH(EK_a, SPK_b)
  dh.push(ecdh(ephemeral.privateKey, params.peer.signedPreKey));

  let oneTimePreKeyId = null;
  if (params.peer.oneTimePreKey) {
    // DH4 = DH(EK_a, OPK_b)
    dh.push(ecdh(ephemeral.privateKey, params.peer.oneTimePreKey));
    oneTimePreKeyId = params.peer.oneTimePreKeyId || null;
  }

  return {
    secret: await deriveSecret(dh),
    ephemeralPublicKey: ephemeral.publicKey,
    oneTimePreKeyId,
  };
}

/**
 * The responder's half of the agreement.
 *
 * @param {object} params
 * @param {Uint8Array} params.ownIdentityDhPrivate   the responder's IK private half
 * @param {Uint8Array} params.ownIdentityDhPublic
 * @param {Uint8Array} params.ownSignedPreKeyPrivate the responder's SPK private half
 * @param {Uint8Array} params.ownSignedPreKeyPublic
 * @param {Uint8Array|null} params.ownOneTimePreKeyPrivate  the OPK that was consumed
 * @param {Uint8Array|null} params.ownOneTimePreKeyPublic
 * @param {Uint8Array} params.peerEphemeralPublicKey  EK_a, from the first message
 * @param {Uint8Array} params.peerSignedPreKeyPublic  SPK_a, from the first message
 * @returns {Promise<Uint8Array>} the session secret
 */
export async function respond(params) {
  const dh = [];
  // DH1 = DH(IK_b, SPK_a)
  dh.push(ecdh(params.ownIdentityDhPrivate, params.peerSignedPreKeyPublic));
  // DH2 = DH(EK_a, IK_b)
  dh.push(ecdh(params.ownIdentityDhPrivate, params.peerEphemeralPublicKey));
  // DH3 = DH(EK_a, SPK_b)
  dh.push(ecdh(params.ownSignedPreKeyPrivate, params.peerEphemeralPublicKey));
  if (params.ownOneTimePreKeyPrivate) {
    // DH4 = DH(EK_a, OPK_b)
    dh.push(ecdh(params.ownOneTimePreKeyPrivate, params.peerEphemeralPublicKey));
  }
  return deriveSecret(dh);
}
