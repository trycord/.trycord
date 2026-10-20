// Devices, in the shapes the two halves use.
//
// The client holds its keys as Uint8Arrays and the server holds them as Node
// buffers. The values are the same; only the container differs, and a check
// that compares the two halves has to say so rather than pretend it does not.

import * as e from '../../../packages/e2ee/index.js';
import { server } from './server.js';

const toBuffer = (bytes) => Buffer.from(bytes);

/** A device on the client's side: keys, public halves and an id. */
export async function makeDevice(userId, label) {
  const keys = e.generateKeySet();
  return {
    id: e.newId(),
    userId,
    label,
    keys,
    public: e.publicKeySet(keys),
  };
}

/** The same device in the shape the server's own helpers take. */
export function asServerDevice(device) {
  return {
    userId: device.userId,
    deviceId: device.id,
    label: device.label,
    keys: {
      ik: { publicKey: toBuffer(device.keys.ik.publicKey), privateKey: toBuffer(device.keys.ik.privateKey) },
      sk: { publicKey: toBuffer(device.keys.sk.publicKey), privateKey: toBuffer(device.keys.sk.privateKey) },
      spk: { publicKey: toBuffer(device.keys.spk.publicKey), privateKey: toBuffer(device.keys.spk.privateKey) },
    },
    oneTimePreKeys: new Map(),
  };
}

/**
 * The prekey bundle the server would hand out for a device.
 *
 * It is signed with the device's identity key, exactly as the server signs
 * it, so the client's own check of the signature is exercised.
 */
export function bundleFor(device) {
  const shaped = asServerDevice(device);
  const pubs = server.client.publicKeys(shaped);
  return {
    version: server.protocol.PROTOCOL_VERSION,
    userId: shaped.userId,
    deviceId: shaped.deviceId,
    label: shaped.label,
    identityKey: pubs.identityKey,
    identityDhKey: pubs.identityDhKey,
    signedPreKey: pubs.signedPreKey,
    signature: server.client.bundleSignature(shaped),
    keyFingerprint: '',
    oneTimePreKey: null,
  };
}

/**
 * The initiator's half of an agreement, from the client's side.
 *
 * @returns {Promise<{secret: Uint8Array, state: object, ephemeralPublicKey: Uint8Array}>}
 */
export async function agreeAsInitiator(device, peerBundle) {
  const agreed = await e.initiate({
    ownSignedPreKeyPrivate: device.keys.spk.privateKey,
    ownSignedPreKeyPublic: device.keys.spk.publicKey,
    peer: {
      identityDhKey: e.unb64(peerBundle.identityDhKey),
      signedPreKey: e.unb64(peerBundle.signedPreKey),
      oneTimePreKey: peerBundle.oneTimePreKey ? e.unb64(peerBundle.oneTimePreKey.publicKey) : null,
      oneTimePreKeyId: peerBundle.oneTimePreKey ? peerBundle.oneTimePreKey.id : null,
    },
  });
  const state = await e.initiatorState(agreed.secret, peerBundle.signedPreKey);
  return { secret: agreed.secret, state, ephemeralPublicKey: agreed.ephemeralPublicKey };
}

/**
 * The key agreement of a session's first message, signed the way the client
 * signs it.
 */
export function buildInit(device, context, agreed, oneTimePreKeyId) {
  const init = {
    ek: e.b64(agreed.ephemeralPublicKey),
    ik: device.public.identityDhKey,
    spk: device.public.signedPreKey,
    oneTimePreKeyId: oneTimePreKeyId || '',
  };
  init.signature = e.b64(e.sign(device.keys.sk.privateKey, e.initSignatureBytes({
    sid: context.sid,
    cid: context.cid,
    from: context.from,
    to: context.to,
    ek: init.ek,
    ik: init.ik,
    spk: init.spk,
    oneTimePreKeyId: init.oneTimePreKeyId,
  })));
  return init;
}
