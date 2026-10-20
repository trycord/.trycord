// A simulated device: the client half of the protocol.
//
// The tests need something that holds keys, publishes prekeys, runs the key
// agreement and encrypts and decrypts messages, without a browser. This is
// that device.
//
// It is the same code path a real client follows. The private keys stay in
// this process; the server is only ever given the public halves, the
// signatures and the sealed blobs. That is the whole point of the exercise:
// if a test can derive a key from what the server holds, the protocol is
// broken, and the test says so.

'use strict';

const crypto = require('node:crypto');

const primitives = require('../../src/services/e2ee/primitives');
const deviceKeys = require('../../src/services/e2ee/deviceKeys');
const prekeys = require('../../src/services/e2ee/prekeys');
const ratchet = require('../../src/services/e2ee/ratchet');
const x3dh = require('../../src/services/e2ee/x3dh');
const envelope = require('../../src/services/e2ee/envelope');
const sealing = require('../../src/services/e2ee/sealing');
const group = require('../../src/services/e2ee/group');
const attachments = require('../../src/services/e2ee/attachments');
const protocol = require('../../src/services/e2ee/protocol');

/** A device with fresh keys. */
function createDevice(userId, label) {
  return {
    userId,
    label,
    deviceId: crypto.randomUUID(),
    keys: deviceKeys.generateKeySet(),
    oneTimePreKeys: new Map(),
  };
}

/** The public halves of a device, in the shape the API uses. */
function publicKeys(device) {
  return deviceKeys.publicKeySet(device.keys);
}

/** The device's Ed25519 identity key, as a key object. */
function identityKeyObject(device) {
  return primitives.importPrivate('ed25519', device.keys.sk.privateKey, device.keys.sk.publicKey);
}

/** The device's signature over its own bundle. */
function bundleSignature(device) {
  const pubs = publicKeys(device);
  const bytes = prekeys.bundleSignatureBytes({
    userId: device.userId,
    deviceId: device.deviceId,
    identityKey: pubs.identityKey,
    identityDhKey: pubs.identityDhKey,
    signedPreKey: pubs.signedPreKey,
  });
  return primitives.b64(primitives.sign(identityKeyObject(device), bytes));
}

/** A batch of one-time prekeys, each signed by the device. */
function oneTimePreKeys(device, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const pair = primitives.generateKeyPair('x25519');
    const id = crypto.randomUUID();
    device.oneTimePreKeys.set(id, pair);
    const pubs = publicKeys(device);
    const bytes = prekeys.prekeySignatureBytes({
      userId: device.userId,
      deviceId: device.deviceId,
      identityKey: pubs.identityKey,
      identityDhKey: pubs.identityDhKey,
      signedPreKey: pubs.signedPreKey,
      prekeyId: id,
      publicKey: primitives.b64(pair.publicKey),
    });
    out.push({
      id,
      publicKey: primitives.b64(pair.publicKey),
      signature: primitives.b64(primitives.sign(identityKeyObject(device), bytes)),
    });
  }
  return out;
}

/** The body that registers a device. */
function registerBody(device, options = {}) {
  const pubs = publicKeys(device);
  const body = {
    id: device.deviceId,
    label: device.label,
    identityKey: pubs.identityKey,
    identityDhKey: pubs.identityDhKey,
    signedPreKey: pubs.signedPreKey,
    keyFingerprint: deviceKeys.fingerprint(pubs.identityKey),
    signature: bundleSignature(device),
  };
  if (options.withRecovery) {
    const recoveryKey = deviceKeys.generateRecoveryKey();
    const sealed = deviceKeys.sealPrivateMaterial(device.keys, recoveryKey);
    body.wrappedPrivateKey = JSON.stringify(sealed);
    body.recoverySalt = sealed.salt;
    body.recoveryIterations = sealed.iterations;
    body.recoveryKey = recoveryKey;
  }
  return body;
}

