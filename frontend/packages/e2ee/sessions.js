// The session manager: one Double Ratchet per peer device.
//
// A session is between two devices. Each of this account's devices has its
// own session with each of the other member's devices, and the session id in
// an envelope is the sender's own name for it - the server keeps one record
// per sending device, and refuses an envelope that claims a session that is
// not the sender's.
//
// The state is kept in the device store and pushed to the server sealed, so
// that a device which loses its store can pick the session up again from the
// server and from the key backup. The server cannot read what it stores: the
// seal is under a key derived from the session secret, and the secret never
// leaves the device.

import { b64, unb64 } from './bytes.js';
import { sign } from './primitives.js';
import { initiate, respond } from './x3dh.js';
import * as ratchet from './ratchet.js';
import { initSignatureBytes, protocolError } from './envelope.js';
import { bundleSignatureBytes, prekeySignatureBytes, signatureVerifies } from './prekeys.js';
import { readRecord, writeRecord } from './store.js';
import { newId } from './device.js';
import { openPrivateBytes } from './deviceKeys.js';

/** The record the session index is kept under. */
export const SESSION_INDEX = 'sessions';

/** The record the peers' public keys are cached under. */
export const PEER_KEYS = 'peerKeys';

/** The name a session is kept under. */
function sessionKey(id) {
  return 'session:' + id;
}

/**
 * Check a bundle the way a client has to: the signature over the bundle and
 * the signature over the one-time prekey in it, both verified with the
 * identity key the bundle carries.
 *
 * This is what a server cannot forge: the server holds the public keys, so it
 * could hand a client a bundle of its own making, but it cannot sign that
 * bundle with the device's identity key.
 */
export function verifyBundle(bundle) {
  if (!bundle || !bundle.identityKey || !bundle.signature) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the prekey bundle is incomplete', 400);
  }
  const fields = {
    userId: bundle.userId,
    deviceId: bundle.deviceId,
    identityKey: bundle.identityKey,
    identityDhKey: bundle.identityDhKey,
    signedPreKey: bundle.signedPreKey,
  };
  if (!signatureVerifies(bundle.identityKey, bundleSignatureBytes(fields), bundle.signature)) {
    throw protocolError('E2EE_INVALID_SIGNATURE', 'the bundle signature does not verify', 400);
  }
  if (bundle.oneTimePreKey) {
    const signed = prekeySignatureBytes(Object.assign({}, fields, {
      prekeyId: bundle.oneTimePreKey.id,
      publicKey: bundle.oneTimePreKey.publicKey,
    }));
    if (!signatureVerifies(bundle.identityKey, signed, bundle.oneTimePreKey.signature)) {
      throw protocolError('E2EE_INVALID_SIGNATURE', 'the one-time prekey signature does not verify', 400);
    }
  }
  return bundle;
}

/**
 * The sessions of one device.
 */
export class SessionManager {
  /**
   * @param {object} deps { device, store, api }
   */
  constructor(deps) {
    this.device = deps.device;
    this.store = deps.store;
    this.api = deps.api;
  }

