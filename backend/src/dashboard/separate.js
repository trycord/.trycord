'use strict';

// The separate dashboard service.
//
// A presentation process for the administrative surfaces. It serves the same
// client assets the main process serves, points them at the main API, and
// holds nothing else: no database connection, no background jobs, no
// websocket gateway. Every answer it gives about the instance comes from the
// API over HTTP, and every decision about who may see what is the API's.
//
//   node src/dashboard/separate.js
//
// What it is for: a deployment that wants the administrative console on its
// own origin, its own process and its own release cycle, without turning the
// main instance into something it is not. What it is not for: a second
// backend. It cannot answer a question about the instance that the API has
// not answered first.
//
// The contract it keeps with the API is in contract.js. The definitions there
// are the ones this file makes its calls from, so the two cannot drift apart.

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { originCovers } = require('../origins');
const { VERSION } = require('../version');
const {
  CONTRACT_VERSION, ADMIN_PATH, DOCUMENTS, AUTH, HEADERS, ENDPOINTS, CLIENT, FAILURES,
} = require('./contract');
const { parseMode, describe, report, originOf, consoleUrlFromOrigin } = require('./mode');

const DEFAULT_PORT = 9973;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

// The client tree this service serves. The default is the repository's own
// frontend directory, which is the same tree the main process serves.
const DEFAULT_CLIENT_DIR = path.join(__dirname, '..', '..', '..', 'frontend');

// The documents the service answers with the client's own entry document: the
// console, the sign-in screens it needs, and the entry document itself.
const DOCUMENT_PATHS = new Set(['/index.html', ...DOCUMENTS.signIn]);

// The phone module is a second entry document in the same tree, with its own
// backend.json. It is not part of the console, and its configuration names
// the hosted network rather than this instance's API, so it is not served
// here.
const MOBILE_PATH = '/mobile';

// An origin, and nothing else. A path or a query string in one of these
// values is a mistake, and a mistake here becomes an address the console
// sends its requests to.
function requireOrigin(value, label) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error(label + ' is required: it names the address the dashboard talks to, '
      + 'for example https://api.example.com');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(label + ' is not a URL: "' + raw + '"');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(label + ' must be an http(s) address: "' + raw + '"');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(label + ' must be an origin without a path: "' + raw + '"');
  }
  return parsed.origin;
}

// An entry in the origin allowlist.
//
// The list may name a wildcard host ("https://*.example.com"), which is what
// originCovers understands, so it is checked by shape rather than by parsing:
// a bare "*" is never accepted, because it would mean every origin.
function validOriginPattern(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '*') return false;
  return /^https?:\/\/(\*\.)?[A-Za-z0-9.-]+(:\d{1,5})?$/.test(raw);
}

function toPort(value, label) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return DEFAULT_PORT;
  const port = parseInt(raw, 10);
  // 0 asks the operating system for a free port, which is what a test or a
  // supervisor that starts several instances wants.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(label + ' must be a port between 0 and 65535, got "' + raw + '"');
  }
  return port;
}

// How long the service waits for the API before it says the API is not
// answering. A dashboard that hangs on a dead API is a dashboard an operator
// cannot tell apart from a slow one.
function toTimeoutMs(value, label) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const ms = parseInt(raw, 10);
  if (!Number.isInteger(ms) || ms < 100 || ms > 120000) {
    throw new Error(label + ' must be a number of milliseconds between 100 and 120000, got "'
      + raw + '"');
  }
  return ms;
}

// Where the client tree is, and whether it is there.
function resolveClientDir(value) {
  const dir = value
    ? path.resolve(String(value).trim())
    : DEFAULT_CLIENT_DIR;
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error('the dashboard has no client to serve: no index.html in ' + dir
      + '. Set DASHBOARD_CLIENT_DIR to the directory holding the client tree.');
  }
  return dir;
}

/**
 * The service's configuration, read from an environment.
 *
 * Every value is checked here, so a misconfigured service refuses to start
 * with a message that names the variable rather than starting and failing
 * on the first request.
 */
