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
    // One broken listener must not take the socket down with it, but it must
    // not be invisible either: a swallowed error here hid a missing import in a
    // preview handler for a whole revision, and the only symptom was a card
    // that never appeared.
    try { fn(payload); } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[trycord] listener for ' + type + ' failed', e);
    }
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

  /**
 * This session's identifier, read from the token's own claims.
 *
 * Not verification - nothing here trusts the value. It is used only to
 * recognise "this event is about me" against a server that names the acting
 * session, so a reader is not signed out by their own "sign out other sessions".
 * A token that cannot be decoded yields null, and a null simply means the
 * comparison is skipped and the event is treated as a real revocation, which is
 * the safe direction to fail in.
 */
function ownJti() {
  try {
    const token = State.token || localStorage.getItem('trycord.token');
    if (!token) return null;
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = decodeURIComponent(
      atob(part.replace(/-/g, '+').replace(/_/g, '/'))
        .split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    const claims = JSON.parse(json);
    return claims && claims.jti ? String(claims.jti) : null;
  } catch {
    return null;
  }
}

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
      document.dispatchEvent(new CustomEvent('trycord:state', { detail: 'privacy' }));
    }
    if (msg.type === 'wellbeing') {
      applyWellbeingToDocument(msg.wellbeing);
      document.dispatchEvent(new CustomEvent('trycord:state', { detail: 'wellbeing' }));
    }
    if (msg.type === 'notification-prefs') {
      document.dispatchEvent(new CustomEvent('trycord:state', { detail: 'notifications' }));
    }
    if (msg.type === 'blocks') {
      refreshBlocks().catch(() => {});
      document.dispatchEvent(new CustomEvent('trycord:state', { detail: 'blocks' }));
    }
    if (msg.type === 'friend') {
      refreshFriends().catch(() => {});
      document.dispatchEvent(new CustomEvent('trycord:state', { detail: 'friends' }));
    }
    if (msg.type === 'twofactor') renderAllChrome();
    if (msg.type === 'session-revoked') {
      // Our own action is not a revocation of us. "Sign out other sessions"
      // returns a fresh token for this device and leaves it signed in, and the
      // event reaches this socket too - treating it as an attack would sign the
      // reader out for doing what they asked. The token's own jti claim is
      // readable without verification, which is all that is needed here.
      const mine = ownJti();
      if (msg.actorJti && mine && msg.actorJti === mine) {
        // Nothing to do: this session survived. Reconnecting is already handled
        // by the close that disconnectUser caused.
        return;
      }
      // The server has already invalidated these tokens. Anything still open
      // here is a session that is dead and does not know it, so the only correct
      // move is to stop using it and send the reader to sign in again.
      // Stop using the socket before tearing down the session. The local name here is
      // TrycordRealtime, not Realtime: writing the exported name resolves to
      // nothing, throws inside this handler, and leaves the reader on a page
      // whose session the server has already revoked - which is the worst of both
      // worlds, because nothing is visibly wrong.
      TrycordRealtime.disconnect();
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