  /**
   * Say that something did not work, out loud.
   *
   * A failure that does not stop the message is still a failure, and a
   * failure nobody hears about is a failure nobody fixes.
   */
  report(message, error) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[trycord] ' + message, error);
    }
  }

  /** The index from peer device to session id. */
  async index() {
    return (await readRecord(this.store, SESSION_INDEX)) || {};
  }

  /** Keep a session. */
  async saveSession(session) {
    await writeRecord(this.store, sessionKey(session.id), session);
    const index = await this.index();
    index[session.peerDeviceId] = session.id;
    await writeRecord(this.store, SESSION_INDEX, index);
    return session;
  }

  /** A session by its id. */
  async sessionById(id) {
    return readRecord(this.store, sessionKey(id));
  }

  /** The session with one peer device, if there is one. */
  async sessionForPeer(peerDeviceId) {
    const index = await this.index();
    const id = index[peerDeviceId];
    if (!id) return null;
    return this.sessionById(id);
  }

  /** Every session this device holds. */
  async listSessions() {
    const index = await this.index();
    const out = [];
    for (const id of Object.values(index)) {
      const session = await this.sessionById(id);
      if (session) out.push(session);
    }
    return out;
  }

  /**
   * A peer's public keys, from the cache or from the server.
   *
   * The identity key a bundle carries is verified against the bundle's own
   * signature before it is cached, and the server pins a device's identity key
   * when the device registers, so a cached key stays true for the life of the
   * device.
   */
  async peerKeys(deviceId) {
    const cache = (await readRecord(this.store, PEER_KEYS)) || {};
    if (cache[deviceId]) return cache[deviceId];
    const answer = await this.api.prekeyBundle(deviceId);
    const bundle = verifyBundle(answer && answer.bundle);
    const keys = {
      userId: bundle.userId,
      deviceId: bundle.deviceId,
      identityKey: bundle.identityKey,
      identityDhKey: bundle.identityDhKey,
      signedPreKey: bundle.signedPreKey,
    };
    cache[deviceId] = keys;
    await writeRecord(this.store, PEER_KEYS, cache);
    return keys;
  }

  /**
   * Open a session with a peer device.
   *
   * The bundle is taken from the server, which hands out a one-time prekey
   * with it; the signatures are checked before anything in the bundle is
   * used.
   */
  async establish(peerDeviceId, options = {}) {
    const answer = await this.api.prekeyBundle(peerDeviceId);
    const bundle = verifyBundle(answer && answer.bundle);
    const agreed = await initiate({
      ownSignedPreKeyPrivate: this.device.keys.spk.privateKey,
      ownSignedPreKeyPublic: this.device.keys.spk.publicKey,
      peer: {
        identityDhKey: unb64(bundle.identityDhKey),
        signedPreKey: unb64(bundle.signedPreKey),
        oneTimePreKey: bundle.oneTimePreKey ? unb64(bundle.oneTimePreKey.publicKey) : null,
        oneTimePreKeyId: bundle.oneTimePreKey ? bundle.oneTimePreKey.id : null,
      },
    });
    const state = await ratchet.initiatorState(agreed.secret, bundle.signedPreKey);
    const session = {
      id: newId(),
      role: 'initiator',
      deviceId: this.device.id,
      peerDeviceId,
      peerUserId: bundle.userId || '',
      conversationId: options.conversationId || null,
      peerSid: null,
      secret: b64(agreed.secret),
      ephemeralPublicKey: b64(agreed.ephemeralPublicKey),
      oneTimePreKeyId: agreed.oneTimePreKeyId || '',
      state,
      pushedCounter: 0,
    };
    await this.saveSession(session);
    await this.registerOnServer(session);
    return session;
  }

  /** The session with a peer device, opened if it is not there yet. */
  async sessionFor(peerDeviceId, options = {}) {
    const existing = await this.sessionForPeer(peerDeviceId);
    if (existing) return existing;
    return this.establish(peerDeviceId, options);
  }

  /**
   * Tell the server about a session the client has opened.
   *
   * The server's record of a session is bookkeeping: the server allows an
   * envelope whose session it has not seen, and the state it stores is a
   * backup of what the device already holds. So a server that will not take
   * the record does not stop the message - but it is reported, because a
   * session the server does not know about is a session whose state is not
   * backed up.
   */
  async registerOnServer(session) {
    try {
      const sealed = await ratchet.sealState(session.state, unb64(session.secret));
      await this.api.createSession({
        id: session.id,
        deviceId: session.deviceId,
        peerDeviceId: session.peerDeviceId,
        peerUserId: session.peerUserId,
        conversationId: session.conversationId,
        ratchetState: sealed,
        sendCounter: session.state.ctr,
        recvCounter: session.state.peerCtr,
      });
      session.pushedCounter = session.state.ctr;
      await this.saveSession(session);
      return session;
    } catch (error) {
      this.report('the session could not be recorded with the server', error);
      return session;
    }
  }

  /**
   * Push the ratchet state to the server, sealed.
   *
   * The server refuses a state whose send counter has not moved forward: it
   * is either a replay or a state the client has already replaced. So the
   * push happens when the client has sent something, and not otherwise.
   */
  async pushState(session) {
    if (session.state.ctr <= session.pushedCounter) return session;
    const sealed = await ratchet.sealState(session.state, unb64(session.secret));
    await this.api.updateSession(session.id, {
      ratchetState: sealed,
      sendCounter: session.state.ctr,
      recvCounter: session.state.peerCtr,
    });
    session.pushedCounter = session.state.ctr;
    await this.saveSession(session);
    return session;
  }

  /**
   * The key agreement of a session's first message.
   *
   * It carries what the responder needs to agree the same secret: the
   * initiator's ephemeral key, its identity key and its signed prekey, signed
   * by its identity key.
   */
  buildInit(session, context) {
    const pubs = this.device.publicKeys();
    const init = {
      ek: session.ephemeralPublicKey,
      ik: pubs.identityDhKey,
      spk: pubs.signedPreKey,
      oneTimePreKeyId: session.oneTimePreKeyId || '',
    };
    init.signature = b64(sign(this.device.keys.sk.privateKey, initSignatureBytes({
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

  /**
   * Encrypt a message to one peer device.
   *
   * @param {object} session
   * @param {object} options { conversationId, plaintext }
   * @returns {Promise<{envelope: object, session: object}>}
   */
  async encryptTo(session, options) {
    const context = {
      sid: session.id,
      cid: options.conversationId,
      from: this.device.id,
      to: session.peerDeviceId,
    };
    // The agreement travels with the first message of the session and with no
    // other: it is what the responder needs to agree the secret.
    const init = session.role === 'initiator' && session.ephemeralPublicKey
      ? this.buildInit(session, context)
      : null;
    const out = await ratchet.encrypt(session.state, options.plaintext, {
      sid: context.sid,
      cid: context.cid,
      from: context.from,
      to: context.to,
      init,
    });
    session.state = out.state;
    if (init) {
      // The agreement has been sent. It is not sent again: the responder
      // already has the secret.
      session.ephemeralPublicKey = null;
      session.oneTimePreKeyId = '';
    }
    await this.saveSession(session);
    return { envelope: out.envelope, session };
  }

  /**
   * The one-time prekey the responder's agreement names.
   *
   * The private half is on the device, or - when the device has lost it - in
   * the sealed copy the server keeps, which the recovery key opens.
   *
   * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
   */
  async oneTimePreKey(prekeyId) {
    const local = this.device.oneTimePreKeys[prekeyId];
    if (local) {
      return { publicKey: unb64(local.publicKey), privateKey: unb64(local.privateKey) };
    }
    const claimed = await this.api.claimPrekey(this.device.id, prekeyId);
    const prekey = claimed && claimed.prekey;
    if (!prekey || !prekey.sealedPrivateKey) {
      throw protocolError(
        'E2EE_PREKEY_GONE',
        'the one-time prekey this message used is not available any more',
        409,
      );
    }
    return {
      publicKey: unb64(prekey.publicKey),
      privateKey: await openPrivateBytes(JSON.parse(prekey.sealedPrivateKey), this.device.recoveryKey),
    };
  }

  /**
   * Accept a session from the first message of a peer.
   *
   * The agreement in the message is signed by the sender's identity key, and
   * that signature is what says the message came from the device it claims.
   */
  async accept(envelope, options = {}) {
    const init = envelope.init;
    if (!init) {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the first message of a session carries the key agreement', 400);
    }
    const peer = await this.peerKeys(envelope.from);
    const signed = initSignatureBytes({
      sid: envelope.sid,
      cid: envelope.cid,
      from: envelope.from,
      to: envelope.to,
      ek: init.ek,
      ik: init.ik,
      spk: init.spk,
      oneTimePreKeyId: init.oneTimePreKeyId || '',
    });
    if (!signatureVerifies(peer.identityKey, signed, init.signature)) {
      throw protocolError(
        'E2EE_INVALID_SIGNATURE',
        'the first message of the session is not signed by that device',
        403,
      );
    }
    const oneTime = init.oneTimePreKeyId ? await this.oneTimePreKey(init.oneTimePreKeyId) : null;
    const secret = await respond({
      ownIdentityDhPrivate: this.device.keys.ik.privateKey,
      ownIdentityDhPublic: this.device.keys.ik.publicKey,
      ownSignedPreKeyPrivate: this.device.keys.spk.privateKey,
      ownSignedPreKeyPublic: this.device.keys.spk.publicKey,
      ownOneTimePreKeyPrivate: oneTime ? oneTime.privateKey : null,
      ownOneTimePreKeyPublic: oneTime ? oneTime.publicKey : null,
      peerEphemeralPublicKey: unb64(init.ek),
      peerSignedPreKeyPublic: unb64(init.spk),
    });
    const state = await ratchet.responderState(
      secret,
      { publicKey: this.device.keys.spk.publicKey, privateKey: this.device.keys.spk.privateKey },
      unb64(envelope.dh),
    );
    const session = {
      id: newId(),
      role: 'responder',
      deviceId: this.device.id,
      peerDeviceId: envelope.from,
      peerUserId: peer.userId || '',
      conversationId: options.conversationId || envelope.cid || null,
      peerSid: envelope.sid,
      secret: b64(secret),
      ephemeralPublicKey: null,
      oneTimePreKeyId: '',
      state,
      pushedCounter: 0,
    };
    await this.saveSession(session);
    await this.registerOnServer(session);
    return session;
  }

  /**
   * Decrypt an envelope addressed to this device.
   *
   * @param {object} envelope
   * @param {object} options { conversationId }
   * @returns {Promise<{plaintext: Uint8Array, session: object}>}
   */
  async decryptEnvelope(envelope, options = {}) {
    let session = await this.sessionForPeer(envelope.from);
    if (!session) {
      if (!envelope.init) {
        throw protocolError(
          'E2EE_VALIDATION_ERROR',
          'there is no session for this message, and it carries no key agreement',
          400,
        );
      }
      session = await this.accept(envelope, options);
    }
    if (session.peerSid && envelope.sid !== session.peerSid) {
      throw protocolError(
        'E2EE_VALIDATION_ERROR',
        'the message belongs to another session',
        400,
      );
    }
    if (!session.peerSid && envelope.sid) {
      session.peerSid = envelope.sid;
    }
    const out = await ratchet.decrypt(session.state, envelope, {
      sid: session.peerSid || envelope.sid,
      cid: options.conversationId,
      to: this.device.id,
    });
    session.state = out.state;
    await this.saveSession(session);
    return { plaintext: out.plaintext, session };
  }
}
