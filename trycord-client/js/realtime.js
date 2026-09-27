// WebSocket gateway client. Connects via the single-use ticket flow
// (POST /api/auth/ws/ticket then ?ticket= handshake — token auth is refused
// by the server). Emits typed events through TrycordRealtime.on(type, fn).

import Api from './api.js';
import { TrycordConfig } from './config.js';
import { setOnline, setPresence, refreshNotifications, isAuthed } from './state.js';

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
  // Single derivation from BACKEND_URL: https -> wss, http -> ws.
  return TrycordConfig.wsUrl(ticket);
}

async function connect() {
  // Explicit (re)connect: a previous intentional shutdown no longer applies.
  closedIntentionally = false;
  clearTimeout(reconnectTimer);
  // Never stack sockets: an already-open/connecting gateway is reused, a
  // stale one is torn down before dialing fresh.
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
    // Restore subscriptions BEFORE announcing the reopen. Listeners on
    // 'open' kick off a resync fetch; if the joins are still in flight
    // when that fetch is issued, a message committed in the gap is missed
    // live *and* is not in the snapshot the fetch returns, so it is lost
    // until the next reload.
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
  // Track the community room locally as well as on the wire. It used to
  // be sent but never remembered, so after any reconnect the socket was in
  // no community room and every structural event (member joined/left,
  // channel created, role changed, server updated, kick/ban) became
  // undeliverable - with no way to self-heal, because the only thing that
  // re-ran the community load was one of those very events.
  joinServer(serverId) { joinedServer = serverId; send({ type: 'join-server', serverId }); },
  leaveServer() { joinedServer = null; send({ type: 'leave-server' }); },
  sendMessageToChannel(content, attachments) {
    const body = {};
    if (content) body.content = content;
    if (attachments && attachments.length) body.attachments = attachments.map(String);
    send({ type: 'msg', ...body });
  },
  joinDm(conversationId) { joinedDm = conversationId; send({ type: 'dm:join', conversationId }); },
  // Tell the server to prune this DM room too (F3): without dm:leave the
  // socket accumulated every DM ever opened and kept receiving them.
  leaveDm() {
    if (joinedDm) send({ type: 'dm:leave', conversationId: joinedDm });
    joinedDm = null;
  },
  typing(conversationId) {
    // throttled ephemeral echo
    const now = Date.now();
    if (typingTimer && now - typingTimer < 3500) return;
    typingTimer = now;
    send({ type: 'dm:typing', conversationId });
  },
  inspect() { return { open: !!(ws && ws.readyState === WebSocket.OPEN), ticket: !!currentTicket }; },
};

export default TrycordRealtime;