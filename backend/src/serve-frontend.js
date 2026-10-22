'use strict';

// The frontend server of a split deployment: the web client and the public
// website, and nothing else.
//
//   npm run start:frontend
//
// One server used to carry all of it: API, gateway, jobs, client, site. That
// shape still exists (it is the default, and it is what "npm start" runs) and
// it is the right shape until it is not. The shape stops being right when
// static traffic and API traffic want different machines - a client server
// close to the readers and an API server that holds the database - or when
// the operator wants a rebuild of the client to be a file copy on a machine
// that has never touched the database. This entry is that second server.
//
// What it does not have is the point: no database, no API, no WebSocket
// gateway, no background jobs. It cannot answer an API question, so it never
// claims to: /api paths get the same JSON envelope an API 404 gets, worded
// for this server, and nothing here decides anything about data.
//
// What it needs is one fact the API server also knows: where the API lives.
// That is TRYCORD_API_URL, validated here at start-up rather than discovered
// by the first browser that fails - and the API server must list this
// server's origin in CLIENT_ORIGIN, because the browsers it serves talk to
// it from here with their bearer token in a header, and the API's CORS
// allowlist is what answers them.
//
// The composition below is the serving half of boot(), in the same order,
// from the same modules. Express is first-match-wins, so the order is not a
// preference: the public site claims the origin root, the client claims its
// mount and the root when no site is present, the SPA fallback claims the
// application routes last, and the /api envelope catches whatever nobody
// above it wanted.
//
// A request that should have reached the static trees but found a file that
// does not exist is answered the way the API server answers it: a path with
// a file extension falls through to 404 rather than being handed an HTML
// document, because a broken script tag must stay a 404 rather than become
// a syntax error far from the cause.

require('dotenv').config(process.env.DOTENV_CONFIG_PATH
  ? { path: process.env.DOTENV_CONFIG_PATH, quiet: true }
  : { quiet: true });
const express = require('express');
const http = require('http');
const serveClient = require('./serve-client');
const headers = require('./headers');
const pages = require('./services/pages');
const { currentFrontendRole } = require('./deployment-role');
const { VERSION } = require('./version');

// The API origin this server tells the browser about, validated or refused.
//
// This is the one required setting, and it is required for a reason the
// client cannot fix at runtime: with no API origin, backend.json and
// runtime-config.js would name this very origin, and every request the
// client made would come back to a server that has no API - presenting as
// an instance where sign-in never succeeds. The value must be a bare
// http(s) origin; a path on it would produce /api/api/... requests, which
// the client reads as a session problem rather than the configuration
// mistake it is.
function requireApiOrigin() {
  const named = serveClient.apiOriginOnly(process.env.TRYCORD_API_URL || process.env.API_URL || '');
  if (named) return named;
  const raw = String(process.env.TRYCORD_API_URL || process.env.API_URL || '').trim();
  if (!raw) {
    throw new Error(
      'TRYCORD_API_URL is not set. The frontend server serves only the web client '
      + 'and the public site; the API lives on a separate server, and the clients '
      + 'served from here have to be told its address. Set it to that server\u2019s '
      + 'public origin, e.g. TRYCORD_API_URL=https://chat-api.example.com'
    );
  }
  throw new Error(
    'TRYCORD_API_URL is not a usable address: "' + raw + '" is not an http(s) origin. '
    + 'Set the bare origin, e.g. TRYCORD_API_URL=https://chat-api.example.com - a path '
    + 'on it would have the client build /api/api/... requests.'
  );
}

