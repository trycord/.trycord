// The E2EE client: this device, its sessions, and the conversations it is in.
//
// The client is the half of the protocol the server is not: it holds the
// private keys, it agrees the secrets, it encrypts and decrypts, and it
// decides what a message becomes. The server holds the public keys, the
// sealed blobs and the counters, and nothing it could open.
//
// Everything here is asynchronous and everything here fails loudly. A
// failure must never turn into a message sent in the clear.

import { utf8 } from './bytes.js';
import { openStore } from './store.js';
import { createE2eeApi } from './api.js';
import { createDevice, loadDevice, saveDevice, ensureSealedPrivateKey, PREKEY_BATCH, PREKEY_LOW_WATER } from './device.js';
import { SessionManager } from './sessions.js';
import { publishKey, keyForDevice } from './group.js';
import { upload as uploadAttachment, keyForDevice as attachmentKeyForDevice, decryptFile } from './attachments.js';
import { sealBackup, backupMaterial, openBackup, recover as recoverDevice } from './recovery.js';
import { readMessage } from './message.js';
import { decide } from './send.js';
import { protocolError } from './envelope.js';

/**
 * The client's own state.
 */
export class E2eeClient {
  /**
   * @param {object} deps { store, api }
   */
  constructor(deps) {
    this.store = deps.store;
    this.api = deps.api;
    this.device = null;
    this.manager = null;
  }

  /**
   * Open a client.
   *
   * @param {object} options { request, upload, namespace, backend }
   */
  static async open(options = {}) {
    const store = options.store || await openStore({
      namespace: options.namespace,
      backend: options.backend,
    });
    const api = options.api || createE2eeApi({ request: options.request, upload: options.upload });
    return new E2eeClient({ store, api });
  }

  /** Where the keys are kept. */
  backend() {
    return this.store.backend;
  }

  /**
   * The device this browser has, or null.
   */
  async load() {
    this.device = await loadDevice(this.store);
    if (this.device) this.manager = new SessionManager({ device: this.device, store: this.store, api: this.api });
    return this.device;
  }

  /**
   * Make sure the device exists, is registered with the server, and has
   * one-time prekeys to offer.
   *
   * @param {object} options { userId, label }
   */
  async ready(options = {}) {
    if (!this.device) await this.load();
    if (!this.device) {
      this.device = await createDevice({ userId: options.userId, label: options.label });
      await saveDevice(this.store, this.device);
      this.manager = new SessionManager({ device: this.device, store: this.store, api: this.api });
    }
    if (!this.device.registered) {
      await this.register();
    }
    await this.publishPrekeysIfNeeded();
    return this.device;
  }

  /** Register the device with the server. */
  async register() {
    const sealed = await ensureSealedPrivateKey(this.device);
    await this.api.registerDevice(await this.device.registrationBody({ sealedPrivateKey: sealed }));
    this.device.registered = true;
    await saveDevice(this.store, this.device);
    return this.device;
  }

  /**
   * Publish a batch of one-time prekeys.
   *
   * The device publishes a fresh batch when the one it has is running out:
   * every session that is opened with it takes one, and a device with no
   * prekeys left can only be reached with the three agreements of X3DH
   * rather than the four.
   */
  async publishPrekeys(count = PREKEY_BATCH) {
    const prekeys = await this.device.oneTimePreKeyBatch(count);
    const answer = await this.api.publishPrekeys(this.device.publishBody(prekeys));
    await saveDevice(this.store, this.device);
    return answer;
  }

  /** Publish a batch when the prekeys are running low. */
  async publishPrekeysIfNeeded() {
    if (this.device.preKeyCount() >= PREKEY_LOW_WATER) return null;
    return this.publishPrekeys();
  }

  /** The peer's public keys, from the cache or from the server. */
  peerKeys(deviceId) {
    return this.manager.peerKeys(deviceId);
  }

  /**
   * Take a device as this browser's own.
   *
   * A recovered device is a new device: new keys, new fingerprint. The old
   * one keeps its identity and can be revoked, and until it is revoked it is
   * still a device somebody can read this account's conversations with.
   */
  async adoptDevice(device) {
    this.device = device;
    this.manager = new SessionManager({ device, store: this.store, api: this.api });
    await saveDevice(this.store, device);
    return device;
  }

