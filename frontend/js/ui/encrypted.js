// The encrypted conversation, as the interface sees it.
//
// The protocol is in packages/e2ee/. This is the surface the screens use:
// the composer asks it what a message becomes, the timeline asks it what a
// row says, and the settings page asks it what this device holds.
//
// The rules it keeps:
//
//   1. A conversation the server reports as encrypted is encrypted. The
//      composer never puts text into one, and a refusal is reported rather
//      than answered with the same message in the clear.
//   2. A conversation that is not fully encrypted says so, in words, before
//      anything is sent in the clear. The reader decides.
//   3. A row that is encrypted carries no text. What the reader sees is what
//      the client opened, and a message the client cannot open is shown as
//      a message it cannot read, with the reason.
//
// The device is registered with the server the first time it is used, and its
// private keys never leave this browser: they live in the device store, which
// is bound to this origin.

import { request, xhrUpload } from '../../packages/api.js';
import { TrycordConfig } from '../../packages/config.js';
import { State } from '../../packages/store.js';
import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { confirmDialog, errorToast, toast } from './overlays.js';
import { E2eeClient, createE2eeApi, openStore } from '../../packages/e2ee/index.js';

/** What this module knows. */
const state = {
  client: null,
  opening: null,
  ready: null,
  conversations: new Map(),
  listeners: new Set(),
};

/** The name this device is known by on the server. */
export function deviceLabel() {
  const platform = (globalThis.navigator && globalThis.navigator.userAgentData
    && globalThis.navigator.userAgentData.platform) || '';
  return platform ? 'This ' + platform + ' browser' : 'This browser';
}

/**
 * The store's namespace: one set of keys per instance **and per account**.
 *
 * Per instance, because the private keys of one instance are not the private
 * keys of another and a reader who moves between instances must not carry one
 * instance's keys to the other.
 *
 * Per account, because a device is an identity. Two people sharing a browser
 * must not present the first one's device to the second one's account: the
 * safety number they compare would then be a number the second person never
 * saw, and the device would be a key the first person still holds.
 */
function namespace() {
  let origin = TrycordConfig.backendUrl();
  try { origin = new URL(origin).origin; } catch { /* keep the raw address */ }
  const account = State.user && State.user.id ? '-' + String(State.user.id).slice(0, 12) : '';
  return String(origin).replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + account;
}

/** Tell whoever is listening that something changed. */
function announce(change) {
  for (const listener of Array.from(state.listeners)) {
    try {
      listener(change);
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[trycord] an encryption listener failed', error);
      }
    }
  }
}

