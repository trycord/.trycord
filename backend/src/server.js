// Trycord server (optional self-hosting backend): resource API + WebSocket
// gateway + static web client.
// Run:  copy .env.example to .env, configure, then npm install && npm start.
//
// Boot: validate env -> connect database -> apply schema -> listen.
//   HTTP -> route (validate + authorize) -> service -> database
//
// The environment file is `.env` next to this one by default. DOTENV_CONFIG_PATH
// moves it, which is what a deployment that keeps its configuration somewhere
// else wants, and what a verification run uses to be sure it is measuring the
// instance it started rather than the one the machine happens to be serving.
require('dotenv').config(process.env.DOTENV_CONFIG_PATH
  ? { path: process.env.DOTENV_CONFIG_PATH, quiet: true }
  : { quiet: true });
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
const features = require('./features');
const settings = require('./services/settings');
const jobs = require('./services/jobs');
const continuum = require('./services/continuum');
const retention = require('./services/retention');
const searchIndex = require('./services/search-index');
const { VERSION, API_VERSION, PROTOCOL_VERSION } = require('./version');

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

// What a first start falls back to, before the configuration centre has been read.
//
// The listener and the mount are not decided here. They are decided after the
// store loads, because they are settings like any other - an administrator changes
// them in the dashboard, and the change takes effect at the next start. These are
// the environment's seed values, which is what the dashboard shows before anything
// is saved and what an instance with no saved value uses.
const ENV_PORT = parseInt(process.env.PORT || '9971', 10);
const ENV_APP_MOUNT = (process.env.TRYCORD_APP_MOUNT || '').trim().replace(/\/+$/, '');
const ENV_HOST_TYPE = String(process.env.SERVER_HOST_TYPE || '').trim().toLowerCase();
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
// Tells an operator the guided setup exists, if they asked to be told.
//
// Off by default: a fresh install that logs a wall of notices at you is not
// helpful, and an operator who has already configured everything does not need
// to be offered a wizard. With it on, one line at boot pointing at where to run
// it is the whole feature.
function announceQuickSetup(mount) {
  const settings = require('./services/settings');
  if (!settings.get('instance.quickSetup')) return;
  const essentials = require('./services/quick-setup').essentials();
  const todo = essentials.filter((e) => !e.done);
  if (!todo.length) {
    console.log('[quick setup] nothing to do. Every essential setting is already set.');
    return;
  }
  console.log('[quick setup] ' + todo.length + ' setting(s) still need a value:');
  todo.forEach((e) => console.log('             ' + e.label + ' (' + e.key + ')'));
  console.log('             run it at ' + quickSetupUrl(mount));
}

// Where the setup lives. The app is mounted under a prefix on some deployments,
// so the link has to be the mounted one rather than a hardcoded path.
function quickSetupUrl(mount) {
  const base = (process.env.TRYCORD_PUBLIC_URL || '').replace(/\/+$/, '');
  return base + (mount || '') + '/admin/settings';
}

// The listener and the mount, read after the configuration centre so a value saved
// in the dashboard is the one in force. The environment seeds them, which is what
// an instance with nothing saved uses and what the dashboard shows as the starting
// point. All three are restart-required: a process cannot rebind a listening socket
// or move its own asset paths while it is running.
function resolveListenSettings() {
  const loaded = settings.isLoaded();
  const port = settings.isLoaded() ? settings.get('server.port') : ENV_PORT;
  const hostType = String((settings.isLoaded() ? settings.get('server.hostType') : ENV_HOST_TYPE) || '').trim().toLowerCase();
  if (hostType && hostType !== 'express' && hostType !== 'nginx') {
    throw new Error('Invalid host type "' + hostType + '". Expected "express" or "nginx".');
  }
  const nginx = hostType === 'nginx';
  const savedHost = String((settings.isLoaded() ? settings.get('server.host') : '') || '').trim();
  // In nginx mode the public listener is nginx, so Express binds loopback unless
  // the deployment explicitly requires another interface. In express mode the
  // server is the public listener, so it binds every interface by default.
  const host = savedHost || (nginx ? '127.0.0.1' : '0.0.0.0');
  const mount = String((settings.isLoaded() ? settings.get('app.mount') : ENV_APP_MOUNT) || '')
    .trim().replace(/\/+$/, '');
  return { port, host, hostType, nginx, mount };
}