async function bootFrontend(options = {}) {
  // The role is a cross-check, not a switch: this process is the frontend by
  // definition, so an operator who points the variable somewhere else has
  // started the wrong entry point and is told which one to use.
  currentFrontendRole();

  // Validated before anything is opened, so a deployment that cannot work
  // stops here rather than on somebody's first sign-in.
  const apiUrl = requireApiOrigin();

  // Everything else is optional and read from the environment, because this
  // process has no configuration store: there is no database here to read a
  // saved value from, and adding one would be un-splitting the deployment.
  const publicUrl = String(process.env.TRYCORD_PUBLIC_URL || '').trim();
  const globalUrl = String(process.env.GLOBAL_TRYCORD_URL || '').trim();
  const instanceId = String(process.env.TRYCORD_INSTANCE_ID || '').trim();
  const appMount = String(process.env.TRYCORD_APP_MOUNT || '').trim().replace(/\/+$/, '');
  const port = options.port || parseInt(process.env.PORT || '9971', 10);
  const host = options.host || process.env.HOST || '0.0.0.0';

  console.log('[info] deployment role: frontend - the web client and the public site '
    + 'are served here; the API is at ' + apiUrl);
  console.log('[info] this server\u2019s origin must be listed in CLIENT_ORIGIN on the API server '
    + '(e.g. CLIENT_ORIGIN=' + (publicUrl || 'https://chat.example.com') + '), or the '
    + 'browsers served from here get no CORS answer.');

  const app = express();
  const server = http.createServer(app);

  // Request IDs for correlating logs and error reports. Cheap, no PII.
  app.use((req, res, next) => {
    req.requestId = Math.random().toString(36).slice(2, 10);
    res.set('X-Request-Id', req.requestId);
    next();
  });

  // The same policy the API server answers with. It is one module, not a
  // copy: the client here talks to the API over the network, so its
  // connect-src needs the API's origins, and the policy reads the same
  // configuration the API reads for the same purpose.
  app.use(headers.securityHeaders({
    inst: { publicUrl, globalUrl },
  }));

  app.get('/health', (req, res) => {
    // No /ready: there is no database to be ready for, and nothing to
    // open. A listener that answers is a frontend server that works.
    res.json({ ok: true, role: 'frontend', version: VERSION });
  });

  // Runtime client configuration for browsers served by this server. The
  // API address is the validated one; there is no fallback to this origin,
  // because this origin has no API for the client to reach.
  const cfg = { API_URL: apiUrl };
  const apiBackup = headers.apiBackup();
  // Shipped so a browser that has no backend.json still knows where the
  // backup is, exactly as the API server ships it.
  if (apiBackup) cfg.API_BACKUP_URL = apiBackup;
  // Only labelled when it was configured: this process is not the instance,
  // and an invented 'local' would be a fact about a machine that does not
  // exist.
  if (instanceId) cfg.instanceId = instanceId;
  if (globalUrl) cfg.globalUrl = globalUrl;
  app.get('/runtime-config.js', serveClient.runtimeConfigRoute(cfg));

  // The origin root, the clean site pages, the sitemap. Mounted before the
  // client, for the same reason boot() mounts it there: the site owns '/'
  // when it exists, and "open the app" keeps working wherever the client
  // is served from.
  const publicDir = serveClient.mountPublicSite(app, {
    serverDir: __dirname,
    clientDir: null,
    pages,
    originOf: serveClient.originOf,
  });

  const clientDir = serveClient.mountClient(app, {
    serverDir: __dirname,
    appMount,
    originOf: serveClient.originOf,
    cspOriginOf: headers.cspOriginOf,
  });
  if (!clientDir) {
    console.warn('[warn] the frontend server has no client to serve. That is not an '
      + 'API-only configuration; set TRYCORD_CLIENT_DIR to the directory holding '
      + 'index.html, or this server answers with 404s.');
  }

  // The first path segment of every application route, derived from the
  // request rather than configured - the same function boot() uses, so a
  // deep link on the mount survives a refresh here exactly as it does on
  // the API server.
  function mountOf(reqPath) {
    if (appMount) {
      const seg = reqPath.split('/').filter(Boolean)[0] || '';
      return seg === appMount.replace(/^\//, '') ? appMount : '';
    }
    return '';
  }

  serveClient.mountSpaFallback(app, {
    clientDir,
    publicDir,
    appMount,
    mountOf,
  });

  // An unmatched /api path is answered in the same envelope as every API
  // error, so a browser (or a misrouted proxy) that asks this server for
  // data gets a parseable "no" that says where to ask instead - not an HTML
  // document the client would choke on.
  app.use('/api', (req, res, next) => {
    if (res.headersSent) return next();
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'No API on the frontend server. The API lives at ' + apiUrl
          + '; point the client there (backend.json and /runtime-config.js already do).',
      },
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[error]', err && err.message ? err.message : err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      console.log('Trycord frontend server listening on http://' + host + ':' + port);
      if (publicUrl) console.log('Web client available at ' + publicUrl);
      resolve();
    });
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return { app, server, close, port: server.address() ? server.address().port : port, apiURL: apiUrl };
}

if (require.main === module) {
  bootFrontend().then(({ server }) => {
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[info] ${signal}: draining connections…`);
      server.close(() => {
        console.log('[info] shutdown complete');
        process.exit(0);
      });
      // Don't hang forever on stubborn keep-alives - same guard as the API server.
      setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((e) => {
    console.error('startup failed: ' + (e.message || e));
    process.exit(1);
  });
}

module.exports = { boot: bootFrontend, requireApiOrigin };
