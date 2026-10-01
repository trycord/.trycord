// (POST /api/auth/ws/ticket then ?ticket= handshake — token auth is refused

import Api from './api.js';
import { TrycordConfig } from './config.js';
import State, {
  setOnline, setPresence, refreshNotifications, isAuthed,
  refreshFriends, refreshBlocks, clearSession,
} from './state.js';
import { renderAllChrome } from './shell.js';
import { applyWellbeingToDocument } from './privacy-ui.js';
import { navigate } from './nav.js';

const listeners = {};

function emit(type, payload) {
  for (const fn of listeners[type] || []) {
    try { fn(payload); } catch { /* listener error must not kill the socket */ }
  }
}

let ws = null;
let currentTicket = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let order = 0;
let joinedChannel = null;
let joinedServer = null;
let joinedDm = null;
let typingTimer = null;
let closedIntentionally = false;

function wsUrl(ticket) {
  return TrycordConfig.wsUrl(ticket);
}

async function connect() {
  closedIntentionally = false;
  clearTimeout(reconnectTimer);
  // Never stack sockets: an already-open/connecting gateway is reused, a
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (ws) { try { ws.close(1000, 'reconnect'); } catch { /* ignore */ } ws = null; }
  if (!isAuthed()) return;
  try {
    const { ticket } = await Api.wsTicket();
    if (!ticket) throw new Error('no ticket');
    currentTicket = ticket;
  } catch {
    scheduleReconnect();
    return;
  }
  if (closedIntentionally || !isAuthed()) return;

  ws = new WebSocket(wsUrl(currentTicket));

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    setOnline(true);
    if (joinedServer) send({ type: 'join-server', serverId: joinedServer });
    if (joinedChannel) send({ type: 'join', channelId: joinedChannel });
    if (joinedDm) send({ type: 'dm:join', conversationId: joinedDm });
    emit('open', {});
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.type) return;
    emit(msg.type, msg);
    if (msg.type === 'presence') setPresence(msg.userId, msg.presence);
    if (msg.type === 'notification') refreshNotifications().catch(() => {});

    // Account-scoped events. Each one means "your own state changed somewhere
    // else", and the correct response is to read the new state rather than to
    // patch the old one: the payload is a summary, and a client that trusts a
    // summary instead of the source is how two devices end up disagreeing about
    // what the server said.
    if (msg.type === 'profile' && msg.profile) {
      State.me = Object.assign({}, State.me, msg.profile);
      renderAllChrome();
    }
    if (msg.type === 'privacy') {
      // Repainted on the Privacy page itself if it is open; the state store is
      // not kept because each section reads from the API rather than from here.
      renderAllChrome();
    }
    if (msg.type === 'wellbeing') applyWellbeingToDocument(msg.wellbeing);
    if (msg.type === 'blocks') refreshBlocks().catch(() => {});
    if (msg.type === 'friend') refreshFriends().catch(() => {});
    if (msg.type === 'twofactor') renderAllChrome();
    if (msg.type === 'session-revoked') {
      // The server has already invalidated these tokens. Anything still open
      // here is a session that is dead and does not know it, so the only correct
      // move is to stop using it and send the reader to sign in again.
      Realtime.disconnect();
      clearSession();
      navigate('/login', { replace: true });
    }
  });

  ws.addEventListener('close', () => {
    setOnline(false);
    emit('close', {});
    scheduleReconnect();
  });

  ws.addEventListener('error', () => { /* close follows */ });
}

function scheduleReconnect() {
  if (closedIntentionally) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

const TrycordRealtime = {
  connect,
  disconnect() {
    closedIntentionally = true;
    clearTimeout(reconnectTimer);
    joinedChannel = null;
    joinedDm = null;
    order = 0;
    if (ws) { try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
    ws = null;
  },
  on(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
    return () => {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    };
  },
  join(channelId) { joinedChannel = channelId; send({ type: 'join', channelId }); },
  leaveChannel() { joinedChannel = null; },
  // be sent but never remembered, so after any reconnect the socket was in
  joinServer(serverId) { joinedServer = serverId; send({ type: 'join-server', serverId }); },
  leaveServer() { joinedServer = null; send({ type: 'leave-server' }); },
  sendMessageToChannel(content, attachments) {
    const body = {};
    if (content) body.content = content;
    if (attachments && attachments.length) body.attachments = attachments.map(String);
    send({ type: 'msg', ...body });
  },
  joinDm(conversationId) { joinedDm = conversationId; send({ type: 'dm:join', conversationId }); },
  leaveDm() {
    if (joinedDm) send({ type: 'dm:leave', conversationId: joinedDm });
    joinedDm = null;
  },
  typing(conversationId) {
    const now = Date.now();
    if (typingTimer && now - typingTimer < 3500) return;
    typingTimer = now;
    send({ type: 'dm:typing', conversationId });
  },
  inspect() { return { open: !!(ws && ws.readyState === WebSocket.OPEN), ticket: !!currentTicket }; },
};

export default TrycordRealtime;