// Say the topology at boot, once. Reads the resolved listener rather than the
// environment, so it describes the configuration actually in force.
function reportListen(listen, inst) {
  console.log('[info] host type: ' + (listen.nginx
    ? 'nginx (reverse proxy in front of :' + listen.port + ')'
    : 'express (direct)'));
  if (listen.nginx) {
    if (inst.publicUrl) {
      try {
        const pub = new URL(inst.publicUrl);
        if (pub.port) {
          console.warn('[warn] nginx mode: TRYCORD_PUBLIC_URL includes a port. The public origin should be the bare site URL (e.g. https://trycord.dev), not an upstream port.');
        }
        if (inst.clientOrigins.length && !inst.clientOrigins.includes(pub.origin)) {
          console.warn('[warn] nginx mode: CLIENT_ORIGIN does not include the public origin (' + pub.origin + '), so CORS may be misconfigured.');
        }
      } catch { /* publicUrl invalid; other paths handle it */ }
    }
    if (listen.host && !isLoopbackHost(listen.host)) {
      console.warn('[warn] nginx mode: the bind address ' + listen.host + ' is not loopback. The public listener is nginx, so keep Trycord on 127.0.0.1 unless the deployment explicitly requires another interface.');
    }
    if (String(process.env.TRUST_PROXY || '').trim() !== '1') {
      console.warn('[warn] nginx mode: TRUST_PROXY=1 is not set. Client IPs and HTTPS detection will be wrong behind the proxy. Set it only when a proxy on the same host (nginx) is actually in front of Express.');
    }
  } else if (inst.publicUrl) {
    try {
      const u = new URL(inst.publicUrl);
      if (u.port && String(parseInt(u.port, 10)) !== String(listen.port)) {
        console.warn('[warn] express mode: the public URL port ' + u.port + ' differs from the listening port ' + listen.port + ', so public links may not reach this listener as configured.');
      }
    } catch { /* publicUrl invalid; other paths handle it */ }
  }
}

