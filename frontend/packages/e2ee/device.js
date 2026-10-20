// The device: this browser's own identity in the protocol.
//
// A device has an Ed25519 identity key it signs with, an X25519 identity key
// it agrees secrets with, a signed prekey the server hands out, and a supply
// of one-time prekeys that are used once each.
//
// The private halves live in the device store and nowhere else. What the
// server is given is the public keys, a signature over the bundle, and - if
// the reader wants a backup - the private material sealed under a key derived
// from a recovery key the server never sees.

import { b64, unb64, randomBytes, utf8 } from './bytes.js';
import { generateKeyPair, sign, GCM_IV_BYTES } from './primitives.js';
import { generateKeySet, publicKeySet, privateKeySet, restoreKeySet, fingerprint, generateRecoveryKey, sealPrivateMaterial, sealPrivateBytes } from './deviceKeys.js';
import { bundleSignatureBytes, prekeySignatureBytes } from './prekeys.js';
import { readRecord, writeRecord } from './store.js';

/** The record name the device is kept under. */
export const DEVICE_RECORD = 'device';

/** How many one-time prekeys a device publishes at a time. */
export const PREKEY_BATCH = 30;

/** Below this many, the device publishes a fresh batch. */
export const PREKEY_LOW_WATER = 10;

/** An id of the shape the server accepts. */
export function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/**
 * A device: its keys, its prekeys, and what it tells the server about itself.
 */
export class Device {
  /**
   * @param {object} record the stored device record
   */
  constructor(record) {
    this.id = record.id;
    this.userId = record.userId;
    this.label = record.label;
    this.createdAt = record.createdAt || null;
    this.keys = restoreKeySet(record.keys);
    this.oneTimePreKeys = record.oneTimePreKeys || {};
    this.recoveryKey = record.recoveryKey || null;
    this.sealedPrivateKey = record.sealedPrivateKey || null;
  }

  /** The public halves, in the shape the API uses. */
  publicKeys() {
    return publicKeySet(this.keys);
  }

  /** The private halves, in the shape the recovery blob holds. */
  privateKeys() {
    return privateKeySet(this.keys);
  }

  /** The device's signature over its own bundle. */
  bundleSignature() {
    const pubs = this.publicKeys();
    return b64(sign(
      this.keys.sk.privateKey,
      bundleSignatureBytes({
        userId: this.userId,
        deviceId: this.id,
        identityKey: pubs.identityKey,
        identityDhKey: pubs.identityDhKey,
        signedPreKey: pubs.signedPreKey,
      }),
    ));
  }

  /** The fingerprint a reader compares: the hex SHA-256 of the identity key. */
  fingerprint() {
    return fingerprint(this.publicKeys().identityKey);
  }

  /**
   * A batch of one-time prekeys, each signed by the device.
   *
   * The private half of each stays on the device; the sealed copy goes to the
   * server with the bundle, so a device that loses its store can still be
   * recovered.
   */
  async oneTimePreKeyBatch(count) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const pair = generateKeyPair('x25519');
      const id = newId();
      this.oneTimePreKeys[id] = {
        publicKey: b64(pair.publicKey),
        privateKey: b64(pair.privateKey),
      };
      const pubs = this.publicKeys();
      const bytes = prekeySignatureBytes({
        userId: this.userId,
        deviceId: this.id,
        identityKey: pubs.identityKey,
        identityDhKey: pubs.identityDhKey,
        signedPreKey: pubs.signedPreKey,
        prekeyId: id,
        publicKey: b64(pair.publicKey),
      });
      const entry = {
        id,
        publicKey: b64(pair.publicKey),
        signature: b64(sign(this.keys.sk.privateKey, bytes)),
      };
      if (this.recoveryKey) {
        // The sealed private half goes to the server with the bundle, so a
        // device that has lost its store can still open a session that used
        // one of these prekeys. The server cannot open it, and it travels as
        // text: the server keeps it in a text column.
        entry.sealedPrivateKey = JSON.stringify(await sealPrivateBytes(pair.privateKey, this.recoveryKey));
      }
      out.push(entry);
    }
    return out;
  }

  /** How many one-time prekeys are still on the device. */
  preKeyCount() {
    return Object.keys(this.oneTimePreKeys).length;
  }

  /** The body that registers the device with the server. */
  async registrationBody(options = {}) {
    const pubs = this.publicKeys();
    const body = {
      id: this.id,
      label: this.label,
      identityKey: pubs.identityKey,
      identityDhKey: pubs.identityDhKey,
      signedPreKey: pubs.signedPreKey,
      keyFingerprint: await this.fingerprint(),
      signature: this.bundleSignature(),
    };
    if (options.sealedPrivateKey) {
      body.wrappedPrivateKey = JSON.stringify(options.sealedPrivateKey);
      body.recoverySalt = options.sealedPrivateKey.salt;
      body.recoveryIterations = options.sealedPrivateKey.iterations;
    }
    return body;
  }

  /** The body that publishes a prekey bundle. */
  publishBody(prekeys) {
    const pubs = this.publicKeys();
    return {
      deviceId: this.id,
      identityKey: pubs.identityKey,
      identityDhKey: pubs.identityDhKey,
      signedPreKey: pubs.signedPreKey,
      signature: this.bundleSignature(),
      oneTimePreKeys: prekeys,
    };
  }

  /** The record as it is kept. */
  toRecord() {
    return {
      id: this.id,
      userId: this.userId,
      label: this.label,
      createdAt: this.createdAt,
      keys: this.privateKeys(),
      oneTimePreKeys: this.oneTimePreKeys,
      recoveryKey: this.recoveryKey,
      sealedPrivateKey: this.sealedPrivateKey,
    };
  }
}

/**
 * The device this browser already has, or null.
 */
export async function loadDevice(store) {
  const record = await readRecord(store, DEVICE_RECORD);
  if (!record || !record.id || !record.keys) return null;
  return new Device(record);
}

/**
 * Keep the device in the store.
 */
export async function saveDevice(store, device) {
  await writeRecord(store, DEVICE_RECORD, device.toRecord());
  return device;
}

/**
 * A new device for an account.
 *
 * The recovery key is generated here and never leaves the device in the
 * clear: it is what the private material is sealed under, and it is what the
 * reader keeps.
 */
export async function createDevice(options) {
  const keys = generateKeySet();
  const record = {
    id: options.id || newId(),
    userId: options.userId,
    label: options.label || 'This browser',
    createdAt: new Date().toISOString(),
    keys: privateKeySet(keys),
    oneTimePreKeys: {},
    recoveryKey: options.recoveryKey || generateRecoveryKey(),
    sealedPrivateKey: null,
  };
  const device = new Device(record);
  // The sealed copy is what the server keeps and what a recovery opens. It
  // is made here so the device is ready to be recovered from the moment it
  // exists, and it is sealed under a key the server never sees.
  device.sealedPrivateKey = await sealPrivateMaterial(keys, device.recoveryKey);
  return device;
}

/**
 * The private material sealed under the recovery key, made if it is not there
 * yet.
 */
export async function ensureSealedPrivateKey(device) {
  if (device.sealedPrivateKey) return device.sealedPrivateKey;
  device.sealedPrivateKey = await sealPrivateMaterial(device.keys, device.recoveryKey);
  return device.sealedPrivateKey;
}
