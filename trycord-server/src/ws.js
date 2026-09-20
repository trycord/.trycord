// Realtime gateway: authenticated sockets join channels or DM conversations,
// post channel messages, send typing signals, and receive broadcasts.
// Presence is derived from actual socket state: a user is online while at
// least one of their sockets is open. Shares the HTTP server.
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const db = require('./db');
const { secret, now, uuid, visibleChannel } = require('./util');
const dms = require('./services/dms');

function createGateway(server) {
  const wss = new WebSocket.Server({ noServer: true });
  // userId -> Set<ws>. The single source of truth for presence.
  const userSockets = new Map();

  function socketsOf(userId) {
    return userSockets.get(String(userId)) || new Set();
  }

  function isOnline(userId) {
    const s = userSockets.get(String(userId));
    return !!s && [...s].some((c) => c.readyState === WebSocket.OPEN);
  }

  function getPresence(ids) {
    const out = {};
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      out[String(id)] = isOnline(id) ? 'online' : 'offline';
    });
    return out;
  }

  function sendToUser(userId, payload) {
    const data = JSON.stringify(payload);
    socketsOf(userId).forEach((c) => {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(data); } catch { /* dead socket: cleaned on close */ }
      }
    });
  }

  function broadcast(serverId, channelId, payload) {
    const data = JSON.stringify(payload);
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && c.serverId === serverId && c.channelId === channelId) {
        c.send(data);
      }
    });
  }

  // DM delivery: every connected socket of every participant. Clients
  // dedupe by message id (the sender's own tabs get the event too).
  function broadcastDm(memberIds, payload) {
    const data = JSON.stringify(payload);
    (memberIds || []).forEach((id) => {
      socketsOf(id).forEach((c) => {
        if (c.readyState === WebSocket.OPEN && c.dmIds && c.dmIds.has(String(payload.conversationId))) {
          try { c.send(data); } catch { /* dead socket */ }
        }
      });
    });
  }

  // Users who should hear about this user's presence flips: DM peers plus
  // friends. Best-effort: presence must never break messaging.
  async function affectedUsers(userId) {
    try {
      const peers = await db.all(
        `SELECT om.user_id AS id FROM dm_members m
         JOIN dm_members om ON om.conversation_id = m.conversation_id
         WHERE m.user_id = ? AND om.user_id != ?`,
        [userId, userId]
      );
      const friends = await db.all('SELECT friend_id AS id FROM friendships WHERE user_id = ?', [userId]);
      const ids = new Set();
      peers.concat(friends).forEach((r) => ids.add(String(r.id)));
      ids.delete(String(userId));
      return [...ids];
    } catch {
      return [];
    }
  }

  async function announcePresence(userId, presence) {
    const targets = await affectedUsers(userId);
    targets.forEach((id) => {
      if (isOnline(id)) sendToUser(id, { type: 'presence', userId: String(userId), presence });
    });
  }

  function trackOpen(ws, userId) {
    const id = String(userId);
    if (!userSockets.has(id)) userSockets.set(id, new Set());
    const first = ![...userSockets.get(id)].some((c) => c !== ws && c.readyState === WebSocket.OPEN);
    userSockets.get(id).add(ws);
    if (first) announcePresence(id, 'online').catch(() => {});
  }

  function trackClose(ws, userId) {
    const id = String(userId);
    const set = userSockets.get(id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      userSockets.delete(id);
      announcePresence(id, 'offline').catch(() => {});
    }
  }

  wss.on('connection', (ws, req) => {
    let token = null;
    try {
      token = new URL(`ws://${req.headers.host}${req.url}`).searchParams.get('token');
    } catch { ws.close(); return; }
    if (!token) { ws.close(); return; }
    let user;
    try {
      user = jwt.verify(token, secret());
    } catch { ws.close(); return; }
    (async () => {
      if (user.jti) {
        const revoked = await db.get('SELECT 1 FROM revoked_tokens WHERE jti = ?', [user.jti]);
        if (revoked) { ws.close(); return; }
      }
      ws.user = user;
      ws.dmIds = new Set();
      trackOpen(ws, user.id);
      ws.on('close', () => trackClose(ws, user.id));
      ws.on('message', (raw) => {
        (async () => {
          let data;
          try { data = JSON.parse(raw); } catch { return; }
          if (data.type === 'join') {
            const ch = await visibleChannel(data.channelId, user.id);
            if (!ch) return;
            ws.serverId = ch.server_id;
            ws.channelId = ch.id;
          } else if (data.type === 'msg') {
            if (!ws.channelId) return;
            const content = String(data.content || '').trim().slice(0, 2000);
            if (!content) return;
            const ch = await visibleChannel(ws.channelId, user.id);
            if (!ch) return;
            const msg = {
              id: uuid(), channel_id: ch.id, server_id: ch.server_id,
              author_id: user.id, user: user.username, content, created_at: now(),
            };
            try {
              await db.run(
                'INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
                [msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at]
              );
            } catch { return; }
            broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
          } else if (data.type === 'dm:join') {
            // Join a DM room to receive its events. Membership verified.
            const seen = await dms.visibleConversation(data.conversationId, user.id);
            if (!seen) return;
            ws.dmIds.add(String(data.conversationId));
          } else if (data.type === 'dm:typing') {
            // Ephemeral: never stored. Clients throttle before sending.
            const cid = String(data.conversationId || '');
            if (!cid || !ws.dmIds.has(cid)) return;
            const members = await dms.memberIds(cid);
            if (members.indexOf(String(user.id)) === -1) return;
            broadcastDm(members.filter((id) => String(id) !== String(user.id)), {
              type: 'dm:typing', conversationId: cid, userId: user.id, username: user.username,
            });
          }
        })().catch(() => { /* malformed payload: ignore */ });
      });
    })().catch(() => ws.close());
  });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return { broadcast, broadcastDm, sendToUser, isOnline, getPresence };
}

module.exports = createGateway;
