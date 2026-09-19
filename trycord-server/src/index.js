require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set, using insecure default. Set JWT_SECRET in .env');
}

// Resolve DB path relative to this file, strip file: prefix and quotes
function resolveDbPath() {
  let raw = process.env.DATABASE_URL || './server.db';
  raw = String(raw).trim().replace(/^["']|["']$/g, '');
  if (raw.startsWith('file:')) raw = raw.slice(5);
  if (!path.isAbsolute(raw)) raw = path.join(__dirname, '..', raw);
  return raw;
}
const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
const uploadsDir = path.join(__dirname, '../uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Serve client static if present (../trycord-client or ../../trycord-client)
for (const candidate of [path.join(__dirname, '../../trycord-client'), path.join(__dirname, '../trycord-client')]) {
  if (fs.existsSync(path.join(candidate, 'index.html'))) {
    app.use(express.static(candidate));
    break;
  }
}

// ---------------------------------------------------------------------------
// Initial schema (idempotent)
// ---------------------------------------------------------------------------
function initSchema() {
  // users
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      bio TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      refresh_token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  // servers
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon_url TEXT,
      address TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      join_code TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );
  `);
  // server_members
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      nickname TEXT,
      role_name TEXT,
      joined_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (server_id) REFERENCES servers(id),
      UNIQUE (user_id, server_id)
    );
  `);
  // roles
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      position INTEGER,
      permissions TEXT,
      server_id TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
  // categories
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon_url TEXT,
      position INTEGER,
      collapsed INTEGER DEFAULT 0,
      server_id TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
  // channels
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic TEXT,
      type TEXT NOT NULL,
      position INTEGER,
      server_id TEXT NOT NULL,
      category_id TEXT,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );
  `);
  // messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      content TEXT,
      type TEXT DEFAULT 'text',
      created_at TEXT NOT NULL,
      edited_at TEXT,
      editor_id TEXT,
      author_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_root_id TEXT,
      pinned INTEGER DEFAULT 0,
      FOREIGN KEY (author_id) REFERENCES users(id),
      FOREIGN KEY (editor_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (thread_root_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);
  // reactions
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (message_id, user_id, emoji),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  // attachments
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      uploader_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (uploader_id) REFERENCES users(id)
    );
  `);
  // join_codes (primary codes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS join_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      server_id TEXT NOT NULL,
      expires_at TEXT,
      max_uses INTEGER,
      current_uses INTEGER DEFAULT 0,
      UNIQUE (server_id, code)
    );
  `);
  // invites (temporary)
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      server_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      max_uses INTEGER,
      current_uses INTEGER DEFAULT 0,
      target_channel_id TEXT,
      role_assign_id TEXT,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (creator_id) REFERENCES users(id),
      FOREIGN KEY (target_channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );
  `);
}

// Run init
initSchema();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.sendStatus(401);
  const token = auth.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

// ---------------------------------------------------------------------------
// Routes – Health / Me
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name AS displayName FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ---------------------------------------------------------------------------
// Routes – Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const hash = await bcrypt.hash(password, 10);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const name = String(username).trim();
  try {
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, displayName || name, hash, createdAt);
    const token = signToken({ id, username: name });
    res.json({ token, user: { id, username: name, displayName: displayName || name } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, displayName: user.display_name } });
});

// ---------------------------------------------------------------------------
// Routes – Servers
// ---------------------------------------------------------------------------
app.post('/api/servers', authenticateToken, (req, res) => {
  const { name, description, address, joinCode } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const ownerId = req.user.id;
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(ownerId);
  const serverId = crypto.randomUUID();
  const code = (joinCode || crypto.randomBytes(4).toString('hex')).toLowerCase();
  const createdAt = new Date().toISOString();
  try {
    db.prepare('INSERT INTO servers (id, name, description, address, owner_id, join_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, name, description || '', address || '', ownerId, code, createdAt);
    // owner becomes member
    db.prepare('INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), ownerId, serverId, (owner && owner.username) || name, createdAt);
    // default general channel
    const channelId = crypto.randomUUID();
    db.prepare("INSERT INTO channels (id, name, type, topic, position, server_id) VALUES (?, 'general', 'text', 'General chat', 0, ?)")
      .run(channelId, serverId);
    res.json({ serverId, id: serverId, code, joinCode: code, url: `${address || ''}/join/${code}`, channelId });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'join code already in use' });
    res.status(500).json({ error: e.message });
  }
});

