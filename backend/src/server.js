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
const serveClient = require('./serve-client');
const { corsOptions, originCovers, DESKTOP_ORIGIN } = require('./origins');
const inviteRoutes = require('./routes/invites');
const enforcement = require('./services/enforcement');
const pages = require('./services/pages');

const PORT = parseInt(process.env.PORT || '9971', 10);

/**
 * Reduce a configured API location to the origin the client should talk to.
 *
 * Returns '' when the value is not a usable http(s) URL, so a typo does not
 * become a pinned value the client will believe.
 */
function apiOriginOnly(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch {
    return '';
  }
}

// Where the web client is mounted, if anywhere. Declared at module scope because
// both the static handler and the route fallback need it, and the fallback runs
// before the point where it used to be defined - which put it in the temporal
// dead zone and failed startup with "Cannot access before initialization".
// Empty means the client is served from the origin root, which is the ordinary
// self-hosted case.
const APP_MOUNT = (process.env.TRYCORD_APP_MOUNT || '').trim().replace(/\/+$/, '');
// Validated strictly: exactly "express" (direct exposure) or "nginx"
// (reverse-proxy deployment). Anything else is a hard startup error - never
// silently fall back to a different topology, which is how an instance ends up
// bound to a public interface nobody chose.
const HOST_TYPE = String(process.env.SERVER_HOST_TYPE || '').trim().toLowerCase();
if (HOST_TYPE && HOST_TYPE !== 'express' && HOST_TYPE !== 'nginx') {
  throw new Error('Invalid SERVER_HOST_TYPE. Expected "express" or "nginx".');
}
const nginxMode = HOST_TYPE === 'nginx';
// Normal bind: in nginx mode the public listener is nginx, so Express
// binds loopback unless the deployment explicitly requires another interface.
// In express mode keep the existing direct-exposure default. dotenv injects
// HOST from .env, so the per-mode default only applies when HOST is unset.
const HOST = nginxMode ? (process.env.HOST || '127.0.0.1') : (process.env.HOST || '0.0.0.0');
const isLoopbackHost = (h) => h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === 'localhost' || /^127\./.test(h);

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
// Does a configured CLIENT_ORIGIN entry cover a request origin?
//
// Exact string equality is the whole rule, which is why this exists at all:
// the documented configuration has always been
//   CLIENT_ORIGIN=https://trycord.dev,http://*.trycord.dev
// but with `clientOrigins.includes(origin)` the wildcard entry was compared
// LITERALLY, so no subdomain ever matched and CORS was silently broken for
// every self-hosted subdomain. Verified: with that exact value,
// `http://beta.trycord.dev` received no Access-Control-Allow-Origin header.
//
// Only a single leading "*." label is treated as a wildcard, and only for
// http(s). Everything else - including the desktop app's custom scheme, e.g.
// "trycord://app" - is matched exactly, so a non-web origin still has to be
// listed deliberately. A bare "*" is never accepted: it would be equivalent to
// Access-Control-Allow-Origin: *.
async function boot() {
  if (!process.env.JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is required. Each instance must have its own secret — ' +
      'generate one and set it in .env (see .env.example). The official secret is never shared.'
    );
  }
  const inst = instanceConfig();
  console.log('[info] host type: ' + (nginxMode ? 'nginx (reverse proxy in front of :' + PORT + ')' : 'express (direct)'));
  // Mode-specific validation: surface obviously inconsistent topology at
  // boot instead of failing later at request time.
  if (nginxMode) {
    if (inst.publicUrl) {
      try {
        const pub = new URL(inst.publicUrl);
        if (pub.port) {
          console.warn('[warn] nginx mode: TRYCORD_PUBLIC_URL includes a port — the public origin should be the bare site URL (e.g. https://trycord.dev), not an upstream port.');
        }
        if (inst.clientOrigins.length && !inst.clientOrigins.includes(pub.origin)) {
          console.warn('[warn] nginx mode: CLIENT_ORIGIN does not include the public origin (' + pub.origin + ') — CORS may be misconfigured.');
        }
      } catch { /* publicUrl invalid; other paths handle it */ }
    }
    if (process.env.HOST && !isLoopbackHost(process.env.HOST)) {
      console.warn('[warn] nginx mode: HOST=' + process.env.HOST + ' is not a loopback interface. The public listener is nginx — keep Express on 127.0.0.1 unless the deployment explicitly requires another interface.');
    }
    if (String(process.env.TRUST_PROXY || '').trim() !== '1') {
      console.warn('[warn] nginx mode: TRUST_PROXY=1 is not set. Client IPs and HTTPS detection will be wrong behind the proxy. Set it only when a proxy on the same host (nginx) is actually in front of Express.');
    }
  } else if (inst.publicUrl) {
    try {
      const u = new URL(inst.publicUrl);
      if (u.port && String(parseInt(u.port, 10)) !== String(PORT)) {
        console.warn('[warn] express mode: PUBLIC URL port ' + u.port + ' differs from listener port ' + PORT + ' — public links may not reach this listener as configured.');
      }
    } catch { /* publicUrl invalid; other paths handle it */ }
  }

  // The desktop app cannot be inferred the way a browser origin can: it is a
  // custom scheme, so it has to be allowlisted explicitly, and a backend that
  // omits it answers every desktop request with a headerless 200 that the
  // browser reports as an opaque network/CORS error. That is indistinguishable
  // from a dead host at the client, which is why it survives to a bug report
  // instead of being caught here. Say it at boot, once, for every deployment.
  if (inst.clientOrigins.length && !inst.clientOrigins.some((p) => originCovers(p, DESKTOP_ORIGIN))) {
    console.warn(
      '[warn] CLIENT_ORIGIN does not include ' + DESKTOP_ORIGIN + ' — the Trycord desktop app '
      + '(both the installer and the portable build) will NOT be able to reach this backend. '
      + 'Add it, e.g. CLIENT_ORIGIN=' + inst.clientOrigins.join(',') + ',' + DESKTOP_ORIGIN
    );
  }

  await db.connect();
  console.log(`[info] database connected (${db.dialect})`);

  const app = express();
  const server = http.createServer(app);
  // Proxy trust is deliberate and narrow: only a proxy on the loopback
  // interface (nginx on the same host, which fronts Cloudflare in the
  // documented production layout) may supply X-Forwarded-* headers. Arbitrary
  // clients can never spoof their remote address, so rate limiting and
  // HTTPS detection keep using the real client identity. Leave TRUST_PROXY
  // unset unless the deployment actually has such a proxy.
  if (String(process.env.TRUST_PROXY || '').trim() === '1') {
    app.set('trust proxy', 'loopback');
    console.log('[info] TRUST_PROXY=1: trusting X-Forwarded-* from loopback only');
  }
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

  // Security headers. Hardens the app surface without breaking the
  // documented cross-instance feature (the client can be pointed at another
  // API origin at runtime), so CSP connect/src origins are derived from
  // runtime config plus a per-instance allowlist knob (CSP_CONNECT_ORIGINS
  // in .env, comma-separated). The real app page has no inline scripts, so
  // script-src is strict; the static showcase gallery is dev-only and
  // exempted from that one rule.
  // These are scheme-sources and host-sources and are emitted verbatim, so
  // anything that means "this origin" has to carry its own quotes. An unquoted
  // 'self' is not a valid source expression: the browser discards the directive
  // it appears in, which for connect-src means every API call is refused and the
  // application boots signed out with no error to explain it.
  const cspConnect = ["'self'", 'ws:', 'wss:'];
  const cspImg = ["'self'", 'data:', 'blob:'];
  // The API the client talks to, and the one it falls back to. API_URL is the
  // deployment's own name for that primary; TRYCORD_API_URL is the older name
  // and still wins if set, so an existing deployment keeps its behaviour.
  const apiOrigin = ((process.env.TRYCORD_API_URL || process.env.API_URL || '').trim() || inst.publicUrl || '');
  const apiBackup = (process.env.API_BACKUP_URL || '').trim();
  const addCspOrigin = (o) => {
    try { const origin = new URL(o).origin; cspConnect.push(origin, origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')); cspImg.push(origin); } catch { /* ignore unparseable */ }
  };
  // Reduce a candidate to a bare origin string (scheme + host + port) or
  // null. Origins cannot carry spaces, quotes, or semicolons, so the
  // result is always safe to interpolate into the CSP header.
  const cspOriginOf = (o) => {
    try {
      const u = new URL(String(o || '').trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch { return null; }
  };
  const wsOriginOf = (origin) => origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  // The backup has to be allowed here as well as the primary. A failover the
  // policy then refuses presents as an empty application rather than as a
  // switch, which is the same symptom as having no failover at all.
  [apiOrigin, apiBackup, inst.publicUrl, inst.globalUrl].forEach((o) => o && addCspOrigin(o));
  ['http://localhost:9971', 'http://127.0.0.1:9971', 'https://trycord.dev'].forEach(addCspOrigin);
  String(process.env.CSP_CONNECT_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).forEach(addCspOrigin);
  // The scheme and host a request arrived on, or null when it did not arrive
  // over http(s). Behind a proxy the host header is the one the browser used,
  // which is the one we want: it is the origin the client is really talking to.
  function originOf(req) {
    const host = req.headers && req.headers.host;
    if (!host || !/^[^\s/]+$/.test(String(host))) return null;
    const proto = String((req.headers['x-forwarded-proto'] || '').split(',')[0]).trim()
      || (req.protocol === 'https:' ? 'https' : 'http');
    if (proto !== 'http' && proto !== 'https') return null;
    return proto + '://' + host;
  }

  // The served client's own static pin (backend.json) is part of the
  // centralized backend configuration: allow it once the client directory
  // is located below. Self-hosters need no edit at all - see the /backend.json
  // handler below, which repoints that file at whichever instance is serving it.
  function allowClientStaticBackend(clientDir) {
    if (!clientDir) return;
    try {
      const raw = fs.readFileSync(path.join(clientDir, 'backend.json'), 'utf8');
      const pinned = cspOriginOf(JSON.parse(raw).backendUrl);
      if (pinned) addCspOrigin(pinned);
    } catch { /* missing/unparseable file means "no static pin" */ }
  }
  const buildCsp = (allowInlineScripts, extraOrigins) => {
    const connect = [...new Set([...cspConnect, ...(extraOrigins || [])])];
    return [
      "default-src 'self'",
      `connect-src ${connect.join(' ')}`,
      allowInlineScripts ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src ${[...new Set(cspImg)].join(' ')}`,
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
  };
  app.use((req, res, next) => {
    // The client's top-precedence backend travels in ?api= (desktop exe,
    // bookmarks, backend-selector reloads). Reflect that configured origin
    // — and only that origin — into connect-src so the served page may
    // reach exactly the backend it was told to use. Anything else still
    // requires the allowlist above (TRYCORD_API_URL, backend.json,
    // CSP_CONNECT_ORIGINS, localhost, trycord.dev).
    const extra = [];
    const apiParam = cspOriginOf(req.query && req.query.api);
    if (apiParam) extra.push(apiParam, wsOriginOf(apiParam));
    res.setHeader('Content-Security-Policy', req.path.indexOf('showcase') !== -1 ? buildCsp(true, extra) : buildCsp(false, extra));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
  });

  // Attachments are never mounted as a public static directory, whether they
  // live on local disk or in an object store: every read goes through the
  // authenticated /api/attachments/:id route (see routes/attachments.js).
  // Resolve the driver now so a bad STORAGE_DRIVER or a missing S3 credential
  // stops the server at boot instead of failing on someone's first upload.
  const storageDriver = require('./services/storage').init();
  console.log('[info] storage driver: ' + storageDriver.name);

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
    const mail = require('./auth/mail');
    res.json({
      instanceId: inst.instanceId,
      name: inst.name,
      globalSync: inst.globalUrl !== '',
      features: { publicDiscovery: true, uploads: true, email: mail.mode() === 'smtp' && !!process.env.SMTP_HOST },
    });
  });

  // Runtime client configuration for browsers served by this server.
  // Only safe public keys; TRYCORD_API_URL wins, else the public URL (if set).
  // Lets a deployment pin the API origin without editing client files.
  app.get('/runtime-config.js', (req, res) => {
    const cfg = {};
    const configured = (process.env.TRYCORD_API_URL || process.env.API_URL || '').trim() || inst.publicUrl;
    // The client treats this as an origin and appends /api/... to every request
    // itself, so a value carrying the path produces /api/api/users/me - a 404 the
    // client reads as "not signed in", which signs the reader out and looks like
    // a session problem rather than a configuration one. Operators reasonably
    // write the API path here, so it is dropped rather than obeyed.
    const apiUrl = apiOriginOnly(configured);
    if (apiUrl) cfg.API_URL = apiUrl;
    // Shipped so a browser that has no backend.json still knows where the backup
    // is. The client only ever moves to it after the primary fails to answer,
    // and it says so in the interface when it does.
    if (apiBackup) cfg.API_BACKUP_URL = apiBackup;
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
  // Scoped community extensions: webhooks, bot applications, analytics. Mounted
  // under the same prefix as the community routes so they inherit the one
  // access chain rather than introducing a second.
  app.use('/api/servers/:serverId', require('./routes/integrations'));
  app.use('/api/invites', inviteRoutes.byCode);
  app.use('/api/discover', require('./routes/discover'));
  app.use('/api/activity', require('./routes/activity'));
  app.use('/api/dms', require('./routes/dms'));
  // Token-authenticated, not session-authenticated - see the file's header.
  app.use('/api/bot', require('./routes/bot'));
  app.use('/api/friends', require('./routes/friends'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/search', require('./routes/search'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/appeals', require('./routes/appeals'));
  app.use('/api/account', require('./routes/accountDeletion'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/admin/pages', require('./routes/adminPages'));
  // Test hooks for automated suites (email verification without an inbox).
  // Strictly opt-in: unmounted in every other boot, where the paths 404.
  if (process.env.ALLOW_TEST_HOOKS === 'true') {
    app.use('/api/test', require('./routes/test'));
    console.warn('[warn] ALLOW_TEST_HOOKS is enabled — test endpoints are mounted (never do this in production)');
  }

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

  const clientDir = serveClient.mountClient(app, {
    serverDir: __dirname,
    appMount: APP_MOUNT,
    originOf,
    cspOriginOf,
    allowClientStaticBackend,
  });


  const publicDir = serveClient.mountPublicSite(app, {
    serverDir: __dirname,
    clientDir,
    pages,
  });


  const { broadcast, broadcastDm, sendToUser, isOnline, getPresence, issueTicket, disconnectUser, broadcastServer, evictUserFromServer } = createGateway(server);
  require('./routes/auth').setTicketIssuer(issueTicket);
  require('./routes/auth').setGateway({ disconnectUser });
  require('./routes/messages').setGateway({ broadcast, sendToUser });
  require('./routes/channels').setGateway({ broadcast });
  // Account-scoped settings that did not previously have a home: privacy
  // preferences, blocking, notification preferences and wellbeing. One mount so
  // the Privacy and Notification summaries load in a single round trip.
  app.use('/api/me', require('./routes/privacy'));
  app.use('/api/me', require('./routes/export'));
  app.use('/api/mutes', require('./routes/mutes'));
  // Instance-wide announcement banners (per-deployment, not global).
  app.use('/api/announcements', require('./routes/announcements'));
  require('./routes/dms').setGateway({ broadcastDm, sendToUser, isOnline });
  require('./routes/friends').setGateway({ sendToUser });
  require('./routes/users').setGateway({ getPresence });
  require('./routes/admin').setGateway({ disconnectUser });
  require('./services/events').setGateway({
    broadcast: broadcastServer, broadcastChannel: broadcast,
    sendToUser, evict: evictUserFromServer,
  });

  // Trust & Safety: bootstrap platform admins from ADMIN_USERNAMES before
  // the server accepts traffic. Idempotent — re-runs promote any new names
  // and leave existing admins untouched.
  const bootstrapAdmins = (async () => {
    const names = String(process.env.ADMIN_USERNAMES || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) {
      console.log('[info] ADMIN_USERNAMES not set — no platform admins bootstrapped');
      return;
    }
    for (const username of names) {
      // Case-insensitive: usernames preserve case, operators do not.
      const u = await db.get('SELECT * FROM users WHERE lower(username) = lower(?)', [username]);
      if (!u) { console.warn(`[warn] ADMIN_USERNAMES: no user "${username}" yet — it will be promoted automatically at registration/login`); continue; }
      await enforcement.ensureAdminUser(u.id);
      console.log(`[info] platform admin: ${username}`);
    }
  })();
  await bootstrapAdmins;

  // The first path segment of every application route. The shell is served for
  // these and nothing else, so an instance that also publishes a website keeps
  // its own clean URLs - those routes are mounted earlier and win.
  //
  // 'support' is deliberately absent: the public site owns /support, and since
  // its handler is registered first it takes the path regardless of what is
  // listed here. Claiming it would have been a lie. The in-app support view is
  // reached by navigation, which never asks the server for the document.
  // The mount this instance serves the application from, derived from the
  // request rather than configured. A deployment that serves the app from the
  // origin root has no mount; one that serves it from /app claims the first
  // segment only when it is not itself an application route. Returns '' when
  // there is no mount, '' meaning "the base is the origin root".
  function appMount(reqPath) {
    if (APP_MOUNT) {
      const seg = reqPath.split('/').filter(Boolean)[0] || '';
      return seg === APP_MOUNT.replace(/^\//, '') ? APP_MOUNT : '';
    }
    return '';
  }

  // The application claims a prefix when a deep link on it has to survive a
  // refresh. Anything not listed is a document belonging to the public site and
  // falls through to it.
  //
  // 'support' is an application route: the router serves it and it renders inside
  // the shell. It was left out on the reasoning that the in-app support view is
  // only reached by navigation, which is true of the view and not of the URLs
  // pointing at it - so a bookmarked /support was a 404.
  //
  serveClient.mountSpaFallback(app, {
    clientDir,
    publicDir,
    appMount: APP_MOUNT,
    mountOf: appMount,
  });


  // An unmatched /api path is an API 404, and it answers in the same envelope
  // as every other API error. Without this it reached Express's default handler
  // and returned an HTML page: a client with a mistyped path got a document it
  // cannot parse, in a response with an HTML content type, from an API that
  // otherwise never does that. It also matters for the static shell, where a
  // JSON body is the only thing that tells a reader the request was an API call
  // that does not exist rather than a page that does.
  app.use('/api', (req, res, next) => {
    if (res.headersSent) return next();
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `no API route for ${req.method} ${req.path}`,
      },
    });
  });

  // Consistent error envelope for anything that escapes routes.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err && (err.statusCode || err.status)) || 500;
    // Client-side problems surface as proper 4xx (body-parser rejects with
    // 413/400 for oversized or malformed JSON). Everything else stays a
    // generic 500 — never stack traces, queries, or internals.
    if (status >= 400 && status < 500) {
      const code = err && err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE'
        : err && err.type === 'entity.parse.failed' ? 'BAD_JSON'
        : 'BAD_REQUEST';
      const message = status === 413 ? 'request body too large'
        : status === 400 ? 'malformed request body'
        : 'bad request';
      console.warn('[warn] request rejected ' + status + ' (' + message + ')');
      return res.status(status).json({ error: { code, message } });
    }
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
      // Link previews for messages posted before embeds existed. Bounded per
      // pass, so the first run on a large history cannot turn into one very
      // long request; the next pass picks up where it stopped.
      const embeds = require('./services/embeds');
      await embeds.backfill(25);
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