/** The body that publishes a bundle. */
function publishBody(device, count = 3) {
  const pubs = publicKeys(device);
  return {
    deviceId: device.deviceId,
    identityKey: pubs.identityKey,
    identityDhKey: pubs.identityDhKey,
    signedPreKey: pubs.signedPreKey,
    signature: bundleSignature(device),
    oneTimePreKeys: oneTimePreKeys(device, count),
  };
}

/**
 * Check a bundle the way a client has to: the signature over the bundle
 * and the signature over the one-time prekey in it, both verified with the
 * identity key the bundle carries.
 */
function verifyBundle(bundle) {
  const pubs = {
    identityKey: bundle.identityKey,
    identityDhKey: bundle.identityDhKey,
    signedPreKey: bundle.signedPreKey,
  };
  const bundleOk = prekeys.signatureVerifies(
    bundle.identityKey,
    prekeys.bundleSignatureBytes({
      userId: bundle.userId,
      deviceId: bundle.deviceId,
      ...pubs,
    }),
    bundle.signature
  );
  let prekeyOk = true;
  if (bundle.oneTimePreKey) {
    prekeyOk = prekeys.signatureVerifies(
      bundle.identityKey,
      prekeys.prekeySignatureBytes({
        userId: bundle.userId,
        deviceId: bundle.deviceId,
        ...pubs,
        prekeyId: bundle.oneTimePreKey.id,
        publicKey: bundle.oneTimePreKey.publicKey,
      }),
      bundle.oneTimePreKey.signature
    );
  }
  return { bundleOk, prekeyOk };
}

/**
 * The initiator's half of the agreement.
 *
 * @param {object} device
 * @param {object} peerBundle the bundle taken from the server
 */
function initiate(device, peerBundle) {
  const agreed = x3dh.initiate({
    ownSignedPreKeyPrivate: device.keys.spk.privateKey,
    ownSignedPreKeyPublic: device.keys.spk.publicKey,
    peer: {
      identityDhKey: peerBundle.identityDhKey,
      signedPreKey: peerBundle.signedPreKey,
      oneTimePreKey: peerBundle.oneTimePreKey ? peerBundle.oneTimePreKey.publicKey : null,
      oneTimePreKeyId: peerBundle.oneTimePreKey ? peerBundle.oneTimePreKey.id : null,
    },
  });
  return {
    secret: agreed.secret,
    ephemeralPublicKey: agreed.ephemeralPublicKey,
    oneTimePreKeyId: agreed.oneTimePreKeyId,
    state: ratchet.initiatorState(agreed.secret, peerBundle.signedPreKey),
  };
}

/**
 * The first message of a session, which carries what the responder needs
 * to agree the same secret: the initiator's ephemeral key, its identity
 * key and its signed prekey, signed by its identity key.
 */
function buildInit(device, context, agreed) {
  const pubs = publicKeys(device);
  const init = {
    ek: primitives.b64(agreed.ephemeralPublicKey),
    ik: pubs.identityDhKey,
    spk: pubs.signedPreKey,
    oneTimePreKeyId: agreed.oneTimePreKeyId || '',
  };
  init.signature = primitives.b64(primitives.sign(identityKeyObject(device), envelope.initSignatureBytes({
    sid: context.sid,
    cid: context.cid,
    from: device.deviceId,
    to: context.to,
    ek: init.ek,
    ik: init.ik,
    spk: init.spk,
    oneTimePreKeyId: init.oneTimePreKeyId,
  })));
  return init;
}

/**
 * Encrypt a message, optionally as the first message of a session.
 *
 * @returns {{envelope: object, state: object}}
 */
function encrypt(device, state, plaintext, context) {
  return ratchet.encrypt(state, plaintext, {
    sid: context.sid,
    cid: context.cid,
    from: device.deviceId,
    to: context.to,
    init: context.init || null,
  });
}

/**
 * The responder's half: check the first message, agree the secret and read
 * the message.
 *
 * @param {object} device        the responder
 * @param {object} env           the envelope
 * @param {object} peerBundle    the initiator's published bundle, from the
 *                                server, which is where the identity key
 *                                that verifies the message comes from
 */
