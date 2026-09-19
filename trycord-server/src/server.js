// Trycord server: REST API + WebSocket gateway + static web client.
// Run:  npm install && npm start   ->  http://localhost:3000
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const db = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set — using insecure dev default. See .env.example');
}

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Serve the web client (repo layout, packaged layout, desktop copy).
for (const candidate of [
  path.join(__dirname, '..', '..', 'trycord-client'),
  path.join(__dirname, '..', 'client'),
  path.join(__dirname, '..', '..', 'trycord-desktop', 'client'),
]) {
  if (fs.existsSync(path.join(candidate, 'index.html'))) {
    app.use(express.static(candidate));
    console.log('[info] serving web client from ' + candidate);
    break;
  }
}

// --- helpers ---------------------------------------------------------------
const now = () => new Date().toISOString();
const sign = (user) => jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Channel row if it exists AND the user is a member of its server, else null.
function visibleChannel(channelId, userId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return null;
  const member = db.prepare('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?')
    .get(userId, ch.server_id);
  return member ? ch : null;
}

// --- health ----------------------------------------------------------------
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- auth ------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password must be 6+ characters' });
  const name = String(username).trim();
  try {
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(String(password), 10);
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, displayName || name, hash, now());
    const token = sign({ id, username: name });
    res.json({ token, user: { id, username: name, displayName: displayName || name } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({
    token: sign(user),
    user: { id: user.id, username: user.username, displayName: user.display_name },
  });
});

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name AS displayName FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
});

// --- servers ---------------------------------------------------------------
app.post('/api/servers', auth, (req, res) => {
  const { name, description, joinCode } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const serverId = crypto.randomUUID();
  const code = String(joinCode || crypto.randomBytes(4).toString('hex')).toLowerCase();
  try {
    db.prepare('INSERT INTO servers (id, name, description, owner_id, join_code, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(serverId, name, description || '', req.user.id, code, now());
    db.prepare('INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), req.user.id, serverId, req.user.username, now());
    const channelId = crypto.randomUUID();
    db.prepare("INSERT INTO channels (id, server_id, name, topic, type, position) VALUES (?, ?, 'general', 'General chat', 'text', 0)")
      .run(channelId, serverId);
    res.json({ serverId, joinCode: code, channelId });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'join code taken' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/servers', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members m ON m.server_id = s.id
    WHERE m.user_id = ? ORDER BY s.created_at DESC
  `).all(req.user.id));
});

app.get('/api/servers/by-code/:code', auth, (req, res) => {
  const srv = db.prepare('SELECT id, name, description, created_at FROM servers WHERE join_code = ?')
    .get(String(req.params.code).toLowerCase());
  if (!srv) return res.status(404).json({ error: 'server not found' });
  res.json(srv);
});

app.post('/api/servers/join/:code', auth, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE join_code = ?').get(String(req.params.code).toLowerCase());
  if (!srv) return res.status(404).json({ error: 'server not found' });
  const existing = db.prepare('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?')
    .get(req.user.id, srv.id);
  if (existing) return res.json({ serverId: srv.id, alreadyMember: true });
  db.prepare('INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user.id, srv.id, req.user.username, now());
  res.json({ serverId: srv.id, name: srv.name });
});

// --- channels --------------------------------------------------------------
app.get('/api/servers/:serverId/channels', auth, (req, res) => {
  const member = db.prepare('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?')
    .get(req.user.id, req.params.serverId);
  if (!member) return res.status(403).json({ error: 'not a member' });
  res.json(db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, name')
    .all(req.params.serverId));
});

app.post('/api/servers/:serverId/channels', auth, (req, res) => {
  const { name, topic } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const member = db.prepare('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?')
    .get(req.user.id, req.params.serverId);
  if (!member) return res.status(403).json({ error: 'not a member' });
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?')
    .get(req.params.serverId).p;
  const channelId = crypto.randomUUID();
  db.prepare('INSERT INTO channels (id, server_id, name, topic, type, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(channelId, req.params.serverId, name, topic || '', 'text', pos);
  res.json({ channelId });
});

// --- messages --------------------------------------------------------------
app.get('/api/channels/:channelId/messages', auth, (req, res) => {
  if (!visibleChannel(req.params.channelId, req.user.id)) {
    return res.status(403).json({ error: 'channel not found or not a member' });
  }
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const rows = db.prepare(`
    SELECT m.*, u.username AS author_name FROM messages m
    JOIN users u ON u.id = m.author_id
    WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT ?
  `).all(req.params.channelId, limit);
  res.json(rows.reverse());
});

app.post('/api/channels/:channelId/messages', auth, (req, res) => {
  const ch = visibleChannel(req.params.channelId, req.user.id);
  if (!ch) return res.status(403).json({ error: 'channel not found or not a member' });
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: 'content required' });
  const msg = {
    id: crypto.randomUUID(),
    channel_id: ch.id,
    server_id: ch.server_id,
    author_id: req.user.id,
    user: req.user.username,
    content,
    created_at: now(),
  };
  db.prepare('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at);
  broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
  res.json(msg);
});

// --- realtime --------------------------------------------------------------
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
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) { ws.close(); return; }
    ws.user = user;
    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      if (data.type === 'join') {
        const ch = visibleChannel(data.channelId, user.id);
        if (!ch) return;
        ws.serverId = ch.server_id;
        ws.channelId = ch.id;
      } else if (data.type === 'msg') {
        if (!ws.channelId) return;
        const content = String(data.content || '').trim();
        if (!content) return;
        const ch = visibleChannel(ws.channelId, user.id);
        if (!ch) return;
        const msg = {
          id: crypto.randomUUID(), channel_id: ch.id, server_id: ch.server_id,
          author_id: user.id, user: user.username, content, created_at: now(),
        };
        try {
          db.prepare('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at);
        } catch { return; }
        broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
      }
    });
  });
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// --- start -----------------------------------------------------------------
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`.trycord server at http://localhost:${PORT}`);
    console.log('Open that URL in a browser — the chat client is served from the server itself.');
  });
}

module.exports = { app, server, db };