// List servers I belong to
app.get('/api/servers', authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members m ON m.server_id = s.id
    WHERE m.user_id = ?
    ORDER BY s.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

// Lookup server by join code (for preview before joining)
app.get('/api/servers/by-code/:code', authenticateToken, (req, res) => {
  const srv = db.prepare('SELECT id, name, description, icon_url, created_at FROM servers WHERE join_code = ?').get(req.params.code);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  res.json(srv);
});

// Back-compat: old client calls GET /api/servers/:code for preview
app.get('/api/servers/:code', authenticateToken, (req, res) => {
  // Avoid swallowing nested routes – express already prefers longer matches,
  // this only fires for single-segment paths.
  const srv = db.prepare('SELECT * FROM servers WHERE join_code = ?').get(req.params.code);
  if (!srv) {
    // Fall through: maybe caller passed a server id
    const byId = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.code);
    if (!byId) return res.status(404).json({ error: 'Server not found' });
    return res.json(byId);
  }
  res.json(srv);
});

// Join a server by code
app.post('/api/servers/join/:code', authenticateToken, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE join_code = ?').get(req.params.code);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  const existing = db.prepare('SELECT * FROM server_members WHERE user_id = ? AND server_id = ?').get(req.user.id, srv.id);
  if (existing) return res.json({ serverId: srv.id, alreadyMember: true });
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.id);
  try {
    db.prepare('INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), req.user.id, srv.id, (user && user.username) || req.user.username, new Date().toISOString());
    res.json({ serverId: srv.id, name: srv.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Routes – Channels
// ---------------------------------------------------------------------------
app.get('/api/servers/:serverId/channels', authenticateToken, (req, res) => {
  const serverId = req.params.serverId;
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ? AND server_id = ?').get(req.user.id, serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const rows = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, name ASC').all(serverId);
  res.json(rows);
});

app.post('/api/servers/:serverId/channels', authenticateToken, (req, res) => {
  const { name, type, topic, categoryId, position } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const serverId = req.params.serverId;
  // verify member
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ? AND server_id = ?').get(req.user.id, serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const channelId = crypto.randomUUID();
  const nextPos = Number.isInteger(position) ? position
    : (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?').get(serverId).p || 0);
  try {
    db.prepare('INSERT INTO channels (id, name, type, topic, position, server_id, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(channelId, name, type || 'text', topic || '', nextPos, serverId, categoryId || null);
    res.json({ channelId, id: channelId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Routes – Messages
// ---------------------------------------------------------------------------
function channelVisibleTo(channelId, userId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return null;
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ? AND server_id = ?').get(userId, ch.server_id);
  if (!member) return null;
  return ch;
}

app.get('/api/channels/:channelId/messages', authenticateToken, (req, res) => {
  const ch = channelVisibleTo(req.params.channelId, req.user.id);
  if (!ch) return res.status(403).json({ error: 'Not a member or channel not found' });
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const rows = db.prepare(`
    SELECT m.*, u.username AS author_name
    FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.channel_id = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(req.params.channelId, limit);
  res.json(rows.reverse());
});

function broadcastToChannel(serverId, channelId, payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c.serverId === serverId && c.channelId === channelId) {
      c.send(data);
    }
  });
}

app.post('/api/channels/:channelId/messages', authenticateToken, (req, res) => {
  const { content } = req.body;
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content required' });
  const ch = channelVisibleTo(req.params.channelId, req.user.id);
  if (!ch) return res.status(403).json({ error: 'Not a member or channel not found' });
  const channelId = req.params.channelId;
  const messageId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO messages (id, content, type, created_at, author_id, channel_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(messageId, String(content), 'text', createdAt, req.user.id, channelId);
  const msg = { type: 'message', id: messageId, channelId, serverId: ch.server_id, content: String(content), author_id: req.user.id, user: req.user.username, created_at: createdAt };
  broadcastToChannel(ch.server_id, channelId, msg);
  res.json({ messageId, id: messageId, ...msg });
});

// ---------------------------------------------------------------------------
// WebSocket realtime gateway
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  // simple auth via query string token
  let token = null;
  try {
    const url = new URL(`ws://${req.headers.host}${req.url}`);
    token = url.searchParams.get('token');
  } catch (e) { ws.close(); return; }
  if (!token) { ws.close(); return; }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) { ws.close(); return; }
    ws.user = user;
    ws.serverId = null;
    ws.channelId = null;
    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch (e) { return; }
      if (data.type === 'join') {
        ws.serverId = data.serverId || null;
        ws.channelId = data.channelId || null;
      } else if (data.type === 'msg') {
        if (!ws.channelId || !data.content || !String(data.content).trim()) return;
        const ch = channelVisibleTo(ws.channelId, ws.user.id);
        if (!ch) return;
        const messageId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        try {
          db.prepare('INSERT INTO messages (id, content, type, created_at, author_id, channel_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(messageId, String(data.content), 'text', createdAt, ws.user.id, ws.channelId);
        } catch (e) { return; }
        const broadcast = { type: 'message', id: messageId, channelId: ws.channelId, serverId: ch.server_id, content: String(data.content), user: ws.user.username, author_id: ws.user.id, created_at: createdAt };
        broadcastToChannel(ch.server_id, ws.channelId, broadcast);
      }
    });
  });
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`TryCore server listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, db };
