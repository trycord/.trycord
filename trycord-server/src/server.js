// Trycord server (optional self-hosting backend): resource API + WebSocket
// gateway + static web client.
// Run:  copy .env.example to .env, configure, then npm install && npm start.
//
// Boot: validate env -> connect database -> apply schema -> listen.
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

const PORT = parseInt(process.env.PORT || '9971', 10);
const HOST = process.env.HOST || '0.0.0.0';

function instanceConfig() {
  return {
    instanceId: (process.env.TRYCORD_INSTANCE_ID || 'local').trim() || 'local',
    name: (process.env.TRYCORD_NAME || 'Trycord').trim() || 'Trycord',
    publicUrl: (process.env.TRYCORD_PUBLIC_URL || '').trim(),
    globalUrl: (process.env.GLOBAL_TRYCORD_URL || '').trim(),
    clientOrigins: String(process.env.CLIENT_ORIGIN || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}

// CORS: explicit allowlist when CLIENT_ORIGIN is set; otherwise a restricted
// dev profile (same-origin/non-browser requests, localhost, file://).
// Never unrestricted cors() in production.
function corsOptions(clientOrigins) {
  return {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl, same-origin navigations, health probes
      if (clientOrigins.length) return cb(null, clientOrigins.includes(origin));
      try {
        const u = new URL(origin);
        const host = u.hostname;
        if (u.protocol === 'file:' || origin === 'null') return cb(null, true);
        if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return cb(null, true);
        return cb(new Error('CORS: origin not allowed'));
      } catch {
        return cb(new Error('CORS: origin not allowed'));
      }
    },
  };
}

async function boot() {
  if (!process.env.JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is required. Each instance must have its own secret — ' +
      'generate one and set it in .env (see .env.example). The official secret is never shared.'
    );
  }
  const inst = instanceConfig();
  await db.connect();
  console.log(`[info] database connected (${db.dialect})`);

  const app = express();
  const server = http.createServer(app);
  app.use(cors(corsOptions(inst.clientOrigins)));
  if (inst.clientOrigins.length) {
    console.log('[info] CORS allowlist: ' + inst.clientOrigins.join(', '));
  } else {
    console.log('[info] CORS dev profile: same-origin + localhost + file:// only');
  }
  app.use(express.json({ limit: '1mb' }));

  const uploadsDir = path.join(__dirname, '..', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', express.static(uploadsDir));

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/health', async (req, res) => {
    try {
      await db.get('SELECT 1');
      res.json({ ok: true, db: 'ok', instanceId: inst.instanceId });
    } catch {
      res.status(503).json({ ok: false, db: 'unreachable', instanceId: inst.instanceId });
    }
  });

  // Safe public instance metadata. Never secrets, paths, or credentials.
  app.get('/api/instance', (req, res) => {
    res.json({
      instanceId: inst.instanceId,
      name: inst.name,
      globalSync: inst.globalUrl !== '',
      features: { publicDiscovery: true, uploads: true },
    });
  });

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
  app.get('/api/me', require('./middleware/auth'), async (req, res, next) => {
    try {
      const row = await db.get(
        'SELECT id, username, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?',
        [req.user.id]
      );
      if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'user not found' } });
      res.json(row);
    } catch (e) { next(e); }
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

  // Consistent error envelope for anything that escapes routes.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[error]', err && err.message ? err.message : err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  // Drop expired token revocations (uses JS time — portable across databases).
  const purge = async () => {
    try {
      await db.run('DELETE FROM revoked_tokens WHERE expires_at < ?', [new Date().toISOString()]);
    } catch { /* shutting down */ }
  };
  await purge();
  setInterval(purge, 60 * 60 * 1000).unref();

  // The WebSocket gateway shares this HTTP server: same bind address, no second port.
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, HOST, () => {
      const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
      console.log(`.trycord server "${inst.instanceId}" listening on http://${HOST}:${PORT}`);
      console.log(`Open http://${displayHost}:${PORT} in a browser — the chat client is served from the server itself.`);
      resolve();
    });
  });
  return { app, server };
}

if (require.main === module) {
  boot().catch((e) => {
    console.error('startup failed: ' + (e.message || e));
    process.exit(1);
  });
}

module.exports = { boot };