function loadConfig(env) {
  const e = env || process.env;

  const mode = parseMode(e.DASHBOARD_MODE);
  if (mode !== 'separate') {
    throw new Error('DASHBOARD_MODE must be "separate" to run the separate dashboard service '
      + '(it is "' + String(e.DASHBOARD_MODE || '').trim() + '"). Set DASHBOARD_MODE=separate.');
  }

  const apiUrl = requireOrigin(e.DASHBOARD_API_URL, 'DASHBOARD_API_URL');

  const rawOrigins = String(e.DASHBOARD_ORIGIN || '').split(',')
    .map((s) => s.trim()).filter(Boolean);
  if (!rawOrigins.length) {
    throw new Error('DASHBOARD_ORIGIN is required: it lists the origins allowed to load the '
      + 'dashboard, comma separated (for example https://dashboard.example.com). A dashboard '
      + 'that serves administration pages must not be loadable from anywhere.');
  }
  for (const entry of rawOrigins) {
    if (!validOriginPattern(entry)) {
      throw new Error('DASHBOARD_ORIGIN entry "' + entry + '" is not an http(s) origin. '
        + 'Use a full origin such as https://dashboard.example.com, optionally with a wildcard '
        + 'host such as https://*.example.com.');
    }
  }

  const publicUrl = originOf(e.DASHBOARD_URL);
  if (String(e.DASHBOARD_URL || '').trim() && !publicUrl) {
    throw new Error('DASHBOARD_URL must be an http(s) origin without a path: "'
      + String(e.DASHBOARD_URL).trim() + '"');
  }

  return {
    mode,
    host: String(e.DASHBOARD_HOST || '').trim() || DEFAULT_HOST,
    port: toPort(e.DASHBOARD_PORT, 'DASHBOARD_PORT'),
    apiUrl,
    allowedOrigins: rawOrigins,
    // The dashboard's own public address, when the deployment knows it. It is
    // what the API has to be told to allow, and what the startup diagnostics
    // check.
    publicUrl,
    // The origin this service would be reached at, for the API's allowlist
    // check. The named public address is the one that matters; the first
    // allowed origin is the fallback.
    ownOrigin: publicUrl || rawOrigins[0],
    clientDir: resolveClientDir(e.DASHBOARD_CLIENT_DIR),
    requestTimeoutMs: toTimeoutMs(e.DASHBOARD_REQUEST_TIMEOUT_MS, 'DASHBOARD_REQUEST_TIMEOUT_MS'),
  };
}