  /**
   * What the server says about a conversation's encryption.
   *
   * The route answers with the state itself: the conversation, its state, the
   * epoch, and the devices that are in it and which of them hold the key.
   */
  async conversationState(conversationId) {
    const answer = await this.api.conversationState(conversationId);
    if (!answer) return null;
    if (Array.isArray(answer.memberDevices)) return answer;
    if (answer.state && typeof answer.state === 'object') return answer.state;
    return answer;
  }

  /**
   * The devices that are in a conversation.
   */
  async memberDevices(conversationId) {
    const state = await this.conversationState(conversationId);
    return (state && state.memberDevices) || [];
  }

  /**
   * Publish the conversation's key, sealed to the devices that are in it now.
   *
   * The key is new every time: a member who left still holds the key they
   * were given, and only a new epoch takes it away from them.
   */
  async publishConversationKey(conversationId) {
    const state = await this.conversationState(conversationId);
    const members = (state && state.memberDevices) || [];
    const epoch = Number(state && state.epoch ? state.epoch : 0) + 1;
    const published = await publishKey(
      { api: this.api, device: this.device, peerKeys: (id) => this.peerKeys(id) },
      { conversationId, epoch, memberDevices: members },
    );
    return published;
  }

  /**
   * The conversation key this device holds, if it holds one.
   */
  async conversationKey(conversationId) {
    return keyForDevice({ api: this.api, device: this.device }, { conversationId });
  }

  /**
   * Encrypt a message to every member device of a conversation.
   *
   * One envelope per device, each with its own session and its own key. A
   * device the client cannot open a session with is a device that would not
   * be able to read the message, so it is an error rather than a smaller
   * message: the reader is told, and nothing is sent.
   *
   * @param {object} options { conversationId, text, memberDevices }
   * @returns {Promise<object[]>} the envelopes
   */
  async encryptMessage(options) {
    const members = options.memberDevices || await this.memberDevices(options.conversationId);
    const plaintext = utf8(options.text === undefined || options.text === null ? '' : String(options.text));
    const envelopes = [];
    for (const member of members) {
      if (member.deviceId === this.device.id) continue;
      let session = await this.manager.sessionForPeer(member.deviceId);
      if (!session) {
        session = await this.manager.establish(member.deviceId, { conversationId: options.conversationId });
      }
      const out = await this.manager.encryptTo(session, {
        conversationId: options.conversationId,
        plaintext,
      });
      envelopes.push(out.envelope);
    }
    if (!envelopes.length) {
      throw protocolError(
        'E2EE_VALIDATION_ERROR',
        'there is nobody to encrypt this message to',
        400,
      );
    }
    return envelopes;
  }

  /**
   * Read a message row.
   */
  async readMessage(row, conversationId) {
    return readMessage(row, {
      deviceId: this.device ? this.device.id : null,
      manager: this.manager,
      conversationId,
    });
  }

  /**
   * What a message in this conversation becomes.
   *
   * The server's answer decides, and nothing else does. An encrypted
   * conversation takes envelopes; a conversation that is not encrypted takes
   * text; a conversation that is mixed or has changed key takes text, and
   * says so, because one of the devices in it cannot read what is sent.
   *
   * The preparation is separate from the sending so that the reader can be
   * asked before anything goes out, and so that the message is encrypted
   * once: preparing it twice would advance the ratchet twice for one
   * message.
   *
   * @param {object} payload { content, replyToId, attachmentIds }
   */
  async prepareMessage(conversationId, payload) {
    const state = await this.conversationState(conversationId);
    const decision = decide(state);
    const body = {
      replyToId: payload.replyToId,
      attachmentIds: payload.attachmentIds,
    };
    if (decision.mode === 'encrypted') {
      const envelopes = await this.encryptMessage({
        conversationId,
        text: payload.content,
        memberDevices: (state && state.memberDevices) || [],
      });
      return {
        mode: 'encrypted',
        warn: null,
        state: decision.state,
        body: Object.assign({}, body, { envelopes }),
      };
    }
    return {
      mode: 'text',
      warn: decision.warn,
      state: decision.state,
      body: Object.assign({}, body, { content: payload.content }),
    };
  }

