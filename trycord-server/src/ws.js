// Realtime gateway: authenticated sockets join channels, post messages,
// and receive broadcasts for their channel. Shares the HTTP server.
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const db = require('./db');
const { secret, now, uuid, visibleChannel } = require('./util');

function createGateway(server) {
  const wss = new WebSocket.Server({ noServer: true });

  function broadcast(serverId, channelId, payload) {
    const data = JSON.stringify(payload);
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && c.serverId === serverId && c.channelId === channelId) {
        c.send(data);
      }
    });
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
          }
        })().catch(() => { /* malformed payload: ignore */ });
      });
    })().catch(() => ws.close());
  });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return { broadcast };
}

module.exports = createGateway;