// The websocket origin of the API, for the content security policy: the
// client's realtime gateway connects to the API, not to this service.
function apiSocketOrigin(apiUrl) {
  return apiUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

// The content security policy.
//
// The console is the client's own document, so the policy is the one the main
// server uses, with the API's origins added and nothing else: this service
// talks to exactly one API, and it says which.
function buildCsp(config) {
  const connect = ["'self'", config.apiUrl, apiSocketOrigin(config.apiUrl)];
  const img = ["'self'", 'data:', 'blob:', config.apiUrl];
  return [
    "default-src 'self'",
    'connect-src ' + connect.join(' '),
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'img-src ' + img.join(' '),
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The origin policy.
//
// A request that names an origin has to name one this service serves. A
// request that names none is a navigation, a command line call or a health
// probe, and it is answered - but never with a header that would let another
// page read the answer.
function originPolicy(config) {
  return function (req, res, next) {
    const origin = req.headers.origin;
    if (!origin) {
      if (req.method === 'OPTIONS') {
        res.set('Allow', 'GET, HEAD, OPTIONS');
        return res.status(405).json({
          error: { code: 'METHOD_NOT_ALLOWED', message: 'This service answers reads.' },
        });
      }
      return next();
    }
    const allowed = config.allowedOrigins.some((pattern) => originCovers(pattern, origin));
    if (!allowed) {
      return res.status(403).json({
        error: {
          code: FAILURES.originRefused.code,
          message: 'This dashboard is not served to that origin.',
        },
      });
    }
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    return next();
  };
}

// The API's answer, in the shape the dashboard needs. A failure names the
// reason rather than pretending the API answered.
async function callApi(config, endpoint, options) {
  const opts = options || {};
  const headers = { Accept: HEADERS.accept };
  if (opts.token) headers[AUTH.header] = AUTH.format.replace('<token>', opts.token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(config.apiUrl + endpoint.path, {
      method: endpoint.method,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return {
      ok: res.ok,
      status: res.status,
      body,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      latencyMs: Date.now() - startedAt,
      error: error && error.name === 'AbortError'
        ? 'the API did not answer within ' + config.requestTimeoutMs + 'ms'
        : 'the API could not be reached',
    };
  } finally {
    clearTimeout(timer);
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

// The client's entry document, with its base rewritten to where this service
// serves it. The file on disk carries the mount of the deployment it was
// built for, so it is corrected here, per request, the way the main server
// corrects it.
function sendDocument(config, req, res, next) {
  fs.readFile(path.join(config.clientDir, 'index.html'), 'utf8', (err, html) => {
    if (err) {
      if (!res.headersSent) next(err);
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html.replace(/<base href="[^"]*">/i, '<base href="/">'));
  });
}

function isConsoleDocument(pathname) {
  return pathname === ADMIN_PATH || pathname.startsWith(ADMIN_PATH + '/');
}

/**
 * The service's HTTP surface.
 *
 * @param {object} config the configuration from loadConfig
 * @returns {object} the Express application
 */
function createApp(config) {
  const app = express();
  const startedAt = Date.now();
  app.disable('x-powered-by');
  // Proxy trust is narrow on purpose: only a proxy on the loopback interface
  // may supply X-Forwarded-* headers. The main server does the same.
  if (String(process.env.TRUST_PROXY || '').trim() === '1') {
    app.set('trust proxy', 'loopback');
  }

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', buildCsp(config));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(originPolicy(config));

  // The service's own health, and the API's, reported separately. A green
  // dashboard must not hide a dead API, so the two are never merged into one
  // answer: the status code follows the worse of the two, and the body says
  // which one it was.
  app.get('/health', async (req, res) => {
    const api = await callApi(config, ENDPOINTS.health);
    res.status(api.ok ? 200 : 503).json({
      ok: api.ok,
      service: {
        ok: true,
        mode: config.mode,
        contract: CONTRACT_VERSION,
        version: VERSION,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        apiUrl: config.apiUrl,
        dashboardUrl: config.publicUrl,
      },
      api: {
        ok: api.ok,
        url: config.apiUrl,
        status: api.status,
        latencyMs: api.latencyMs,
        instanceId: api.body && api.body.instanceId ? api.body.instanceId : null,
        db: api.body && api.body.db ? api.body.db : null,
        error: api.error,
      },
    });
  });

  // The dashboard's own liveness: this process is up. It says nothing about
  // the API, which is what /health is for.
  app.get('/live', (req, res) => {
    res.json({
      ok: true,
      mode: config.mode,
      contract: CONTRACT_VERSION,
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  // The session check: the caller's token, presented to the API the way the
  // browser presents it, and the API's answer passed back. The dashboard
  // keeps nothing: no session, no account, no copy of the token.
  app.get('/session', async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'A session token is required: send it as "Authorization: Bearer <token>".',
        },
      });
    }
    const result = await callApi(config, ENDPOINTS.session, { token });
    if (result.error) {
      return res.status(502).json({
        ok: false,
        error: { code: FAILURES.apiDown.code, message: result.error },
        api: { url: config.apiUrl, status: result.status },
      });
    }
    if (!result.ok) {
      const code = result.body && result.body.error && result.body.error.code
        ? result.body.error.code
        : 'SESSION_REFUSED';
      return res.status(result.status).json({
        ok: false,
        error: {
          code: FAILURES.sessionRefused.code,
          message: 'the API refused the session (' + code + ')',
        },
        api: { url: config.apiUrl, status: result.status, code },
      });
    }
    return res.json({
      ok: true,
      user: result.body,
      api: { url: config.apiUrl, status: result.status },
    });
  });

  // Where the client finds the API. The client resolves its backend in a
  // fixed order (frontend/packages/config.js) and this file is the one it
  // reads for a dashboard served by this service: the API, never the
  // dashboard's own origin.
  app.get(CLIENT.configFile, (req, res) => {
    res.set('Cache-Control', 'no-store')
      .type('json')
      .send(JSON.stringify({ backendUrl: config.apiUrl }, null, 2) + '\n');
  });

  // The console's document, and the sign-in screens it needs.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = req.path;
    if (!isConsoleDocument(pathname) && !DOCUMENT_PATHS.has(pathname)) return next();
    return sendDocument(config, req, res, next);
  });

  // The phone module is not part of the console, and its own configuration
  // names the hosted network rather than this instance's API.
  app.use((req, res, next) => {
    if (req.path !== MOBILE_PATH && !req.path.startsWith(MOBILE_PATH + '/')) return next();
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'This service serves the admin console, not the phone module.',
      },
    });
  });

  // The client tree. The console is the same client the main process serves;
  // it is not a second copy of the administration screens.
  app.use(express.static(config.clientDir, {
    index: false,
    setHeaders(res, filePath) {
      if (/(^|[\\/])(index\.html|backend\.json)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  // The front door of a dashboard is the console.
  app.get('/', (req, res) => res.redirect(302, ADMIN_PATH));

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'This service serves the admin console at ' + ADMIN_PATH + ' and the client '
          + 'assets beside it. It has no route for ' + req.method + ' ' + req.path + '.',
      },
    });
  });

  return app;
}

/**
 * Start the service.
 *
 * @param {object} config the configuration from loadConfig
 * @returns {Promise<object>} the running service
 */
function startService(config) {
  const app = createApp(config);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      resolve({ app, server, config, port: server.address().port });
    });
  });
}

