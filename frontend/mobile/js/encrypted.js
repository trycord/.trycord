// The encrypted conversation, as the phone sees it.
//
// The protocol is in packages/e2ee/ and is shared with the desk; this is the
// phone's surface over it. The rules are the same ones the desk keeps:
//
//   1. A conversation the server reports as encrypted is encrypted. The
//      composer never puts text into one, and a refusal is reported rather
//      than answered with the same message in the clear.
//   2. A conversation that is not fully encrypted says so, in words, before
//      anything is sent in the clear. The reader decides.
//   3. A row that is encrypted carries no text. What the reader sees is what
//      the client opened, and a message the client cannot open is shown as a
//      message it cannot read, with the reason.
//
// The device's private keys never leave this browser: they live in the device
// store, bound to the origin of the instance they belong to.

import { request, xhrUpload } from '../../packages/api.js';
import { TrycordConfig } from '../../packages/config.js';
import { State } from '../../packages/store.js';
import { E2eeClient, createE2eeApi, openStore } from '../../packages/e2ee/index.js';
import { confirm, toast } from './ui.js';

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
  return platform ? 'This ' + platform + ' phone' : 'This phone';
}

/**
 * The store's namespace: one set of keys per instance **and per account**.
 *
 * Per instance, because the private keys of one instance are not the private
 * keys of another. Per account, because a device is an identity: two people
 * sharing a phone must not present the first one's device to the second one's
 * account.
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
 * The store it opens is per-origin: the private keys of one instance are not
 * the private keys of another, and a reader who moves between instances must
 * not carry one instance's keys to the other.
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

/** Make sure the device is registered and has prekeys to offer. */
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

/** What the server says about a conversation's encryption. */
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
 * The composer hands over the message and the function that posts it. When the
 * conversation is not fully encrypted the reader is asked first, and a reader
 * who says no sends nothing.
 */
export async function send(conversationId, payload, post) {
  const open = await ready();
  if (!open) return post(payload);
  const prepared = await open.prepareMessage(conversationId, payload);
  if (prepared.warn) {
    const yes = await confirm({
      title: 'This conversation is not fully encrypted',
      body: prepared.warn,
      confirmLabel: 'Send in the clear',
      danger: true,
    });
    if (!yes) return null;
    return open.sendPrepared(prepared, post, {
      acknowledged: true,
      onWarning: (error) => toast(error && error.message ? error.message : String(error), { type: 'error' }),
    });
  }
  return open.sendPrepared(prepared, post, {
    onWarning: (error) => toast(error && error.message ? error.message : String(error), { type: 'error' }),
  });
}

/**
 * Read a message row.
 *
 * The row comes back with the text the client opened, or with the reason it
 * could not be opened. An encrypted row's own content is never used: the
 * server holds no text for one.
 */
export async function readRow(row, conversationId) {
  const open = await client();
  let read = null;
  try {
    read = await open.readMessage(row, conversationId);
  } catch (error) {
    // A row that cannot be parsed is a row that cannot be read. It is said
    // so, rather than allowed to throw out of a render.
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

/** Read a page of rows. */
export async function readRows(rows, conversationId) {
  const out = [];
  for (const row of rows || []) out.push(await readRow(row, conversationId));
  return out;
}

/** Turn on the encryption of a conversation. */
export async function turnOn(conversationId) {
  const open = await ready();
  if (!open) throw new Error('there is no device to encrypt with');
  const published = await open.publishConversationKey(conversationId);
  await conversationState(conversationId);
  toast('This conversation is now encrypted');
  return published;
}

/** Upload an encrypted file, or the ordinary file when the conversation is plain. */
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

/** A line about the state of a conversation, in words. */
export function describe(answer) {
  if (!answer) return { label: 'Not encrypted', tone: 'warn' };
  if (answer.state === 'encrypted') return { label: 'Encrypted', tone: 'ok' };
  if (answer.state === 'mixed') {
    return { label: 'Not fully encrypted', tone: 'warn' };
  }
  if (answer.state === 'key-changed') {
    return { label: 'The key has changed', tone: 'warn' };
  }
  return { label: 'Not encrypted', tone: 'warn' };
}

/** A short mark for the state, for a place with little room. */
export function badge(answer) {
  const text = describe(answer);
  return { text: text.label, tone: text.tone };
}