function respond(device, env, peerBundle, context) {
  if (!env.init) throw new Error('the first message of a session carries the key agreement');
  const pubs = publicKeys(device);
  const signatureOk = primitives.verify(
    primitives.importPublic('ed25519', primitives.unb64(peerBundle.identityKey)),
    envelope.initSignatureBytes({
      sid: env.sid,
      cid: env.cid,
      from: env.from,
      to: env.to,
      ek: env.init.ek,
      ik: env.init.ik,
      spk: env.init.spk,
      oneTimePreKeyId: env.init.oneTimePreKeyId || '',
    }),
    primitives.unb64(env.init.signature)
  );
  if (!signatureOk) throw new Error('the first message of the session is not signed by that device');

  const oneTime = env.init.oneTimePreKeyId ? device.oneTimePreKeys.get(env.init.oneTimePreKeyId) : null;
  const secret = x3dh.respond({
    ownIdentityDhPrivate: device.keys.ik.privateKey,
    ownIdentityDhPublic: device.keys.ik.publicKey,
    ownSignedPreKeyPrivate: device.keys.spk.privateKey,
    ownSignedPreKeyPublic: device.keys.spk.publicKey,
    ownOneTimePreKeyPrivate: oneTime ? oneTime.privateKey : null,
    ownOneTimePreKeyPublic: oneTime ? oneTime.publicKey : null,
    peerEphemeralPublicKey: primitives.unb64(env.init.ek),
    peerSignedPreKeyPublic: primitives.unb64(env.init.spk),
  });
  const state = ratchet.responderState(secret, device.keys.spk, primitives.unb64(env.dh));
  const out = ratchet.decrypt(state, env, { sid: env.sid, cid: env.cid, to: device.deviceId });
  return { plaintext: out.plaintext, state: out.state, secret, identityDhKey: pubs.identityDhKey };
}

/**
 * Seal a conversation key to a device, the way a client does.
 *
 * The key is agreed with the device's identity key and an ephemeral key
 * that is thrown away afterwards, so the server can store the seal without
 * being able to open it.
 */
function sealConversationKey(conversationId, epoch, key, targetIdentityDhPublic) {
  return sealing.seal(
    key,
    primitives.unb64(targetIdentityDhPublic),
    group.sealAad(conversationId, epoch),
    protocol.GROUP_SEAL_INFO
  );
}

/** Open a conversation key seal with the device's own identity key. */
function openConversationKey(conversationId, epoch, seal, device) {
  return sealing.open(
    seal,
    device.keys.ik.privateKey,
    device.keys.ik.publicKey,
    group.sealAad(conversationId, epoch),
    protocol.GROUP_SEAL_INFO
  );
}

/**
 * Seal an attachment key to a device, the way a client does.
 *
 * The key is agreed with the device's identity key and an ephemeral key that
 * is thrown away afterwards, so the server can store the seal without being
 * able to open it.
 */
function sealAttachmentKey(conversationId, attachmentId, key, targetIdentityDhPublic) {
  return sealing.seal(
    key,
    primitives.unb64(targetIdentityDhPublic),
    attachments.sealAad(conversationId, attachmentId),
    protocol.ATTACHMENT_SEAL_INFO
  );
}

/** Open an attachment key seal with the device's own identity key. */
function openAttachmentKey(conversationId, attachmentId, seal, device) {
  return sealing.open(
    seal,
    device.keys.ik.privateKey,
    device.keys.ik.publicKey,
    attachments.sealAad(conversationId, attachmentId),
    protocol.ATTACHMENT_SEAL_INFO
  );
}

module.exports = {
  createDevice,
  publicKeys,
  bundleSignature,
  oneTimePreKeys,
  registerBody,
  publishBody,
  verifyBundle,
  initiate,
  buildInit,
  encrypt,
  respond,
  sealConversationKey,
  openConversationKey,
  sealAttachmentKey,
  openAttachmentKey,
};