// Does the API allow this dashboard's origin?
//
// The browser asks the API directly, so the API's own allowlist is what
// decides whether the console works at all. A deployment that forgot to add
// the dashboard's origin sees a CORS error in the browser, which reads as a
// broken network, so it is checked here and named.
async function checkApiOriginPolicy(config) {
  if (!config.ownOrigin) return null;
  try {
    const res = await fetch(config.apiUrl + ENDPOINTS.instance.path, {
      headers: { Origin: config.ownOrigin },
    });
    const allowed = res.headers.get('access-control-allow-origin');
    if (!allowed) {
      console.warn('[warn] the API does not allow the dashboard origin (' + config.ownOrigin
        + '). Add it to CLIENT_ORIGIN on the main instance, or the browser will refuse every '
        + 'answer the console gets.');
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[warn] the API could not be reached for the origin check: '
      + (error && error.message ? error.message : error));
    return null;
  }
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error('[error] the separate dashboard service cannot start: '
      + (error && error.message ? error.message : error));
    process.exit(1);
    return;
  }

  const info = describe({
    mode: config.mode,
    apiUrl: config.apiUrl,
    dashboardUrl: consoleUrlFromOrigin(config.publicUrl),
  });
  report({
    mode: config.mode,
    apiUrl: config.apiUrl,
    dashboardUrl: info.dashboardUrl,
  });
  console.log('[info] dashboard origin policy: ' + config.allowedOrigins.join(', '));
  if (config.publicUrl
    && !config.allowedOrigins.some((pattern) => originCovers(pattern, config.publicUrl))) {
    console.warn('[warn] the dashboard\'s own origin (' + config.publicUrl + ') is not in the '
      + 'origin policy, so requests from it are refused. Add it to DASHBOARD_ORIGIN.');
  }
  console.log('[info] dashboard serves the client from ' + config.clientDir);
  console.log('[info] the dashboard holds no database, runs no background jobs and owns no '
    + 'websocket gateway: every answer it gives comes from the API over HTTP');

  let running;
  try {
    running = await startService(config);
  } catch (error) {
    console.error('[error] the separate dashboard service could not listen on '
      + config.host + ':' + config.port + ': ' + (error && error.message ? error.message : error));
    process.exit(1);
    return;
  }

  const address = running.server.address();
  console.log('[info] separate dashboard listening on http://' + config.host + ':' + address.port);

  await checkApiOriginPolicy(config);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log('[info] shutting the separate dashboard down…');
    if (typeof running.server.closeIdleConnections === 'function') running.server.closeIdleConnections();
    if (typeof running.server.closeAllConnections === 'function') running.server.closeAllConnections();
    running.server.close(() => {
      console.log('[info] shutdown complete');
      process.exit(0);
    });
    const forced = setTimeout(() => process.exit(0), 5000);
    if (forced.unref) forced.unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  require('dotenv').config({
    path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '..', '..', '.env'),
    quiet: true,
  });
  main();
}

module.exports = {
  loadConfig,
  createApp,
  startService,
  callApi,
  checkApiOriginPolicy,
  main,
  DEFAULT_PORT,
  DEFAULT_HOST,
};
