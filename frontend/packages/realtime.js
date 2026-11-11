// The realtime gateway.
//
// The socket authenticates with a one-use ticket because the handshake cannot
// carry an Authorization header, and it is the only place a reader learns that a
// message arrived, someone came online or their session changed elsewhere. The
// wire vocabulary is fixed by the server; the names here match it exactly,
// because a second spelling of an event is an event that is never delivered.

import Api from './api.js';
import { TrycordConfig } from './config.js';
import { State, on as onState, setPresence as storePresence } from './store.js';

export const EVENTS = {
  MESSAGE: 'message',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_EMBEDS: 'message_embeds',
  MESSAGE_REACTION: 'message_reaction',
  MESSAGE_PINNED: 'message_pinned',
  MESSAGE_UNPINNED: 'message_unpinned',

  DM_MESSAGE: 'dm:message',
  DM_MESSAGE_UPDATED: 'dm:message_updated',
  DM_MESSAGE_DELETED: 'dm:message_deleted',
  DM_MESSAGE_EMBEDS: 'dm:message_embeds',
  DM_READ: 'dm:read',
  DM_TYPING: 'dm:typing',
  DM_CONVERSATION_UPDATED: 'dm:conversation_updated',
  DM_PINNED: 'dm:pinned',
  DM_UNPINNED: 'dm:unpinned',
  DM_INVITE: 'dm:invite',

  PRESENCE: 'presence',
  NOTIFICATION: 'notification',
};

export const SESSION_EVENTS = {
  PROFILE: 'profile',
  PRIVACY: 'privacy',
  WELLBEING: 'wellbeing',
  NOTIFICATION_PREFS: 'notification-prefs',
  BLOCKS: 'blocks',
  FRIEND: 'friend',
  TWOFACTOR: 'twofactor',
  SESSION_REVOKED: 'session-revoked',
};

// The encryption events the server sends to one account. They are not
// channel-scoped: a key belongs to a conversation, and a device belongs to
// the account, so they arrive without a server or channel join.
export const E2EE_EVENTS = {
  DEVICE: 'e2ee:device',
  KEY_CHANGE: 'e2ee:key-change',
  SAFETY_NUMBER: 'e2ee:safety-number',
};

// What arrived from an instance this account follows, or what happened to a
// message it wrote into one. The payload says which instance and community it
// belongs to, so a relayed message is never shown as if it were written here.
export const CONTINUUM_EVENTS = {
  RELAY_MESSAGE: 'continuum:relay-message',
  RELAY_REACTION: 'continuum:relay-reaction',
  RELAY_OUTGOING: 'continuum:relay-outgoing',
};

const listeners = new Map();

export function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);
  return () => listeners.get(type).delete(handler);
}

function emit(type, payload) {
  const set = listeners.get(type);
  if (!set) return;
  for (const handler of Array.from(set)) {
    try { handler(payload); } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[trycord] realtime listener for "' + type + '" failed', e);
      }
    }
  }
}

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let stopped = true;
// Every community this client has on screen lives in its own server room, so
// a change to any of them - a new channel, a role, a member - arrives as it
// happens. One room per socket made the rail go stale behind the page that
// was open.
let joinedServers = new Set();
let joinedChannel = null;
let joinedDm = null;
let typingTimer = 0;
let status = 'offline';

function setStatus(next) {
  if (status === next) return;
  status = next;
  emit('status', next);
}

export function statusOf() {
  return status;
}

export function isOpen() {
  return !!(socket && socket.readyState === WebSocket.OPEN);
}

function sendRaw(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(payload)); } catch { /* the close handler will resync */ }
  }
}