  /**
   * Post a prepared message.
   *
   * A preparation that carries a warning is refused until the reader has
   * acknowledged it: the client does not send in the clear over a
   * conversation it has just told the reader is not fully encrypted.
   *
   * There is no retry. A server that refuses the body is reported, and the
   * message stays unsent - a client that quietly sent the same message in
   * the clear would be the failure this whole subsystem exists to prevent.
   *
   * @param {object} prepared the result of prepareMessage
   * @param {function} send posts the body and answers with the message
   * @param {object} options { acknowledged, onWarning }
   */
  async sendPrepared(prepared, send, options = {}) {
    if (prepared.warn && !options.acknowledged) {
      const error = new Error(prepared.warn);
      error.name = 'E2eeWarningError';
      error.code = 'E2EE_NOT_ACKNOWLEDGED';
      error.warn = prepared.warn;
      throw error;
    }
    const sent = await send(prepared.body);
    const pushed = await this.pushStates();
    for (const failure of pushed.failed) {
      if (options.onWarning) options.onWarning(failure);
      else if (typeof console !== 'undefined' && console.warn) {
        console.warn('[trycord] the message was sent, but the session state was not stored', failure);
      }
    }
    return sent;
  }

  /**
   * Push the state of the sessions that have moved on.
   *
   * Every session is attempted, and the failures are reported rather than
   * swallowed: the message has been sent, and a state that was not stored is
   * worth saying out loud.
   */
  async pushStates() {
    const sessions = this.manager ? await this.manager.listSessions() : [];
    const failed = [];
    let pushed = 0;
    for (const session of sessions) {
      try {
        const before = session.pushedCounter;
        await this.manager.pushState(session);
        if (session.pushedCounter !== before) pushed += 1;
      } catch (error) {
        failed.push(error);
      }
    }
    return { pushed, failed };
  }

  /**
   * Encrypt a file and upload the ciphertext.
   *
   * @param {object} options { conversationId, bytes, filename, mime, memberDevices }
   */
  async uploadFile(options) {
    const members = options.memberDevices || await this.memberDevices(options.conversationId);
    const uploaded = await uploadAttachment(
      { api: this.api, device: this.device, peerKeys: (id) => this.peerKeys(id) },
      {
        conversationId: options.conversationId,
        filename: options.filename,
        mime: options.mime,
        bytes: options.bytes,
        memberDevices: members,
      },
    );
    return { id: uploaded.id };
  }

  /**
   * The bytes of an attachment, opened with the key sealed to this device.
   *
   * The ciphertext is fetched from where the server stored it and opened
   * here: the key was sealed to the member devices, and this device's own
   * seal is the only one it can open.
   */
  async openAttachment(conversationId, attachmentId, bytes) {
    const opened = await attachmentKeyForDevice(
      { api: this.api, device: this.device },
      { conversationId, attachmentId },
    );
    if (!opened) {
      throw protocolError('E2EE_FORBIDDEN', 'this attachment was not sealed to this device', 403);
    }
    const ciphertext = bytes || await this.api.attachmentBytes(attachmentId);
    return decryptFile(opened.key, ciphertext);
  }

  /**
   * The key backup, sealed under the recovery key.
   */
  async backup() {
    const sessions = this.manager ? await this.manager.listSessions() : [];
    const material = backupMaterial(this.device, sessions);
    const sealed = await sealBackup(material, this.device.recoveryKey);
    await this.api.saveBackup(sealed);
    return sealed;
  }

  /**
   * The key backup the server holds, opened with the recovery key.
   */
  async openBackup(recoveryKey) {
    const answer = await this.api.fetchBackup();
    if (!answer || !answer.backup) return null;
    return openBackup(answer.backup, recoveryKey);
  }

  /**
   * Recover a device from the one that was lost.
   *
   * The new device gets new keys: a recovered device that kept the old
   * identity would be the old device wearing a new label, and revoking the
   * old one would mean nothing.
   *
   * @param {object} options { userId, sourceDeviceId, sourceKeys, newDevice }
   */
  async recover(options) {
    const sealed = await ensureSealedPrivateKey(options.newDevice);
    return recoverDevice(
      { api: this.api },
      {
        userId: options.userId,
        sourceDeviceId: options.sourceDeviceId,
        sourceKeys: options.sourceKeys,
        newDevice: options.newDevice,
        sealedPrivateKey: sealed,
      },
    );
  }

  /**
   * What the composer should do with a message in this conversation.
   */
  async decideFor(conversationId) {
    const state = await this.conversationState(conversationId);
    return decide(state);
  }
}

