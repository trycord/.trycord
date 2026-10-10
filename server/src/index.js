// Startup. Wires the pieces together, in the order they depend on each other:
// config, database, HTTP server, realtime gateway, static client, housekeeping.

const http = require('http');
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const { buildApp } = require('./http/app');
const createGateway = require('./ws');
const auth = require('./services/auth');

async function start() {
  await db.connect();
  console.log(`[info] database connected (${config.db.client})`);

  const app = buildApp();
  const server = http.createServer(app);

  // The gateway shares this HTTP server: same bind address, no second port.
  const gateway = createGateway(server, config);
  app.set('gateway', gateway);

  mountStatic(app, server);

  // Housekeeping runs once at boot and then hourly, unref'd so it never keeps the
  // process alive on its own.
  const tick = async () => {
    try { await auth.purgeExpired(); } catch { /* shutting down */ }
  };
  await tick();
  setInterval(tick, 60 * 60 * 1000).unref();

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(config.port, config.host, () => {
      const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
      console.log(`[info] "${config.instanceName}" listening on http://${shown}:${config.port}`);
      resolve();
    });
  });

  return { app, server, gateway };
}

// The static client, and the fallback that answers a deep link. The fallback is mounted
// last and only for the application's own route prefixes, so an unrelated path still
// belongs to whatever else is published from this origin.
const APP_PREFIXES = new Set([
  'home', 'dms', 'settings', 'account', 'server', 'servers', 'c', 'admin',
  'friends', 'notifications', 'discover', 'profile', 'users', 'invite',
  'login', 'register', 'forgot', 'reset-password', 'verify-email',
  'menu', 'legal', 'channel', 'message', 'support',
]);

function mountStatic(app, server) {
  const clientDir = findClientDir();
  if (!clientDir) {
    console.warn('[warn] no web client found — serving the API only');
    return null;
  }

  const sendIndex = (mount, res) => (req, res2, next) => {
    express.static(clientDir, { index: false })(req, res2, () => {
      res2.sendFile(path.join(clientDir, 'index.html'));
    });
  };
  void sendIndex;

  // The index is rewritten per request because it is the file that carries the mount in
  // its <base href>, and this process is the only thing that knows where it is mounted.
  const serveIndex = (req, res, next) => {
    express.static(clientDir, { index: false })(req, res, () => {
      express.static(path.join(clientDir), { index: 'index.html' })(req, res, next);
    });
  };

  app.use(express.static(clientDir, { index: false, fallthrough: true }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const first = req.path.split('/').filter(Boolean)[0] || '';
    if (!APP_PREFIXES.has(first)) return next();
    // A path that looks like a file and is not one is a 404, not the shell: asking for
    // /app/js/app.js and receiving HTML is how the client gets a black screen with
    // nothing in the console to act on.
    if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return next();
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  void server;
  console.log(`[info] serving web client from ${clientDir}`);
  return clientDir;
}

function findClientDir() {
  const here = path.join(__dirname, '..');
  const candidates = [
    process.env.TRYCORD_CLIENT_DIR,
    path.join(here, '..', '..', 'frontend'),
    path.join(here, '..', 'client'),
    path.join(here, '..', '..', 'trycord-desktop', 'client'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (require('fs').existsSync(path.join(dir, 'index.html'))) return dir;
    } catch { /* unreadable candidate is simply not a candidate */ }
  }
  return null;
}

async function shutdown(server, signal) {
  console.log(`[info] ${signal}: draining connections…`);
  server.close(async () => {
    await db.close().catch(() => {});
    console.log('[info] shutdown complete');
    process.exit(0);
  });
  // A socket that will not drain on its own gets a deadline.
  setTimeout(() => process.exit(0), 10000).unref();
}

if (require.main === module) {
  start()
    .then(({ server }) => {
      let stopping = false;
      const stop = (signal) => {
        if (stopping) return;
        stopping = true;
        shutdown(server, signal);
      };
      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('SIGINT', () => stop('SIGINT'));
    })
    .catch((e) => {
      console.error('[fatal] startup failed:', (e && e.stack) || e);
      process.exit(1);
    });
}

module.exports = { start, shutdown };
