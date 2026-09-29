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
const enforcement = require('./services/enforcement');
const pages = require('./services/pages');

const PORT = parseInt(process.env.PORT || '9971', 10);
// §11 host type is validated strictly: exactly "express" (direct exposure)
// or "nginx" (reverse-proxy deployment). Anything else is a hard startup
// error — never silently fall back to a different topology.
const HOST_TYPE = String(process.env.SERVER_HOST_TYPE || '').trim().toLowerCase();
if (HOST_TYPE && HOST_TYPE !== 'express' && HOST_TYPE !== 'nginx') {
  throw new Error('Invalid SERVER_HOST_TYPE. Expected "express" or "nginx".');
}
const nginxMode = HOST_TYPE === 'nginx';
// §14/normal bind: in nginx mode the public listener is nginx, so Express
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
function originCovers(pattern, origin) {
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;
  // A bare "*" would be Access-Control-Allow-Origin: *. Never honour it.
  if (pattern === '*') return false;

  // The only wildcard form supported is a "*." label at the start of the HOST:
  //   https://*.trycord.dev
  // Written with string operations rather than a regex on purpose - the
  // pattern is not a valid URL (that is the whole point of the wildcard), and
  // an escaped-delimiter regex for it is easy to get subtly wrong.
  const schemeEnd = pattern.indexOf('://');
  if (schemeEnd < 0) return false;
  const scheme = pattern.slice(0, schemeEnd);
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return false;  // literal scheme only
  const hostPart = pattern.slice(schemeEnd + 3);
  if (!hostPart.startsWith('*.')) return false;
  // No second wildcard anywhere else in the host or port.
  if (hostPart.slice(1).includes('*')) return false;

  let p, o;
  try {
    // Replace the "*" label only, keeping the dot that separates it from the
    // base host: "*.trycord.dev" -> "wildcard-label.trycord.dev".
    p = new URL(scheme + '://wildcard-label' + hostPart.slice(1));
    o = new URL(origin);
  } catch {
    return false;
  }
  // Wildcards only ever cover subdomains of an http(s) site. A custom-scheme
  // origin such as the desktop app's "trycord://app" is always matched exactly.
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
  if (p.protocol !== o.protocol) return false;
  if (p.port !== o.port) return false;
  // Hostnames are case-insensitive. Strip the label we just substituted back
  // off, leaving the base domain the wildcard actually covers.
  const base = p.hostname.toLowerCase().slice('wildcard-label.'.length);
  const host = o.hostname.toLowerCase();
  if (!base || !host.endsWith('.' + base)) return false;
  // Exactly one label: "a.trycord.dev" matches, "a.b.trycord.dev" does not, and
  // the bare apex is not covered by a "*." pattern.
  const label = host.slice(0, host.length - base.length - 1);
  return label.length > 0 && !label.includes('.');
}

// The desktop app's own origin. Registered as a privileged scheme in the
// Electron main process, so it has a real, non-opaque origin — which means the
// backend must allowlist it by name like any other client.
const DESKTOP_ORIGIN = 'trycord://app';

// Origins already explained, so a misconfiguration is logged once rather than
// on every request.
const refusedOrigins = new Set();

function warnRefusedOrigin(origin, clientOrigins) {
  if (refusedOrigins.has(origin)) return;
  refusedOrigins.add(origin);
  // The desktop app is the case that actually bites: it is a custom scheme, so
  // it can never be inferred the way localhost or file: can.
  if (origin.startsWith('trycord:')) {
    console.warn(
      '[warn] refused origin ' + origin + ' - this is the desktop app scheme. '
      + 'Add it to CLIENT_ORIGIN, e.g. CLIENT_ORIGIN='
      + (clientOrigins.length ? clientOrigins.join(',') + ',' : '')
      + DESKTOP_ORIGIN
    );
    return;
  }
  console.warn('[warn] refused origin ' + origin + ' (not matched by CLIENT_ORIGIN)');
}

