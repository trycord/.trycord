// Sealing a key to a device.
//
// A conversation key and an attachment key are symmetric, and symmetric keys
// cannot be sent to a device that only has a public key. So the sender
// agrees a key with each device, using that device's public identity key and
// an ephemeral key of its own, and seals the symmetric key under the
// agreement.
//
//   shared = ECDH(ephemeral private, device identity public)
//   kek    = HKDF-SHA256(shared, salt = 32 zero bytes, info = <the label>)
//   seal   = AES-256-GCM(kek, iv, key, aad)
//
// The server stores the seal and the ephemeral public key. It cannot open
// the seal: the ephemeral private key is thrown away as soon as the seals
// are made, and the device's identity private key never leaves the device.
// The server therefore learns the conversation's key from nobody, and it
// cannot re-seal that key for a device it was not given it for.
//
// The associated data binds the seal to what it is for - a conversation and
// an epoch, or an attachment - so a seal cannot be moved to another
// conversation and opened there.

'use strict';

const primitives = require('./primitives');
const protocol = require('./protocol');

/**
 * Seal a symmetric key to a device.
 *
 * @param {Buffer} key                the symmetric key
 * @param {Buffer} deviceIdentityDh   the device's X25519 identity public key
 * @param {Buffer} aad                what the seal is bound to
 * @param {string} info               the derivation label
 * @returns {{ephemeralPublicKey: string, iv: string, ciphertext: string, tag: string}}
 */
function seal(key, deviceIdentityDh, aad, info) {
  const ephemeral = primitives.generateKeyPair('x25519');
  const shared = primitives.ecdh(
    primitives.importPrivate('x25519', ephemeral.privateKey, ephemeral.publicKey),
    primitives.importPublic('x25519', deviceIdentityDh)
  );
  const kek = primitives.hkdf(shared, protocol.ZERO_SALT, info, primitives.KEY_BYTES);
  const iv = primitives.randomBytes(primitives.GCM_IV_BYTES);
  const sealed = primitives.encrypt(kek, iv, key, Buffer.from(aad));
  return {
    ephemeralPublicKey: primitives.b64(ephemeral.publicKey),
    iv: primitives.b64(sealed.iv),
    ciphertext: primitives.b64(sealed.ciphertext),
    tag: primitives.b64(sealed.tag),
  };
}

/**
 * Open a seal with the device's own identity key.
 *
 * Throws when the seal was not made for this device or has been altered:
 * the GCM tag does not verify, and that is the answer.
 */
function open(sealValue, deviceIdentityDhPrivate, deviceIdentityDhPublic, aad, info) {
  const shared = primitives.ecdh(
    primitives.importPrivate('x25519', deviceIdentityDhPrivate, deviceIdentityDhPublic),
    primitives.importPublic('x25519', primitives.unb64(sealValue.ephemeralPublicKey))
  );
  const kek = primitives.hkdf(shared, protocol.ZERO_SALT, info, primitives.KEY_BYTES);
  return primitives.decrypt(
    kek,
    primitives.unb64(sealValue.iv),
    primitives.unb64(sealValue.ciphertext),
    primitives.unb64(sealValue.tag),
    Buffer.from(aad)
  );
}

module.exports = { seal, open };
