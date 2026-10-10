// The Express application: middleware stack, health endpoints, routers, and the
// catch-all error envelope.
//
// Routers are mounted here and only here. A route module is a list of endpoints; this
// file is the one place that knows the whole surface exists.

const express = require('express');
const cors = require('cors');
const config = require('../config');
const db = require('../db');
const { fail } = require('./errors');

function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 'loopback');

  const allowed = config.corsOrigins;
  app.use(cors({
    origin(origin, cb) {
      // A same-origin request sends no Origin header, and curl sends none at all; both
      // are allowed. A browser on a listed origin is allowed. Anything else is not.
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
    maxAge: 600,
  }));

  app.use(express.json({ limit: '1mb' }));

  // Security headers on every response. CSP is built per request because the connect-src
  // allowlist depends on which backend the client is configured to talk to.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', csp());
    next();
  });

  // Health, before anything that can fail. A load balancer and an operator both need an
  // answer that does not depend on the database being up.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, instanceId: config.instanceId });
  });

  app.get('/api/ready', async (req, res) => {
    try {
      await db.get('SELECT 1 AS ok');
      res.json({ ok: true, db: 'ok' });
    } catch (e) {
      res.status(503).json({ ok: false, db: 'unreachable' });
    }
  });

  // What this instance is, for the client's instance picker. Never any configuration
  // detail a client could use to attack it.
  app.get('/api/instance', (req, res) => {
    res.json({
      instanceId: config.instanceId,
      name: config.instanceName,
      publicUrl: config.publicUrl || '',
      globalSync: false,
      features: {
        publicDiscovery: config.features.publicDiscovery,
        uploads: config.features.uploads,
        email: config.features.email,
      },
    });
  });

  const api = express.Router();

  api.use('/auth', require('./routes/auth'));
  api.use('/users', require('./routes/users'));
  api.use('/servers', require('./routes/servers'));
  // Channels live under the community they belong to, which is what the client calls.
  api.use('/servers/:serverId/channels', require('./routes/channels'));
  api.use('/dms', require('./routes/dms'));
  api.use('/friends', require('./routes/friends'));
  api.use('/notifications', require('./routes/notifications'));
  api.use('/invites', require('./routes/invites'));
  api.use('/search', require('./routes/search'));
  api.use('/reports', require('./routes/reports'));
  api.use('/appeals', require('./routes/appeals'));
  api.use('/announcements', require('./routes/announcements'));
  api.use('/admin', require('./routes/admin'));
  api.use('/voice', require('./routes/voice'));
  api.use('/mutes', require('./routes/mutes'));
  api.use('/discover', require('./routes/discover'));

  // Uploads claim the same prefixes as the message routes, so they are mounted first.
  if (config.features.uploads) {
    const attachments = require('./routes/attachments');
    api.use('/', attachments.uploads);
    api.use('/attachments', attachments.downloads);
  }

  api.use('/channels', require('./routes/messages'));
  api.use('/messages', require('./routes/messages'));

  if (config.allowTestHooks) {
    // Test-only hooks, mounted nowhere else. Automated suites must be able to reach the
    // verified state through HTTP alone, since real email delivery is unavailable in CI.
    api.use('/test', require('./routes/test'));
    console.warn('[warn] ALLOW_TEST_HOOKS is enabled — test endpoints are mounted (never do this in production)');
  }

  app.use('/api', api);

  // An unmatched /api path is an API 404 and answers in the same envelope as every other
  // error, so a client with a mistyped path gets JSON rather than a document it cannot
  // parse.
  app.use('/api', (req, res) => fail(res, 'NOT_FOUND', `no API route for ${req.method} ${req.originalUrl}`));

  // The static client and the SPA fallback are mounted by the entry point, after this
  // app is built, because they need the HTTP server to exist.

  // Consistent error envelope for anything that escapes a route.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err && (err.statusCode || err.status)) || 500;

    if (status >= 400 && status < 500) {
      const code = err && err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE'
        : err && err.type === 'entity.parse.failed' ? 'BAD_JSON'
          : 'BAD_REQUEST';
      const message = status === 413 ? 'request body too large'
        : status === 400 ? 'malformed request body'
          : 'bad request';
      try { console.warn(`[warn] request rejected ${status} (${message})`); } catch { /* no console */ }
      return res.status(status).json({ error: { code, message } });
    }

    try { console.error('[error]', (err && err.message) || err); } catch { /* no console */ }
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  return app;
}

function csp() {
  // Everything the client legitimately talks to: its own origin, the configured API
  // origin, and data:/blob: for images it fetched with its own session.
  const origins = [config.publicUrl, config.clientUrl].filter(Boolean);
  const connect = ["'self'", ...(origins.length ? origins : ["'self'"])].join(' ');
  return [
    "default-src 'self'",
    `connect-src ${connect}`,
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

module.exports = { buildApp, csp };
