// Sealing a key to a device.
//
// A conversation key and an attachment key are symmetric, and symmetric keys
// cannot be sent to a device that only has a public key. So the sender agrees
// a key with each device, using that device's public identity key and an
// ephemeral key of its own, and seals the symmetric key under the agreement.
//
//   shared = ECDH(ephemeral private, device identity public)
//   kek    = HKDF-SHA256(shared, salt = 32 zero bytes, info = <the label>)
//   seal   = AES-256-GCM(kek, iv, key, aad)
//
// The server stores the seal and the ephemeral public key. It cannot open the
// seal: the ephemeral private key is thrown away as soon as the seals are
// made, and the device's identity private key never leaves the device. The
// server therefore learns the conversation's key from nobody, and it cannot
// re-seal that key for a device it was not given it for.
//
// The associated data binds the seal to what it is for - a conversation and
// an epoch, or an attachment - so a seal cannot be moved to another
// conversation and opened there.

import { b64, unb64 } from './bytes.js';
import { ecdh, encrypt, decrypt, generateKeyPair, hkdf, randomBytes, GCM_IV_BYTES, KEY_BYTES } from './primitives.js';
import { ZERO_SALT } from './protocol.js';

/**
 * Seal a symmetric key to a device.
 *
 * @param {Uint8Array} key              the symmetric key
 * @param {Uint8Array} deviceIdentityDh the device's X25519 identity public key
 * @param {Uint8Array} aad              what the seal is bound to
 * @param {string} info                 the derivation label
 * @returns {Promise<{ephemeralPublicKey: string, iv: string, ciphertext: string, tag: string}>}
 */
export async function seal(key, deviceIdentityDh, aad, info) {
  const ephemeral = generateKeyPair('x25519');
  const shared = ecdh(ephemeral.privateKey, deviceIdentityDh);
  const kek = await hkdf(shared, ZERO_SALT, info, KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = await encrypt(kek, iv, key, aad);
  return {
    ephemeralPublicKey: b64(ephemeral.publicKey),
    iv: b64(sealed.iv),
    ciphertext: b64(sealed.ciphertext),
    tag: b64(sealed.tag),
  };
}

/**
 * Open a seal with the device's own identity key.
 *
 * Throws when the seal was not made for this device or has been altered: the
 * GCM tag does not verify, and that is the answer.
 */
export async function open(sealValue, deviceIdentityDhPrivate, deviceIdentityDhPublic, aad, info) {
  const shared = ecdh(deviceIdentityDhPrivate, unb64(sealValue.ephemeralPublicKey));
  const kek = await hkdf(shared, ZERO_SALT, info, KEY_BYTES);
  return decrypt(
    kek,
    unb64(sealValue.iv),
    unb64(sealValue.ciphertext),
    unb64(sealValue.tag),
    aad,
  );
}