async function boot(options = {}) {
  // The signing secret is the one value that cannot come from the configuration
  // store: it is the key the store's encrypted values are derived from. An
  // instance that has none gets one generated on the spot and kept, so nobody
  // has to invent one before they can start. A deployment that sets JWT_SECRET
  // keeps using that.
  const { secret, secretOrigin, secretFilePath } = require('./clock');
  const secretFrom = secretOrigin();
  secret();
  console.log(secretFrom === 'environment'
    ? '[info] signing secret: JWT_SECRET'
    : '[info] signing secret: ' + secretFilePath());
  const inst = instanceConfig();

  // The dashboard mode is resolved before anything else is opened, because an
  // unusable value has to stop the boot rather than be discovered on the first
  // request. The mode is a deployment fact: the separate dashboard service has
  // no database of its own, so it cannot read a stored value, and the two
  // processes must not be able to disagree about which one is in force.
  require('./dashboard/mode').currentMode();

  // The desktop app cannot be inferred the way a browser origin can: it is a
  // custom scheme, so it has to be allowlisted explicitly, and a backend that
  // omits it answers every desktop request with a headerless 200 that the
  // browser reports as an opaque network/CORS error. That is indistinguishable
  // from a dead host at the client, which is why it survives to a bug report
  // instead of being caught here. Say it at boot, once, for every deployment.
  if (inst.clientOrigins.length && !inst.clientOrigins.some((p) => originCovers(p, DESKTOP_ORIGIN))) {
    console.warn(
      '[warn] CLIENT_ORIGIN does not include ' + DESKTOP_ORIGIN + '. The Trycord desktop app '
      + '(both the installer and the portable build) will NOT be able to reach this backend. '
      + 'Add it, e.g. CLIENT_ORIGIN=' + inst.clientOrigins.join(',') + ',' + DESKTOP_ORIGIN
    );
  }

  await db.connect();
  console.log(`[info] database connected (${db.dialect})`);

  // The configuration centre is read before the feature flags are validated, because a
  // flag's value comes from the store when the store has one: the precedence is
  // default < database < environment, and reading the environment first would let a
  // saved dashboard value be ignored.
  await settings.load();
  // Reload, not load: features.current can have been built already by a module
  // that reached for it while the store was still loading, and that build would
  // answer from the environment for every catalogue-backed flag. Rebuilding
  // here re-reads every flag with the store in charge, which is the precedence
  // the whole configuration system promises.
  features.reload();
  // The federation identity is prepared unconditionally, not only when
  // Continuum is enabled: an administrator can switch federation on from the
  // console at runtime, and the process must already have a stable signing key
  // to trust or to be trusted. With a persisted key this is a read, not a
  // regeneration.
  continuum.setInstanceId(inst.instanceId);
  await continuum.loadPersistedKeys();
  // Resolved after the store, because the listener and the mount are settings: an
  // administrator changes them in the dashboard and the change takes effect at the
  // next start. This is where a saved value replaces the environment's seed.
  const listen = resolveListenSettings();
  // A caller that started the process deliberately - a verification instance on
  // an ephemeral port, a second instance on the same host - may say which port
  // to bind. The saved setting is the operator's choice and wins over nothing;
  // this override is above it because it comes from the person who started the
  // process, and it exists so two instances can run side by side without
  // editing a file.
  if (options.port) listen.port = Number(options.port);
  if (options.host) listen.host = String(options.host);
  reportListen(listen, inst);
  announceQuickSetup(listen.mount);

  const app = express();
  const server = http.createServer(app);
  // The dashboard's deployment mode. In bundled mode this only reports the
  // mode; in separate mode it also stops this process serving the console's
  // document, and points that address at the dashboard service instead.
  require('./dashboard/mount').mountDashboard(app, {
    appMount: listen.mount,
    dashboardOrigin: String(process.env.DASHBOARD_URL || '').trim(),
  });
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
  // The backup has to be allowed here as well as the primary. A failover the
  // policy then refuses presents as an empty application rather than as a
  // switch, which is the same symptom as having no failover at all.
  [apiOrigin, apiBackup, inst.publicUrl, inst.globalUrl].forEach((o) => o && addCspOrigin(o));
  // The two loopback origins, because an operator developing against this instance reaches
  // it from there. Nothing else is here by default.
  //
  // https://trycord.dev used to be in this list, which meant every self-hosted instance
  // shipped a Content-Security-Policy naming the official network - a client served from
  // somebody's own server was permitted to send its traffic to it. Self-hosting is a
  // property of the architecture, so an origin that has nothing to do with the operator's
  // instance does not belong in the operator's policy. If they do want it, they set
  // CSP_CONNECT_ORIGINS, which is what that setting is for.
  ['http://localhost:9971', 'http://127.0.0.1:9971'].forEach(addCspOrigin);
  String(process.env.CSP_CONNECT_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).forEach(addCspOrigin);
  // The scheme and host a request arrived on, or null when it did not arrive
  // over http(s). Behind a proxy the host header is the one the browser used,
  // which is the one we want: it is the origin the client is really talking to.
  function originOf(req) {
    const host = req.headers && req.headers.host;
    if (!host || !/^[^\s/]+$/.test(String(host))) return null;
    // req.protocol already honours X-Forwarded-Proto when - and only when - Express
    // is told to trust the proxy (TRUST_PROXY=1, loopback only). Reading the header
    // directly here skipped that gate, so a plain http caller could send
    // X-Forwarded-Proto: https and have backend.json hand the client an https origin.
    const proto = req.protocol === 'https' ? 'https' : 'http';
    return proto + '://' + host;
  }

  const buildCsp = (allowInlineScripts) => {
    const connect = [...new Set(cspConnect)];
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
    // The policy is built from configured origins and nothing else - never from
    // request input. The client can be pointed at another API origin at runtime
    // through backend.json or the settings selector, both of which the operator
    // controls, but a query parameter must not be able to authorize one: an
    // attacker link carrying ?api=<their origin> would otherwise be granted the
    // exact connect-src allowance it needs to receive the reader's bearer-carrying
    // requests, which is the policy defeating the thing it exists for. An origin
    // the operator has not configured stays refused by the browser.
    res.setHeader('Content-Security-Policy', req.path.indexOf('showcase') !== -1 ? buildCsp(true) : buildCsp(false));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Only over TLS: browsers ignore the header on a plain-http response, and keying
    // it off the request's own scheme keeps it correct behind a terminating proxy.
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
      res.json({
        ok: true, db: 'ok', instanceId: inst.instanceId, client: !!clientDir,
        version: VERSION,
      });
    } catch {
      res.status(503).json({
        ok: false, db: 'unreachable', instanceId: inst.instanceId, client: !!clientDir,
        version: VERSION,
      });
    }
  });

  // Safe public instance metadata. Never secrets, paths, or credentials.
  //
  // The name, description and support link come from the configuration centre so a
  // change in the dashboard is what the public site and the sign-in screen read.
  app.get('/api/instance', (req, res) => {
    const mail = require('./auth/mail');
    const s = require('./services/settings');
    const features = require('./features');
    res.json({
      instanceId: inst.instanceId,
      // The build this server is running. The client's Updates page reads it,
      // and it comes from the one place the version is written down: the
      // package manifest, read through src/version.js.
      version: VERSION,
      name: s.isLoaded() ? s.get('instance.name') : inst.name,
      description: s.isLoaded() ? s.get('instance.description') : '',
      supportUrl: s.isLoaded() ? s.get('instance.supportUrl') : '',
      backendRole: s.isLoaded() ? s.get('instance.backendRole') : 'primary',
      globalSync: inst.globalUrl !== '',
      // The version a client checks before it commits to this instance. A client
      // that speaks an older protocol is told so here rather than discovering it
      // through a confusing failure later.
      apiVersion: API_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      // What a reader is allowed to do here, and nothing more. These are the
      // capabilities a registration screen needs; they expose no operator
      // configuration, no internal address and no secret.
      registration: {
        enabled: !!features.current.registration,
        approvalRequired: !!features.current.registrationApproval,
        emailVerificationRequired: !!features.current.emailVerificationRequired,
      },
      features: {
        publicDiscovery: features.current.communityDiscovery,
        uploads: features.current.uploads,
        email: mail.mode() === 'smtp',
      },
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
  app.use('/api/servers/:serverId/communityMemory', require('./routes/communityMemory'));
  app.use('/api/channels/:channelId/messages', require('./routes/messages'));
  // Forums. A forum is a channel of type 'forum': its root messages are
  // topics, its replies are the discussion under each, and the thread model
  // is the thread model. Mounted under the channel prefix so it shares the
  // one access chain.
  app.use('/api/channels/:channelId', require('./routes/forums'));
  app.use('/api', require('./routes/attachments'));
  app.use('/api/servers', require('./routes/servers'));
  // Scoped community extensions: webhooks, bot applications, analytics. Mounted
  // under the same prefix as the community routes so they inherit the one
  // access chain rather than introducing a second.
  app.use('/api/servers/:serverId', require('./routes/integrations'));
  // The collaboration workspace: spaces, community documents, boards, events
  // and polls. Mounted under the community prefix so it shares the one access
  // chain - resolveServer, requireMember, requirePerm - rather than inventing
  // a second notion of who may see what.
  app.use('/api/servers/:serverId', require('./routes/workspace'));
  app.use('/api/invites', inviteRoutes.byCode);
  app.use('/api/discover', require('./routes/discover'));
  // The public instance listing. Separate from community discovery: this one
  // is about instances, not about the communities inside one.
  app.use('/api/discovery', require('./routes/discovery'));
  app.use('/api/activity', require('./routes/activity'));
  app.use('/api/dms', require('./routes/dms'));
  // The versioned developer surface: /api/v1. A contracted subset, generated
  // from the same definitions the OpenAPI document is generated from, so a
  // route cannot exist without being documented. The unversioned routes
  // underneath are untouched - a client written against them keeps working.
  app.use('/api/v1', require('./routes/developer'));
  app.use('/api/extensions', require('./routes/extensions'));
  // End-to-end encryption: devices, prekey bundles, sessions, conversation
  // keys, encrypted attachments and recovery. Mounted with the other API
  // routes so it shares the one authentication chain; every route in it is
  // authenticated and rate limited.
  app.use('/api/e2ee', require('./routes/e2ee'));
  // Token-authenticated, not session-authenticated - see the file's header.
  app.use('/api/bot', require('./routes/bot'));
  app.use('/api/friends', require('./routes/friends'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/search', require('./routes/search'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/appeals', require('./routes/appeals'));
  app.use('/api/account', require('./routes/accountDeletion'));
  app.use('/api/admin', require('./routes/admin'));
  // The provider catalogue: what each subsystem can be configured to use, which
  // one is in force, and why the others are not. The console renders this and
  // nothing else, so a provider cannot be offered that a service would refuse.
  app.use('/api/admin/providers', require('./routes/providers'));
  app.use('/api/admin/pages', require('./routes/adminPages'));
  app.use('/api/admin/settings', require('./routes/settings'));
  app.use('/api/admin/database', require('./routes/database'));
  app.use('/api/admin/diagnostics', require('./routes/diagnostics'));
  app.use('/api/admin/mail', require('./routes/mail'));
  app.use(require('./routes/continuum'));
  // Test hooks for automated suites (email verification without an inbox).
  // Strictly opt-in: unmounted in every other boot, where the paths 404.
  if (process.env.ALLOW_TEST_HOOKS === 'true') {
    app.use('/api/test', require('./routes/test'));
    console.warn('[warn] ALLOW_TEST_HOOKS is enabled: test endpoints are mounted (never do this in production)');
  }

  // Back-compat alias for older clients.
  app.get('/api/me', require('./middleware/auth'), async (req, res, next) => {
    try {
      const row = await db.get(
        'SELECT id, username, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?',
        [req.user.id]
      );
      if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
      res.json(row);
    } catch (e) { next(e); }
  });

  // The public website owns the origin root, so it is mounted first: Express is
  // first-match-wins, and the client's own "/" would otherwise answer and the
  // landing page would be unreachable. "Open the app" goes to /app/, which is where
  // the client is served from.
  //
  // clientDir is not known yet here and the public site does not need it: it falls
  // back to its own directory for the favicon.
  //
  // A caller that asked for no public site gets an origin root that the client
  // answers, which is the shape an API-only instance wants.
  const publicDir = options.publicSite === false ? null : serveClient.mountPublicSite(app, {
    serverDir: __dirname,
    clientDir: null,
    pages,
    originOf,
  });

  const clientDir = options.client === false ? null : serveClient.mountClient(app, {
    serverDir: __dirname,
    appMount: listen.mount,
    originOf,
    cspOriginOf,
  });


  const { broadcast, broadcastDm, sendToUser, isOnline, getPresence, issueTicket, disconnectUser, broadcastServer, evictUserFromServer } = createGateway(server);
  require('./routes/auth').setTicketIssuer(issueTicket);
  require('./routes/auth').setGateway({ disconnectUser });
  // Voice mesh (in-house, peer-to-peer real-time) uses the realtime gateway to
  // relay SDP offers/answers and ICE candidates directly between peers.
  global.voiceRelayBridge = { sendToUser };
  require('./routes/messages').setGateway({ broadcast, sendToUser });
  require('./routes/channels').setGateway({ broadcast });
  // Account-scoped settings that did not previously have a home: privacy
  // preferences, blocking, notification preferences and wellbeing. One mount so
  // the Privacy and Notification summaries load in a single round trip.
  app.use('/api/me', require('./routes/privacy'));
  app.use('/api/me', require('./routes/export'));
  // The devices this instance may reach a reader on. Mounted under /api/me
  // because a device registration belongs to the account that made it.
  app.use('/api/me/push-devices', require('./routes/push'));
  app.use('/api/mutes', require('./routes/mutes'));
  app.use('/api/voice', require('./routes/voice'));
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
  // the server accepts traffic. Idempotent, so re-runs promote any new names
  // and leave existing admins untouched.
  const bootstrapAdmins = (async () => {
    const names = String(process.env.ADMIN_USERNAMES || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) {
      console.log('[info] ADMIN_USERNAMES not set, so no platform admins bootstrapped');
      return;
    }
    for (const username of names) {
      // Case-insensitive: usernames preserve case, operators do not.
      const u = await db.get('SELECT * FROM users WHERE lower(username) = lower(?)', [username]);
      if (!u) { console.warn(`[warn] ADMIN_USERNAMES: no user "${username}" yet. It will be promoted automatically at registration/login`); continue; }
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
    if (listen.mount) {
      const seg = reqPath.split('/').filter(Boolean)[0] || '';
      return seg === listen.mount.replace(/^\//, '') ? listen.mount : '';
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
    appMount: listen.mount,
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
        message: `No API route for ${req.method} ${req.path}`,
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
    // generic 500, never stack traces, queries, or internals.
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
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  // Drop expired token revocations (uses JS time, portable across databases).
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

  // Durable background jobs: bounded workers claim due jobs from the database,
  // retry with backoff, and never lose work on restart or crash.
  //
  // A caller that asked for no jobs gets none. The system is a background
  // service with its own lifecycle, and a verification instance that starts one
  // on every test file is a host running a dozen processes to prove that a
  // request handler works.
  if (options.jobs !== false) {
    jobs.register('continuum_deliver', continuum.deliverEvent, {
      concurrency: 4,
      maxAttempts: 5,
      backoffMs: 1000,
    });
    jobs.register('continuum_inbound_process', continuum.processInboundEvent, {
      concurrency: 2,
      maxAttempts: 3,
      backoffMs: 1000,
    });
    // Housekeeping: expired sessions, revoked tokens, old notifications and
    // finished job rows. The first pass is queued at boot and each pass queues
    // the next, so the rhythm survives a restart.
    jobs.register('retention', retention.scheduled, {
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: 60000,
    });
    // The search index, filled in for the messages that were written before it
    // existed. Each pass takes another slice and queues the next, so a large
    // backlog is worked through without one enormous transaction.
    jobs.register('search_backfill', searchIndex.backfillJob, {
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: 60000,
    });
    // Collaboration workspace: an event's reminder, and a card's due date.
    // The services enqueue these into the jobs table, so the rows are durable
    // whether or not a worker is running - but without a handler the claim
    // fails, and a reminder that never arrives is worse than one that is late.
    jobs.register('workspace_event_reminder',
      require('./services/workspace/events').reminderJob, {
        concurrency: 2,
        maxAttempts: 3,
        backoffMs: 60000,
      });
    jobs.register('workspace_card_due_reminder',
      require('./services/workspace/boards').dueReminderJob, {
        concurrency: 2,
        maxAttempts: 3,
        backoffMs: 60000,
      });
    // The workflow scheduler. A tick runs the schedules that are due and
    // queues the next one, so a schedule survives a restart and two instances
    // cannot both run it: the run key's unique index makes the second one
    // resolve to the run that already happened rather than repeating it.
    const schedule = require('./services/workflows/schedule');
    jobs.register('workflow.schedule', schedule.handleScheduleTick, {
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: 60000,
    });
    schedule.startScheduler();
    await jobs.start();
    await jobs.enqueue('retention', {}, { runAfterMs: 15000, maxAttempts: 3 }).catch(() => {});
    await jobs.enqueue('search_backfill', {}, { runAfterMs: 20000, maxAttempts: 3 }).catch(() => {});
  }

  // The sockets, the presence map and the rate-limit counters live in this
  // process. A second copy of the API would have its own copy of each, and a
  // message written by one would not reach a reader connected to the other.
  // The deployment runs one API process, with a standby for failover rather
  // than a second worker; this says so out loud, because a supervisor that
  // scales the process count by accident would otherwise look fine until a
  // message went missing.
  if (process.env.NODE_APP_INSTANCE !== undefined || process.env.PM2_INSTANCE_ID !== undefined) {
    console.log('[info] running under a process supervisor as one instance of this application.');
    console.log('[info] sockets, presence and rate limits belong to this process. Run one API process;');
    console.log('[info] a standby for failover is a separate deployment, not a second worker here.');
  }

  // The WebSocket gateway shares this HTTP server: same bind address, no second port.
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(listen.port, listen.host, () => {
      console.log(`Trycord server "${inst.instanceId}" listening on http://${listen.host}:${listen.port}`);
      if (inst.publicUrl) {
        console.log(`Web client available at ${inst.publicUrl}`);
      } else {
        const displayHost = listen.host === '0.0.0.0' ? 'localhost' : listen.host;
        console.log(`Web client available at http://${displayHost}:${listen.port}`);
      }
      resolve();
    });
  });

  // A way to shut the instance down that a caller owns.
  //
  // The process-level shutdown at the bottom of this file handles SIGTERM. A
  // caller that started the instance itself - a verification run, an operator
  // script that wants the port back - needs the same shutdown without the
  // signal, and needs it to be safe to call twice.
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Idle keep-alive sockets are closed too. server.close() alone waits for
    // them, and a client that holds a connection open - which every browser
    // does - keeps the instance alive long after the caller asked it to stop.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    if (options.jobs !== false) {
      try { await jobs.stop(); } catch { /* nothing left running */ }
    }
    try { await db.close(); } catch { /* already closed */ }
  };

  return {
    app,
    server,
    close,
    port: server.address() ? server.address().port : listen.port,
    host: listen.host,
    instanceId: inst.instanceId,
    version: VERSION,
  };
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
        jobs.stop()
          .then(() => db.close())
          .catch(() => db.close())
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