async function open() {
  clearTimeout(reconnectTimer);
  if (stopped) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (!State.hasToken) return;

  setStatus('connecting');
  let ticket;
  try {
    const out = await Api.wsTicket();
    ticket = out && out.ticket;
    if (!ticket) throw new Error('no ticket');
  } catch {
    scheduleReconnect();
    return;
  }
  if (stopped) return;

  try {
    socket = new WebSocket(TrycordConfig.wsUrl(ticket));
  } catch {
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    reconnectDelay = 1000;
    setStatus('online');
    for (const id of joinedServers) sendRaw({ type: 'join-server', serverId: id });
    if (joinedChannel) sendRaw({ type: 'join', channelId: joinedChannel });
    if (joinedDm) sendRaw({ type: 'dm:join', conversationId: joinedDm });
    emit('open', {});
  });

  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || !message.type) return;
    emit(message.type, message);
    if (message.type === EVENTS.PRESENCE && message.userId) {
      // Store first: every page that draws a dot listens to the store, and the
      // old path wrote the map directly so those pages never repainted. The
      // chrome event stays for the shell and for any listener that wants the
      // raw frame.
      storePresence(String(message.userId), message.presence || 'offline');
      emit('presence-changed', message);
    }
  });

  socket.addEventListener('close', () => {
    if (socket) socket = null;
    setStatus('offline');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => { /* a close always follows */ });
}

function scheduleReconnect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(open, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 15000);
}

export function connect() {
  stopped = false;
  open();
}

export function disconnect() {
  stopped = true;
  clearTimeout(reconnectTimer);
  joinedServers = new Set();
  joinedChannel = null;
  joinedDm = null;
  if (socket) {
    try { socket.close(1000, 'signed out'); } catch { /* already gone */ }
    socket = null;
  }
  setStatus('offline');
}

export function joinServer(serverId) {
  const id = serverId === undefined || serverId === null ? null : String(serverId);
  if (!id) return;
  // Joining a room twice is one frame the first time: every refresh of the
  // community list lands here, and the socket needs the room once.
  if (joinedServers.has(id)) return;
  joinedServers.add(id);
  sendRaw({ type: 'join-server', serverId: id });
}

export function leaveServer(serverId) {
  // No argument: leave every room (signing out of one community's screen is
  // the caller's business; leaving the app is sign-out's).
  if (serverId === undefined || serverId === null) {
    for (const id of joinedServers) sendRaw({ type: 'leave-server', serverId: id });
    joinedServers = new Set();
    return;
  }
  const id = String(serverId);
  if (!joinedServers.delete(id)) return;
  sendRaw({ type: 'leave-server', serverId: id });
}

export function joinChannel(channelId) {
  joinedChannel = channelId || null;
  if (joinedChannel) sendRaw({ type: 'join', channelId: joinedChannel });
}

export function leaveChannel() {
  joinedChannel = null;
}

export function joinDm(conversationId) {
  if (joinedDm && joinedDm !== conversationId) {
    sendRaw({ type: 'dm:leave', conversationId: joinedDm });
  }
  joinedDm = conversationId || null;
  if (joinedDm) sendRaw({ type: 'dm:join', conversationId: joinedDm });
}

export function leaveDm() {
  if (joinedDm) sendRaw({ type: 'dm:leave', conversationId: joinedDm });
  joinedDm = null;
}

// The server throttles nothing for typing, so the client does: one frame every
// few seconds while the writer keeps going.
export function typing(conversationId) {
  const now = Date.now();
  if (now - typingTimer < 3000) return;
  typingTimer = now;
  sendRaw({ type: 'dm:typing', conversationId });
}

export function inspect() {
  return { status, socket: !!socket, servers: [...joinedServers], channel: joinedChannel, dm: joinedDm };
}

const TrycordRealtime = {
  EVENTS, SESSION_EVENTS, E2EE_EVENTS, CONTINUUM_EVENTS, on, connect, disconnect,
  joinServer, leaveServer, joinChannel, leaveChannel, joinDm, leaveDm,
  typing, statusOf, isOpen, inspect, emit,
};

export default TrycordRealtime;

// A signed-out client has no socket to hold open.
onState('signed-out', () => disconnect());