/** Watch for changes in the encryption of a conversation. */
export function onChange(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/**
 * The client, opened once.
 *
 * The store it opens is per-origin: the private keys of one instance are
 * not the private keys of another, and a reader who moves between instances
 * must not carry one instance's keys to the other.
 */
export async function client() {
  if (state.client) return state.client;
  if (!state.opening) {
    state.opening = (async () => {
      const store = await openStore({ namespace: namespace() });
      const api = createE2eeApi({
        request,
        upload: (path, formData) => xhrUpload(path, formData).promise,
      });
      state.client = await E2eeClient.open({ store, api });
      await state.client.load();
      return state.client;
    })().catch((error) => {
      state.opening = null;
      throw error;
    });
  }
  return state.opening;
}

/**
 * Make sure the device is registered and has prekeys to offer.
 *
 * A reader who is not signed in has no device: there is nothing to register
 * and nobody to register it for.
 */
export async function ready() {
  if (!State.user) return null;
  if (!state.ready) {
    state.ready = (async () => {
      const open = await client();
      await open.ready({ userId: State.user.id, label: deviceLabel() });
      announce({ type: 'device', deviceId: open.device.id });
      return open;
    })().catch((error) => {
      state.ready = null;
      throw error;
    });
  }
  return state.ready;
}

/** Forget everything this module holds. Used when the reader signs out. */
export function reset() {
  state.client = null;
  state.opening = null;
  state.ready = null;
  state.conversations.clear();
}

/**
 * What the server says about a conversation's encryption.
 *
 * The answer is cached for the conversation, because a composer that asks
 * the server on every keystroke is a composer that talks to the server on
 * every keystroke.
 */
export async function conversationState(conversationId) {
  const open = await client();
  const answer = await open.conversationState(conversationId);
  state.conversations.set(conversationId, answer);
  announce({ type: 'state', conversationId, state: answer });
  return answer;
}

/** The last answer this module heard about a conversation. */
export function knownState(conversationId) {
  return state.conversations.get(conversationId) || null;
}

/**
 * Send a message into a conversation.
 *
 * The composer hands over the message and the function that posts it. When
 * the conversation is not fully encrypted the reader is asked first, and a
 * reader who says no sends nothing.
 *
 * @param {string} conversationId
 * @param {object} payload { content, replyToId, attachmentIds }
 * @param {function} post posts the body and answers with the message
 */
export async function send(conversationId, payload, post) {
  const open = await ready();
  if (!open) return post(payload);
  const prepared = await open.prepareMessage(conversationId, payload);
  if (prepared.warn) {
    const yes = await confirmDialog({
      title: 'This conversation is not fully encrypted',
      body: prepared.warn,
      confirmLabel: 'Send in the clear',
      danger: true,
    });
    if (!yes) return null;
    return open.sendPrepared(prepared, post, {
      acknowledged: true,
      onWarning: (error) => errorToast(error),
    });
  }
  return open.sendPrepared(prepared, post, { onWarning: (error) => errorToast(error) });
}

/**
 * Read a message row.
 *
 * The row comes back with the text the client opened, or with the reason it
 * could not be opened. An encrypted row's own content is never used: the
 * server holds no text for one.
 *
 * A row that is not encrypted needs no device, so nothing is registered for
 * it. A row that is encrypted needs one, and the device is registered if it
 * is not already - a reader who opens an encrypted conversation has to have a
 * device for the conversation to have been encrypted in the first place.
 */
export async function readRow(row, conversationId) {
  if (!row || !row.encrypted) {
    return Object.assign({}, row, {
      content: row && row.content ? String(row.content) : '',
      encrypted: false,
      unreadable: false,
    });
  }
  let open = null;
  try {
    open = await ready();
  } catch (error) {
    return Object.assign({}, row, {
      content: 'This message cannot be read on this device: '
        + (error && error.message ? error.message : 'the device could not be opened'),
      encrypted: true,
      unreadable: true,
    });
  }
  if (!open) {
    return Object.assign({}, row, {
      content: 'This message cannot be read on this device: there is no device on this browser.',
      encrypted: true,
      unreadable: true,
    });
  }
  let read = null;
  try {
    read = await open.readMessage(row, conversationId);
  } catch (error) {
    // A row that cannot be parsed is a row that cannot be read. It is said
    // so, rather than allowed to throw out of a render and take the
    // conversation with it.
    read = {
      content: null,
      encrypted: true,
      unreadable: true,
      reason: 'This message could not be opened on this device'
        + (error && error.message ? ' (' + error.message + ')' : ''),
    };
  }
  return Object.assign({}, row, {
    content: read.unreadable ? read.reason : (read.content || ''),
    encrypted: read.encrypted,
    unreadable: read.unreadable,
  });
}

/**
 * Read a page of rows.
 */
export async function readRows(rows, conversationId) {
  const out = [];
  for (const row of rows || []) out.push(await readRow(row, conversationId));
  return out;
}

/**
 * Turn on the encryption of a conversation.
 *
 * The key is new and sealed to the devices that are in the conversation now,
 * so a member who left stops being able to read what comes next.
 */
export async function turnOn(conversationId) {
  const open = await ready();
  if (!open) throw new Error('there is no device to encrypt with');
  const published = await open.publishConversationKey(conversationId);
  await conversationState(conversationId);
  toast('This conversation is now encrypted');
  return published;
}

/**
 * Upload a file into a conversation.
 *
 * An encrypted conversation takes encrypted files: the server refuses a
 * message that carries a file it cannot read, so a file uploaded in the clear
 * would leave the message unsent. The file is encrypted here, its key is
 * sealed to each member device, and the server is handed the ciphertext and
 * the seals - which it cannot open.
 *
 * A conversation that is not encrypted is uploaded the ordinary way.
 */
export async function upload(conversationId, file, post) {
  const open = await ready();
  if (!open) return post(file);
  const answer = await open.conversationState(conversationId);
  if (!answer || answer.state !== 'encrypted') return post(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const out = await open.uploadFile({
    conversationId,
    filename: file.name || 'attachment',
    mime: file.type || 'application/octet-stream',
    bytes,
  });
  return { id: out.id };
}

/**
 * A short line saying how a conversation is encrypted.
 *
 * The wording is the reader's: a conversation that is only partly encrypted
 * says so, and says which of the two it is.
 */
export function describe(answer) {
  if (!answer || !answer.state) return '';
  if (answer.state === 'encrypted') return 'End-to-end encrypted';
  if (answer.state === 'not-encrypted') return 'Not encrypted';
  if (answer.state === 'mixed') {
    return 'Not fully encrypted: some devices in this conversation cannot read it';
  }
  if (answer.state === 'key-changed') {
    return 'The encryption key has changed and some devices are behind';
  }
  return answer.state;
}

/**
 * The badge that says how a conversation is encrypted.
 */
export function badge(answer) {
  const text = describe(answer);
  if (!text) return null;
  const encrypted = answer.state === 'encrypted';
  return el('span', {
    class: 'badge ' + (encrypted ? 'badge--success' : 'badge--warning'),
    title: text,
  }, icon(encrypted ? 'lock' : 'unlock', { size: 13 }), el('span', {}, text));
}

/**
 * The line that says a message cannot be read.
 */
export function unreadableNode(reason) {
  return el('p', { class: 'msg-text msg-text--unreadable' },
    icon('lock', { size: 13 }),
    el('span', { class: 'msg-edited' }, reason || 'This message cannot be read on this device.'));
}

export { errorToast };
