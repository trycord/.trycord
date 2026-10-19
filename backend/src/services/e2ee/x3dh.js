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
// private halves, so it can compute none of the DH outputs and cannot
// compute SK. The one-time prekey is what makes the responder's copy of
// SK safe to erase: it is consumed on use, so an attacker who copies the
// server's rows later cannot derive the session.

'use strict';

const primitives = require('./primitives');
const protocol = require('./protocol');

/** The session secret from a list of Diffie-Hellman outputs. */
function deriveSecret(dhValues) {
  if (!dhValues.length) throw new Error('a session secret needs at least one DH output');
  return primitives.hkdf(
    Buffer.concat(dhValues),
    protocol.ZERO_SALT,
    protocol.X3DH_INFO,
    primitives.KEY_BYTES
  );
}

/**
 * The initiator's half of the agreement.
 *
 * @param {object} params
 * @param {Buffer} params.ownSignedPreKeyPrivate  the initiator's SPK private half
 * @param {Buffer} params.ownIdentityDhPrivate     the initiator's IK private half
 * @param {object} params.peer  the responder's published bundle:
 *        identityDhKey (X25519 public), signedPreKey (X25519 public),
 *        oneTimePreKey (X25519 public or null), oneTimePreKeyId (string or null)
 * @returns {{secret: Buffer, ephemeralPublicKey: Buffer, oneTimePreKeyId: string|null}}
 */
function initiate(params) {
  const peerIk = primitives.importPublic('x25519', params.peer.identityDhKey);
  const peerSpk = primitives.importPublic('x25519', params.peer.signedPreKey);
  const ephemeral = primitives.generateKeyPair('x25519');
  const ephemeralKey = primitives.importPrivate('x25519', ephemeral.privateKey, ephemeral.publicKey);
  const ownSpk = primitives.importPrivate(
    'x25519',
    params.ownSignedPreKeyPrivate,
    params.ownSignedPreKeyPublic
  );

  const dh = [];
  // DH1 = DH(IK_b, SPK_a)
  dh.push(primitives.ecdh(ownSpk, peerIk));
  // DH2 = DH(EK_a, IK_b)
  dh.push(primitives.ecdh(ephemeralKey, peerIk));
  // DH3 = DH(EK_a, SPK_b)
  dh.push(primitives.ecdh(ephemeralKey, peerSpk));

  let oneTimePreKeyId = null;
  if (params.peer.oneTimePreKey) {
    const peerOpk = primitives.importPublic('x25519', params.peer.oneTimePreKey);
    // DH4 = DH(EK_a, OPK_b)
    dh.push(primitives.ecdh(ephemeralKey, peerOpk));
    oneTimePreKeyId = params.peer.oneTimePreKeyId || null;
  }

  return {
    secret: deriveSecret(dh),
    ephemeralPublicKey: ephemeral.publicKey,
    oneTimePreKeyId,
  };
}

/**
 * The responder's half of the agreement.
 *
 * @param {object} params
 * @param {Buffer} params.ownIdentityDhPrivate    the responder's IK private half
 * @param {Buffer} params.ownIdentityDhPublic
 * @param {Buffer} params.ownSignedPreKeyPrivate  the responder's SPK private half
 * @param {Buffer} params.ownSignedPreKeyPublic
 * @param {Buffer|null} params.ownOneTimePreKeyPrivate  the OPK that was consumed
 * @param {Buffer|null} params.ownOneTimePreKeyPublic
 * @param {Buffer} params.peerEphemeralPublicKey  EK_a, from the first message
 * @param {Buffer} params.peerSignedPreKeyPublic  SPK_a, from the first message
 * @returns {Buffer} the session secret
 */
function respond(params) {
  const ownIk = primitives.importPrivate('x25519', params.ownIdentityDhPrivate, params.ownIdentityDhPublic);
  const ownSpk = primitives.importPrivate('x25519', params.ownSignedPreKeyPrivate, params.ownSignedPreKeyPublic);
  const peerEk = primitives.importPublic('x25519', params.peerEphemeralPublicKey);
  const peerSpk = primitives.importPublic('x25519', params.peerSignedPreKeyPublic);

  const dh = [];
  // DH1 = DH(IK_b, SPK_a)
  dh.push(primitives.ecdh(ownIk, peerSpk));
  // DH2 = DH(EK_a, IK_b)
  dh.push(primitives.ecdh(ownIk, peerEk));
  // DH3 = DH(EK_a, SPK_b)
  dh.push(primitives.ecdh(ownSpk, peerEk));
  if (params.ownOneTimePreKeyPrivate) {
    const ownOpk = primitives.importPrivate(
      'x25519',
      params.ownOneTimePreKeyPrivate,
      params.ownOneTimePreKeyPublic
    );
    // DH4 = DH(EK_a, OPK_b)
    dh.push(primitives.ecdh(ownOpk, peerEk));
  }
  return deriveSecret(dh);
}

module.exports = { deriveSecret, initiate, respond };
