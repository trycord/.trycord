// Trycord server: resource API + WebSocket gateway + static web client.
// Run:  npm install && npm start   ->  http://localhost:3000
//
//   HTTP -> route (validate + authorize) -> service -> database
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const db = require('./db');
const createGateway = require('./ws');
const inviteRoutes = require('./routes/invites');

const PORT = parseInt(process.env.PORT || '3000', 10);
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

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/servers/:serverId/channels', require('./routes/channels'));
app.use('/api/servers/:serverId/categories', require('./routes/categories'));
app.use('/api/servers/:serverId/roles', require('./routes/roles'));
app.use('/api/servers/:serverId/invites', inviteRoutes.managed);
app.use('/api/channels/:channelId/messages', require('./routes/messages'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/invites', inviteRoutes.byCode);
app.use('/api/discover', require('./routes/discover'));
app.use('/api/activity', require('./routes/activity'));

// Back-compat alias for older clients.
app.get('/api/me', require('./middleware/auth'), (req, res) => {
  const row = db.prepare('SELECT id, username, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?')
    .get(req.user.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'user not found' } });
  res.json(row);
});

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

const { broadcast } = createGateway(server);
require('./routes/messages').setBroadcaster(broadcast);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`.trycord server at http://localhost:${PORT}`);
    console.log('Open that URL in a browser — the chat client is served from the server itself.');
  });
}

module.exports = { app, server, db };