function corsOptions(clientOrigins) {
  return {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl, same-origin navigations, health probes
      if (clientOrigins.length) {
        if (clientOrigins.some((p) => originCovers(p, origin))) return cb(null, true);
        warnRefusedOrigin(origin, clientOrigins);
        return cb(null, false);
      }
      try {
        const u = new URL(origin);
        const host = u.hostname;
        if (u.protocol === 'file:' || origin === 'null') return cb(null, true);
        if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return cb(null, true);
        warnRefusedOrigin(origin, clientOrigins);
        return cb(new Error('CORS: origin not allowed'));
      } catch {
        warnRefusedOrigin(origin, clientOrigins);
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
  console.log('[info] host type: ' + (nginxMode ? 'nginx (reverse proxy in front of :' + PORT + ')' : 'express (direct)'));
  // §12 mode-specific validation: surface obviously inconsistent topology at
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
  // §76 proxy trust is deliberate and narrow: only a proxy on the loopback
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
  const cspConnect = ['self', 'ws:', 'wss:'];
  const cspImg = ['self', 'data:', 'blob:'];
  const apiOrigin = ((process.env.TRYCORD_API_URL || '').trim() || inst.publicUrl || '');
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
  [apiOrigin, inst.publicUrl, inst.globalUrl].forEach((o) => o && addCspOrigin(o));
  ['http://localhost:9971', 'http://127.0.0.1:9971', 'https://trycord.dev'].forEach(addCspOrigin);
  String(process.env.CSP_CONNECT_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).forEach(addCspOrigin);
  // The served client's own static pin (backend.json) is part of the
  // centralized backend configuration: allow it once the client directory
  // is located below. Self-hosters repoint the client by editing that one
  // file — no source changes, no extra env needed for the common case.
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
  } else {
    allowClientStaticBackend(clientDir);
  }

  // Serve the public website (repo-root public/, optional). Plain editable
  // HTML/CSS/JS under the same origin as the app, plus clean URLs for the main
  // pages. Mounted AFTER the client so the app keeps the root and any shared
  // asset names; the public/home.html landing is previewable at /welcome (an
  // operator may also serve public/ from the domain root in front of a reverse
  // proxy).
  let publicDir = null;
  for (const candidate of [
    path.join(__dirname, '..', '..', 'public'),
    path.join(__dirname, '..', 'public'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'home.html'))) {
      publicDir = candidate;
      app.use(express.static(candidate, {
        setHeaders(res) {
          res.setHeader('Cache-Control', 'no-cache');
        },
      }));
      break;
    }
  }
  if (publicDir) {
    const sendPublic = (res, name, status) => {
      res.status(status || 200).set('Cache-Control', 'no-cache').sendFile(name, { root: publicDir }, (err) => {
        if (err && !res.headersSent) {
          res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
        }
      });
    };
    // A page an administrator has published through the page editor is served
    // from the database. Until then the file on disk is served unchanged, so an
    // instance that never uses the editor behaves exactly as it did before.
    // The file provides the shell, so only the content is replaced.
    const editablePage = (name, route) => {
      return async (req, res) => {
        const exists = fs.existsSync(path.join(publicDir, name));
        const body = exists ? await pages.publishedHtml(route) : null;
        if (!body) {
          return sendPublic(res, exists ? name : '404.html', exists ? 200 : 404);
        }
        const file = fs.readFileSync(path.join(publicDir, name), 'utf8');
        const marked = '<!-- page:begin -->';
        const markedEnd = '<!-- page:end -->';
        if (!file.includes(marked) || !file.includes(markedEnd)) {
          // The file has no editable region, so there is nowhere safe to
          // substitute content. Serving the file is better than guessing.
          return sendPublic(res, name, 200);
        }
        const start = file.indexOf(marked) + marked.length;
        const end = file.indexOf(markedEnd);
        const html = file.slice(0, start) + '\n' + body + '\n' + file.slice(end);
        res.status(200).set('Cache-Control', 'no-cache').type('html').send(html);
      };
    };
    // Map one public HTML file to one clean URL. Missing files fall back to the
    // site's own 404 page instead of a bare Express "Cannot GET".
    const publicPage = (name) => {
      return (req, res) => {
        const exists = fs.existsSync(path.join(publicDir, name));
        sendPublic(res, exists ? name : '404.html', exists ? 200 : 404);
      };
    };
    app.get('/terms', editablePage('terms.html', 'terms'));
    app.get('/privacy', editablePage('privacy.html', 'privacy'));
    app.get('/instances-terms', editablePage('instances-terms.html', 'instances-terms'));
    app.get('/trust-and-safety', editablePage('trust-and-safety.html', 'trust-and-safety'));
    app.get('/support', editablePage('support.html', 'support'));
    app.get('/security', editablePage('security.html', 'security'));
    app.get('/about', publicPage('about.html'));
    // Contact was merged into Support: /contact redirects rather than 404ing,
    // so existing inbound links and bookmarks keep working.
    app.get('/contact', (req, res) => res.redirect(301, '/support'));
    app.get('/support', publicPage('support.html'));
    app.get('/features', publicPage('features.html'));
    app.get('/docs', publicPage('documentation.html'));
    app.get('/download', publicPage('download.html'));
    app.get('/security', publicPage('security.html'));
    app.get('/status', publicPage('status.html'));
    app.get('/welcome', publicPage('home.html'));
    app.get('/404', publicPage('404.html'));
    // Browsers auto-request /favicon.ico on every page: serve the brand
    // icon instead of logging a 404 into every console.
    app.get('/favicon.ico', (req, res) => {
      res.set('Cache-Control', 'public, max-age=86400').sendFile('assets/trycord-logo.ico', { root: publicDir }, () => {
        if (!res.headersSent) res.status(404).end();
      });
    });
    console.log('[info] serving public website from ' + publicDir);
  }

  const { broadcast, broadcastDm, sendToUser, isOnline, getPresence, issueTicket, disconnectUser, broadcastServer, evictUserFromServer } = createGateway(server);
  require('./routes/auth').setTicketIssuer(issueTicket);
  require('./routes/auth').setGateway({ disconnectUser });
  require('./routes/messages').setGateway({ broadcast, sendToUser });
  require('./routes/channels').setGateway({ broadcast });
  app.use('/api/mutes', require('./routes/mutes'));
  // Instance-wide announcement banners (per-deployment, not global).
  app.use('/api/announcements', require('./routes/announcements'));
  require('./routes/dms').setGateway({ broadcastDm, sendToUser, isOnline });
  require('./routes/friends').setGateway({ sendToUser });
  require('./routes/users').setGateway({ getPresence });
  require('./routes/admin').setGateway({ disconnectUser });
  require('./services/events').setGateway({ broadcast: broadcastServer, evict: evictUserFromServer });

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

  // Public site 404 page for unknown non-API GETs (only when the public
  // website is present). API paths keep their JSON error envelope below.
  if (publicDir) {
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/uploads') || req.path.startsWith('/ws')) {
        return next();
      }
      res.status(404).set('Cache-Control', 'no-cache').sendFile('404.html', { root: publicDir }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    });
  }

  // Consistent error envelope for anything that escapes routes.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err && (err.statusCode || err.status)) || 500;
    // Client-side problems surface as proper 4xx (body-parser rejects with
    // 413/400 for oversized or malformed JSON). Everything else stays a
    // generic 500 — never stack traces, queries, or internals (§79).
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
