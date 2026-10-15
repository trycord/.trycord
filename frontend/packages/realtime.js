// The realtime gateway.
//
// The socket authenticates with a one-use ticket because the handshake cannot
// carry an Authorization header, and it is the only place a reader learns that a
// message arrived, someone came online or their session changed elsewhere. The
// wire vocabulary is fixed by the server; the names here match it exactly,
// because a second spelling of an event is an event that is never delivered.

import Api from './api.js';
import { TrycordConfig } from './config.js';
import { State, on as onState } from './store.js';

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
let joinedServer = null;
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
    if (joinedServer) sendRaw({ type: 'join-server', serverId: joinedServer });
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
      State.presence.set(String(message.userId), message.presence || 'offline');
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
  joinedServer = null;
  joinedChannel = null;
  joinedDm = null;
  if (socket) {
    try { socket.close(1000, 'signed out'); } catch { /* already gone */ }
    socket = null;
  }
  setStatus('offline');
}

export function joinServer(serverId) {
  joinedServer = serverId || null;
  if (joinedServer) sendRaw({ type: 'join-server', serverId: joinedServer });
}

export function leaveServer() {
  joinedServer = null;
  sendRaw({ type: 'leave-server' });
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
  return { status, socket: !!socket, server: joinedServer, channel: joinedChannel, dm: joinedDm };
}

const TrycordRealtime = {
  EVENTS, SESSION_EVENTS, on, connect, disconnect,
  joinServer, leaveServer, joinChannel, leaveChannel, joinDm, leaveDm,
  typing, statusOf, isOpen, inspect, emit,
};

export default TrycordRealtime;

// A signed-out client has no socket to hold open.
onState('signed-out', () => disconnect());
