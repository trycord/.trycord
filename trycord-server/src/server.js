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

  // Request IDs for correlating logs and error reports. Cheap, no PII.
  app.use((req, res, next) => {
    req.requestId = Math.random().toString(36).slice(2, 10);
    res.set('X-Request-Id', req.requestId);
    next();
  });

  // Attachment storage exists on disk but is NEVER mounted as a public
  // static directory: every read goes through the authenticated
  // /api/attachments/:id route (see routes/attachments.js).
  require('./services/uploads');

  app.get('/health', (req, res) => res.json({ ok: true }));
  // Readiness: process alive AND database answering. Load balancers and
  // the desktop smoke test use this to know traffic is safe.
  app.get('/ready', async (req, res) => {
    try {
      await db.get('SELECT 1');
      res.json({ ok: true, instanceId: inst.instanceId });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.get('/api/health', async (req, res) => {
    try {
      await db.get('SELECT 1');
      res.json({ ok: true, db: 'ok', instanceId: inst.instanceId, client: !!clientDir });
    } catch {
      res.status(503).json({ ok: false, db: 'unreachable', instanceId: inst.instanceId, client: !!clientDir });
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

  // Runtime client configuration for browsers served by this server.
  // Only safe public keys; TRYCORD_API_URL wins, else the public URL (if set).
  // Lets a deployment pin the API origin without editing client files.
  app.get('/runtime-config.js', (req, res) => {
    const cfg = {};
    const apiUrl = (process.env.TRYCORD_API_URL || '').trim() || inst.publicUrl;
    if (apiUrl) cfg.API_URL = apiUrl;
    if (inst.instanceId) cfg.instanceId = inst.instanceId;
    if (inst.globalUrl) cfg.globalUrl = inst.globalUrl;
    res.type('application/javascript').set('Cache-Control', 'no-store').send(
      'window.TRYCORD_CONFIG = Object.assign(window.TRYCORD_CONFIG || {}, ' +
      JSON.stringify(cfg) + ');'
    );
  });

  // Public legal document versions (no auth): the client shows these exact
  // versions at registration and records acceptance against them.
  app.get('/api/legal', (req, res) => {
    const legal = require('./legal');
    res.json({
      termsVersion: legal.TERMS_VERSION,
      privacyVersion: legal.PRIVACY_VERSION,
      updated: legal.LEGAL_UPDATED,
    });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/servers/:serverId/channels', require('./routes/channels'));
  app.use('/api/servers/:serverId/categories', require('./routes/categories'));
  app.use('/api/servers/:serverId/roles', require('./routes/roles'));
  app.use('/api/servers/:serverId/invites', inviteRoutes.managed);
  app.use('/api/channels/:channelId/messages', require('./routes/messages'));
  app.use('/api', require('./routes/attachments'));
  app.use('/api/servers', require('./routes/servers'));
  app.use('/api/invites', inviteRoutes.byCode);
  app.use('/api/discover', require('./routes/discover'));
  app.use('/api/activity', require('./routes/activity'));
  app.use('/api/dms', require('./routes/dms'));
  app.use('/api/friends', require('./routes/friends'));
  app.use('/api/notifications', require('./routes/notifications'));

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
  // Silent skipping here is what produces a bare "Cannot GET /" in production,
  // so log explicitly either way.
  let clientDir = null;
  for (const candidate of [
    path.join(__dirname, '..', '..', 'trycord-client'),
    path.join(__dirname, '..', 'client'),
    path.join(__dirname, '..', '..', 'trycord-desktop', 'client'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      clientDir = candidate;
      // Entry points are never cached (a stale index.html paired with fresh
      // or stale JS/CSS is what renders a blank page). Versioned assets use
      // conditional revalidation instead: browsers revalidate on every load
      // (ETag), so new deploys are picked up immediately without giving up
      // caching entirely.
      app.use(express.static(candidate, {
        setHeaders(res, filePath) {
          if (/(^|[\\/])(index\.html|config\.js)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }));
      console.log('[info] serving web client from ' + candidate);
      break;
    }
  }
  if (!clientDir) {
    console.warn('[warn] web client NOT served: no index.html found next to the server. ' +
      'Deploy the full repository (with trycord-client/) or ignore this if API-only.');
  }

  const { broadcast, broadcastDm, sendToUser, isOnline, getPresence } = createGateway(server);
  require('./routes/messages').setBroadcaster(broadcast);
  require('./routes/dms').setGateway({ broadcastDm, sendToUser, isOnline });
  require('./routes/friends').setGateway({ sendToUser });
  require('./routes/users').setGateway({ getPresence });

  // Consistent error envelope for anything that escapes routes.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[error]', err && err.message ? err.message : err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  // Drop expired token revocations (uses JS time — portable across databases).
  const uploads = require('./services/uploads');
  const purge = async () => {
    try {
      await db.run('DELETE FROM revoked_tokens WHERE expires_at < ?', [new Date().toISOString()]);
      await db.run('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL', [new Date().toISOString()]);
      await db.run('DELETE FROM email_verifications WHERE expires_at < ? OR used_at IS NOT NULL', [new Date().toISOString()]);
      await uploads.purgePending();
    } catch { /* shutting down */ }
  };
  await purge();
  setInterval(purge, 60 * 60 * 1000).unref();

  // The WebSocket gateway shares this HTTP server: same bind address, no second port.
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, HOST, () => {
      console.log(`Trycord server "${inst.instanceId}" listening on http://${HOST}:${PORT}`);
      if (inst.publicUrl) {
        console.log(`Web client available at ${inst.publicUrl}`);
      } else {
        const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
        console.log(`Web client available at http://${displayHost}:${PORT}`);
      }
      resolve();
    });
  });
  return { app, server };
}

if (require.main === module) {
  boot().then(({ server }) => {
    // Graceful shutdown: stop accepting, let sockets drain, close the
    // database, then exit. Never corrupt state on the way out.
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[info] ${signal}: draining connections…`);
      server.close(() => {
        db.close()
          .catch(() => {})
          .finally(() => {
            console.log('[info] shutdown complete');
            process.exit(0);
          });
      });
      // Don't hang forever on stubborn keep-alives.
      setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((e) => {
    console.error('startup failed: ' + (e.message || e));
    process.exit(1);
  });
}

module.exports = { boot };
