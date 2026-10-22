// Serving the two static trees an instance may have: the web client, and an optional
// public website.
//
// This was 320 lines inside boot(), which made an entry point that should be wiring
// into the second-largest file in the server. The ordering is not incidental and is
// preserved exactly: the client is mounted first so it keeps the root and any shared
// asset names, then the public site, and the SPA fallback goes on last so it only sees
// requests neither of them answered.
//
// Split into three functions because Express is first-match-wins, so each has to be
// mounted at a different point in boot(). Merging them would change what answers what.

const express = require('express');
const fs = require('fs');
const path = require('path');

// Every segment here must also be a prefix in the client's route table. They
// drifted once: 'users' and 'invite' were routable but absent, so a profile or an
// invite link worked when navigated to and 404ed the moment anyone reloaded or
// bookmarked it - the failure only shows up on a hard request, which is exactly what
// local navigation testing never does. check-routes.js asserts the two agree,
// because a list only one side maintains drifts again.
const APP_ROUTE_PREFIXES = new Set([
  'home', 'dms', 'settings', 'account', 'server', 'servers', 'c', 'admin',
  'friends', 'notifications', 'discover', 'profile', 'users', 'invite',
  'login', 'register', 'forgot', 'reset-password', 'verify-email', 'two-step',
  'menu', 'legal', 'channel', 'message', 'support',
]);

// The clean URLs the public site mounts, one per file. A single list drives the
// routes and the sitemap so the two cannot disagree, and the check in
// scripts/check-public-site.js asserts them against each other. editable marks
// the pages served through the page editor; everything else is served verbatim
// from disk.
const CLEAN_PAGES = [
  { route: '/demo', file: 'demo.html' },
  { route: '/communities', file: 'communities.html' },
  { route: '/instances', file: 'instances.html' },
  { route: '/features', file: 'features.html' },
  { route: '/docs', file: 'documentation.html' },
  { route: '/developers', file: 'developers.html' },
  { route: '/download', file: 'download.html' },
  { route: '/faq', file: 'faq.html' },
  { route: '/install', file: 'install.html' },
  { route: '/about', file: 'about.html' },
  { route: '/changelog', file: 'changelog.html' },
  { route: '/roadmap', file: 'roadmap.html' },
  { route: '/status', file: 'status.html' },
  { route: '/terms', file: 'terms.html', editable: true },
  { route: '/privacy', file: 'privacy.html', editable: true },
  { route: '/instances-terms', file: 'instances-terms.html', editable: true },
  { route: '/trust-and-safety', file: 'trust-and-safety.html', editable: true },
  { route: '/support', file: 'support.html', editable: true },
  { route: '/security', file: 'security.html', editable: true },
  { route: '/guidelines', file: 'guidelines.html', editable: true },
  { route: '/community-guidelines', file: 'community-guidelines.html', editable: true },
  { route: '/federation-policy', file: 'federation-policy.html', editable: true },
  { route: '/cookies', file: 'cookies.html', editable: true },
  { route: '/licenses', file: 'licenses.html', editable: true },
];

// Where the built client might be, in the order it is tried.
//
// An explicit location first, so a deployment that arranges its files its own way does
// not have to imitate the repository layout to serve a web client. Relative values
// resolve against this directory rather than the working directory, because "where you
// started node" is not where the server lives.
function candidatePaths(serverDir, asked) {
  const out = [];
  if (asked) out.push(path.resolve(serverDir, '..', asked));
  out.push(
    path.join(serverDir, '..', '..', 'frontend'),
    path.join(serverDir, '..', 'client'),
    path.join(serverDir, '..', '..', 'trycord-desktop', 'client'),
    // A build output copied alongside the server, which is how a single directory
    // deployment ends up arranged.
    path.join(serverDir, '..', '..', 'dist', 'app'),
    path.join(serverDir, '..', 'dist', 'app'),
    path.join(serverDir, '..', 'public', 'app'),
  );
  return out;
}

// Where a request arrived from, as a bare origin (scheme + host + port), or
// null when it did not arrive over http(s) from a well-formed host. The
// client and the site both repoint their backend.json at this, so it is
// shared rather than owned by the entry that happened to define it first.
//
// Behind a proxy the host header is the one the browser used, which is the
// one we want: it is the origin the client is really talking to.
//
// req.protocol already honours X-Forwarded-Proto when - and only when -
// Express is told to trust the proxy (TRUST_PROXY=1, loopback only). Reading
// the header directly here skipped that gate, so a plain http caller could
// send X-Forwarded-Proto: https and have backend.json hand the client an
// https origin.
function originOf(req) {
  const host = req.headers && req.headers.host;
  if (!host || !/^[^\s/]+$/.test(String(host))) return null;
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return proto + '://' + host;
}

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

// The API origin a deployment names explicitly, reduced to a bare origin or
// '' when it names nothing usable.
//
// Three channels tell the browser where its API lives: the site's pages
// (meta tag and backend.json), the client's backend.json, and
// /runtime-config.js. All three were meant to follow the same precedence -
// an explicitly configured address wins over the serving origin - and the
// site carried it while the client's copy did not, so a deployment that
// named its API and served no public website had a client that talked to
// the server it came from instead. One helper, three callers, one rule.
function configuredApiBase() {
  return apiOriginOnly(process.env.TRYCORD_API_URL || process.env.API_URL || '');
}

// The one envelope /runtime-config.js is served in, on either server. Only
// safe public keys ever reach it: API origins and an instance label, never
// paths or secrets.
//
// The values are passed in rather than read here, because the two servers
// legitimately resolve them differently: the API server falls back to its
// own public address, the frontend server has validated that an API address
// exists and passes only what it validated. The format is the shared part,
// not the bindings.
function runtimeConfigRoute(cfg) {
  return (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store').send(
      'window.TRYCORD_CONFIG = Object.assign(window.TRYCORD_CONFIG || {}, ' +
      JSON.stringify(cfg) + ');'
    );
  };
}

// Serves the Mobile module's own entry document, with its base rewritten to wherever
// that module is mounted.
//
// The desktop tree and the mobile tree are two independent entry documents over one
// shared platform, and each one is right on an origin-root self-host and under /app.
// The base is stamped per request rather than written into the file for the same
// reason the desktop entry's is: the file on disk carries the hosted mount so the
// static deployment is correct, and a self-hoster's server corrects it.
//
// Shared by the front door and the SPA fallback so a cold visit to /mobile/ and a
// deep link inside it cannot disagree about the base.
function sendMobileDocument(clientDir, mount, res, next) {
  fs.readFile(path.join(clientDir, 'mobile', 'index.html'), 'utf8', (err, html) => {
    if (err) { if (!res.headersSent) next(err); return; }
    res.status(200)
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(html.replace(/<base href="[^"]*">/i, `<base href="${mount || ''}/mobile/">`));
  });
}

// Locates and mounts the web client. Returns its directory, or null if there is none,
// which is a supported deployment: an API-only instance.
function mountClient(app, opts) {
  const { serverDir, appMount, originOf, cspOriginOf, allowClientStaticBackend } = opts;
  const asked = String(process.env.TRYCORD_CLIENT_DIR || '').trim();
  const tried = [];

  for (const candidate of candidatePaths(serverDir, asked)) {
    tried.push(candidate);
    if (!fs.existsSync(path.join(candidate, 'index.html'))) continue;

    // index.html carries the hosted mount in its <base href> and reaches its assets
    // through relative URLs. Rewriting it here, at the one place the document is
    // served, is what makes the same build correct on an origin-root self-host and
    // under /app. Leaving it to the static handler meant GET / kept the hosted prefix
    // and asked for /app/css/app.css, which 404s - the application worked on every deep
    // link and not on its own front door.
    const sendIndex = (mount, res, next) => {
      fs.readFile(path.join(candidate, 'index.html'), 'utf8', (err, html) => {
        if (err) { if (!res.headersSent) next(err); return; }
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html.replace(/<base href="[^"]*">/i, `<base href="${mount || ''}/">`));
      });
    };
    app.get(['/', '/index.html'], (req, res, next) => sendIndex(appMount, res, next));

    // The Mobile module's front door, beside the desktop one. Registered before
    // express.static because the static handler is configured with index:false, so a
    // request for the directory itself is answered by hand and the embedded base can
    // be corrected.
    //
    // The base is this route's own mount, not appMount: an origin-root /mobile/ on an
    // instance that also serves under /app is still /mobile/, and stamping /app/mobile/
    // there made the module read the wrong prefix - the document loaded, the router
    // looked for /mobile/ in a tree rooted at /app/mobile, and every phone that reached
    // the alias got the not-found screen.
    app.get(['/mobile', '/mobile/', '/mobile/index.html'], (req, res, next) =>
      sendMobileDocument(candidate, '', res, next));
    if (appMount) {
      app.get([appMount + '/mobile', appMount + '/mobile/', appMount + '/mobile/index.html'],
        (req, res, next) => sendMobileDocument(candidate, appMount, res, next));
    }

    // backend.json, repointed at whoever is serving it.
    //
    // The shipped file names the official instance so the hosted front end has
    // something to talk to. A self-hoster deploys this same repository, so they
    // inherit that name - and because backend.json outranks the serving origin in the
    // client's resolution order, their client would sign people in against
    // api.trycord.dev while sitting on their own API. Repointing the file here makes
    // the rule one line: a client served by a backend talks to that backend. It holds
    // for the official deployment too, with no domain written into the client.
    //
    // There is one case where "that backend" is not the serving origin: the split
    // deployment. The frontend server serves the client and has no API at all -
    // following the rule literally would hand every browser its own address as the
    // API, and every request it made would come back to a server that cannot answer
    // it. A deployment that names its API explicitly (TRYCORD_API_URL, or the older
    // API_URL) knows better, and its address wins - the same precedence the public
    // site's copy already followed, so one rule now covers both files. The serving
    // origin keeps meaning the API whenever nothing is named, which is the unified
    // case, end to end and unchanged.
    const sendBackendJson = (relative) => (req, res, next) => {
      fs.readFile(path.join(candidate, relative), 'utf8', (err, raw) => {
        if (err) return next();
        let json;
        try { json = JSON.parse(raw); } catch { return next(); }
        const self = originOf(req);
        if (!self) return res.type('json').set('Cache-Control', 'no-store').send(raw);
        // Compare against what the file said before overwriting it, so the test below
        // is "is this the instance these backups belong to".
        const wasPinned = cspOriginOf(json.backendUrl);
        const named = configuredApiBase();
        const fallback = apiOriginOnly(process.env.API_BACKUP_URL);
        if (named) {
          json.backendUrl = named;
          // A deployment that names a failover origin is telling the client where to
          // fail over, and the channel that already carried backups (runtime-config)
          // says the same thing. Without the name, the shipped backups are somebody
          // else's: they would quietly walk a split client onto the official network,
          // so they go - same as always.
          if (fallback) json.fallbackUrls = [fallback];
          else delete json.fallbackUrls;
        } else {
          json.backendUrl = self;
          // Backup origins are spare capacity for the instance they were built for.
          // When we are that instance, keeping them is failover worth having. When we
          // are somebody else's - a self-hoster running this repository - they would
          // quietly walk the client onto the official network, so they go.
          if (wasPinned !== self) delete json.fallbackUrls;
        }
        res.set('Cache-Control', 'no-store')
          .type('json')
          .send(JSON.stringify(json, null, 2) + '\n');
      });
    };
    app.get('/backend.json', sendBackendJson('backend.json'));

    // The Mobile module carries its own backend.json beside its own entry document,
    // because loadStaticConfig fetches './backend.json' relative to the document base
    // - which is the module root, not the client root. Repointed the same way, so a
    // phone on a self-hosted instance talks to that instance rather than the official
    // network.
    app.get('/mobile/backend.json', sendBackendJson('mobile/backend.json'));
    if (appMount) {
      app.get(appMount + '/mobile/backend.json', sendBackendJson('mobile/backend.json'));
    }

    // Entry points are never cached (a stale index.html paired with fresh or stale
    // JS/CSS is what renders a blank page). Versioned assets use conditional
    // revalidation instead: browsers revalidate on every load (ETag), so new deploys
    // are picked up immediately without giving up caching entirely.
    const staticOptions = (extra) => Object.assign({
      index: false,
      setHeaders(res, filePath) {
        if (/(^|[\\/])(index\.html|config\.js)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'no-store');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }, extra);

    app.use(express.static(candidate, staticOptions()));

    // The same tree again under the configured mount, so a deployment that serves the
    // client from this server can address it at /app/... with no proxy in front
    // rewriting the prefix. redirect:false because the default turns a request for a
    // directory into a 301 to its slash form, and a redirect on a deep link is another
    // hop that can lose the mount.
    if (appMount) {
      app.get(appMount + '/', (req, res) => sendIndex(appMount, res, () => {}));
      // Before the mount's static handler: Express is first-match-wins, so the order is
      // what decides whether the repointed file or the shipped one is served.
      app.get(appMount + '/backend.json', sendBackendJson('backend.json'));
      app.use(appMount, express.static(candidate, staticOptions({ redirect: false })));
    }

    console.log('[info] serving web client from ' + candidate
      + (appMount ? ' (also mounted at ' + appMount + ')' : ''));
    if (allowClientStaticBackend) allowClientStaticBackend(candidate);
    return candidate;
  }

  // The paths are listed because "no index.html found next to the server" tells an
  // operator nothing about where the server actually looked, and the usual cause is a
  // layout that is fine but different from the one this file assumes.
  console.warn('[warn] web client NOT served: no index.html in any of these paths:');
  for (const t of tried) console.warn('         ' + t);
  console.warn('         Set TRYCORD_CLIENT_DIR to the directory holding index.html, '
    + 'or ignore this if this instance is API-only.');
  return null;
}

// The optional public website: plain editable HTML under the same origin as the app,
// with clean URLs for the main pages. Mounted after the client so the app keeps the
// root and any shared asset names. public/home.html is previewable at /welcome, since
// an operator may serve public/ from the domain root in front of a reverse proxy.
function mountPublicSite(app, opts) {
  const { serverDir, clientDir, pages, originOf } = opts;
  const siteOrigin = originOf || (() => '');

  let publicDir = null;
  for (const candidate of [
    path.join(serverDir, '..', '..', 'public'),
    path.join(serverDir, '..', 'public'),
  ]) {
    if (!fs.existsSync(path.join(candidate, 'home.html'))) continue;
    publicDir = candidate;
    break;
  }
  if (!publicDir) return null;

  // Where the API for this instance lives.
  //
  // The site and the API are usually served by the same process, in which case
  // the serving origin is the API's address. A deployment that names its API
  // explicitly - API_URL, or the older TRYCORD_API_URL - knows better, and its
  // address wins. Anything that cannot be parsed as an http(s) origin is
  // ignored rather than obeyed, so a typo in a setting cannot become an
  // address the site's pages start asking.
  const apiBaseFor = (req) => {
    const named = configuredApiBase();
    if (named) return named;
    return siteOrigin(req) || '';
  };

  // The public site's own backend.json, rewritten to the origin that served
  // it.
  //
  // The demo and the community directory read the instance's API. The site and
  // the API are not always the same origin - the site is often a static
  // deployment elsewhere - so a relative '/api/...' on the site reaches the
  // site, which has no API, and the page answers 404. The file names the
  // address; here it is rewritten to whoever is serving, which is the same
  // rule the client's copy follows.
  //
  // This route is registered BEFORE the static handler below, because
  // express.static answers anything that exists on disk - including
  // backend.json - and the route is the one that rewrites that file. The other
  // way round, the shipped file wins, the site points at the official
  // instance, and nothing says so.
  app.get('/backend.json', (req, res, next) => {
    fs.readFile(path.join(publicDir, 'backend.json'), 'utf8', (err, raw) => {
      if (err) return next();
      let json;
      try { json = JSON.parse(raw); } catch { return next(); }
      const self = siteOrigin(req);
      if (self) json.backendUrl = self;
      const api = apiBaseFor(req);
      if (api) json.backendUrl = api;
      // Where the application itself is served. The site's links into the app
      // used a hardcoded '/app/', which 404s on a deployment that serves the
      // client from the origin root, and on a static site with no app at all.
      // The file names the address; the server rewrites it to its own mount.
      if (json.appUrl === undefined) json.appUrl = (process.env.TRYCORD_APP_MOUNT || '').replace(/\/+$/, '');
      res.set('Cache-Control', 'no-store')
        .type('json')
        .send(JSON.stringify(json, null, 2) + '\n');
    });
  });

  // The site's own files. Registered after the route above, so that route
  // answers /backend.json and the static handler answers everything else.
  //
  // The site's test directory is not part of the site. It is source, and
  // there is no reason for it to be reachable, so it is refused before the
  // static handler can offer it - a file that answers 404 is a file nobody
  // can mistake for a page.
  app.use('/tests', (req, res) => {
    res.status(404).type('text').send('Not found');
  });
  app.use(express.static(publicDir, {
    index: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  const injectOriginMeta = (html, req, route) => {
    const origin = siteOrigin(req);
    if (!origin) return html;
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const path = route ? (route.startsWith('/') ? route : '/' + route) : '/';
    const url = origin + path;
    const titleM = /<title>([\s\S]*?)<\/title>/i.exec(html);
    const descM = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
    const title = titleM ? esc(titleM[1].trim()) : 'Trycord';
    const image = origin + '/assets/trycord-assets/app/trycord-og-image.png';
    const meta = [
      '<link rel="canonical" href="' + esc(url) + '">',
      '<meta property="og:url" content="' + esc(url) + '">',
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Trycord">',
      '<meta property="og:title" content="' + title + '">',
      '<meta property="og:image" content="' + esc(image) + '">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:title" content="' + title + '">',
      '<meta name="twitter:image" content="' + esc(image) + '">',
    ];
    if (descM) {
      meta.push('<meta property="og:description" content="' + esc(descM[1]) + '">');
      meta.push('<meta name="twitter:description" content="' + esc(descM[1]) + '">');
    }
    const monitorUrl = String(process.env.STATUS_MONITOR_PUBLIC_URL || '').trim();
    if (monitorUrl && route === '/status') {
      meta.push('<meta name="status-monitor" content="' + esc(monitorUrl) + '">');
    }
    // Where the API for this instance lives.
    //
    // The public site and the API are often different origins: the site is
    // frequently a static deployment and the API is the instance behind it. A
    // page on the site that asks for a relative '/api/...' reaches the site,
    // which has no API, and the request answers 404. The pages on this site
    // therefore resolve the API's address rather than assuming it is the page's
    // own origin, and this tag is where they read it from.
    meta.push('<meta name="trycord-api" content="' + esc(apiBaseFor(req)) + '">');
    return html.replace('</head>', '  ' + meta.join('\n  ') + '\n</head>');
  };

  const sendPublic = (res, name, status, req, route) => {
    res.set('Cache-Control', 'no-cache');
    const full = path.join(publicDir, name);
    if (name.endsWith('.html') && fs.existsSync(full)) {
      const html = injectOriginMeta(fs.readFileSync(full, 'utf8'), req, route);
      return res.status(status || 200).type('html').send(html);
    }
    res.status(status || 200).sendFile(name, { root: publicDir }, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
      }
    });
  };

  // A page an administrator has published through the page editor is served from the
  // database. Until then the file on disk is served unchanged, so an instance that
  // never uses the editor behaves exactly as it did before. The file provides the
  // shell, so only the content is replaced.
  const editablePage = (name, route) => {
    return async (req, res) => {
      const exists = fs.existsSync(path.join(publicDir, name));
      const body = exists ? await pages.publishedHtml(route) : null;
      if (!body) {
        return sendPublic(res, exists ? name : '404.html', exists ? 200 : 404, req, req.path);
      }
      const file = fs.readFileSync(path.join(publicDir, name), 'utf8');
      const marked = '<!-- page:begin -->';
      const markedEnd = '<!-- page:end -->';
      if (!file.includes(marked) || !file.includes(markedEnd)) {
        // The file has no editable region, so there is nowhere safe to substitute
        // content. Serving the file is better than guessing.
        return sendPublic(res, name, 200, req, route);
      }
      const start = file.indexOf(marked) + marked.length;
      const end = file.indexOf(markedEnd);
      const html = file.slice(0, start) + '\n' + body + '\n' + file.slice(end);
      res.status(200).set('Cache-Control', 'no-cache').type('html')
        .send(injectOriginMeta(html, req, route));
    };
  };

  // Map one public HTML file to one clean URL. Missing files fall back to the site's
  // own 404 page instead of a bare Express "Cannot GET".
  const publicPage = (name) => {
    return (req, res) => {
      const exists = fs.existsSync(path.join(publicDir, name));
      sendPublic(res, exists ? name : '404.html', exists ? 200 : 404, req, req.path);
    };
  };

  // One list drives the routes, the sitemap, and the check that keeps them in
  // agreement, so a route cannot exist here and be missing from the sitemap, or
  // the other way round.
  for (const p of CLEAN_PAGES) {
    app.get(p.route, p.editable ? editablePage(p.file, p.route.replace(/^\//, '')) : publicPage(p.file));
  }
  // Contact was merged into Support: /contact redirects rather than 404ing, so
  // existing inbound links and bookmarks keep working.
  app.get('/contact', (req, res) => res.redirect(301, '/support'));
  // The origin root is the public site's front door. Registered before the client
  // is mounted, because Express matches the first route that answers and the
  // client claims "/" for its own shell.
  if (fs.existsSync(path.join(publicDir, 'home.html'))) {
    app.get('/', publicPage('home.html'));
  }

  app.get('/welcome', (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    return publicPage('home.html')(req, res);
  });
  app.get('/404', publicPage('404.html'));

  // Robots and sitemap are derived from the same list the routes above mount:
  // a page added to the site is added to the sitemap by construction, and a
  // page removed stops being listed. The sitemap is absolute, per the protocol,
  // so it is built from the request's own origin rather than a configured
  // domain that could drift from what is actually served.
  app.get('/robots.txt', (req, res) => {
    const lines = [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /app/',
      'Disallow: /uploads',
      '',
      'Sitemap: ' + siteOrigin(req) + '/sitemap.xml',
    ];
    res.type('text/plain').set('Cache-Control', 'no-cache').send(lines.join('\n') + '\n');
  });

  app.get('/sitemap.xml', (req, res) => {
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const routes = ['/'].concat(
      CLEAN_PAGES.filter((p) => fs.existsSync(path.join(publicDir, p.file))).map((p) => p.route)
    );
    const origin = siteOrigin(req);
    const urls = routes.map((r) => '  <url><loc>' + esc(origin + r) + '</loc></url>').join('\n');
    res.type('application/xml').set('Cache-Control', 'no-cache')
      .send('<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '\n</urlset>\n');
  });

  // Browsers auto-request /favicon.ico on every page: serve the brand icon instead of
  // logging a 404 into every console. The icon is read from the client tree, which is
  // the single copy; public/ no longer carries one.
  // The brand icon lives in the asset library, which is the single copy. The public
  // website has no assets of its own, so when it is mounted first this falls back
  // to the repository's frontend directory.
  const FAVICON = 'assets/trycord-assets/app/trycord-logo.ico';
  app.get('/favicon.ico', (req, res) => {
    const root = clientDir || publicDir;
    res.set('Cache-Control', 'public, max-age=86400').sendFile(FAVICON, { root }, () => {
      if (res.headersSent) return;
      const fallback = path.join(__dirname, '..', '..', 'frontend');
      res.sendFile(FAVICON, { root: fallback }, () => {
        if (!res.headersSent) res.status(404).end();
      });
    });
  });

  console.log('[info] serving public website from ' + publicDir);
  return publicDir;
}

// Application routes are paths, not a hash, so a reload on /settings/privacy asks the
// server for a document that does not exist on disk. Anything that is not a real file
// and not an API path is the app, so it gets index.html and the router resolves the
// rest.
//
// This is what makes the address bar safe to bookmark. Without it, every deep link is
// a link that only works if you never refresh, which is the one thing a route is for.
function mountSpaFallback(app, opts) {
  const { clientDir, publicDir, appMount, mountOf } = opts;

  if (clientDir) {
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      // The mount is stripped first, and everything below is judged on the path
      // relative to it. A guard on the raw path is what let /app/api/nope through:
      // under the mount the request reads /app/api/nope, which does not start with
      // /api/, so it fell past this handler and was answered by the public site's
      // HTML 404 page instead of the API's JSON envelope.
      //
      // The mount is stripped first. Under /app the first segment is "app", which is
      // not an application route, so a mounted deployment 404ed every deep link it was
      // meant to serve - TRYCORD_APP_MOUNT existed, was documented, and did nothing.
      const mount = mountOf(req.path);
      // With no mount the path is already relative to the app, so it is used as-is.
      // Defaulting to '/' instead made the first segment empty, which is in no prefix
      // list, so every deep link 404ed on an origin-root deployment while the same
      // build worked under /app.
      const rest = mount ? req.path.slice(mount.length) || '/' : req.path;
      if (rest.startsWith('/api/') || rest.startsWith('/uploads') || rest.startsWith('/ws')) return next();
      // Anything with a file extension is an asset that genuinely is missing;
      // answering it with HTML would turn a broken script tag into a syntax error
      // far from the cause.
      if (/\.[a-z0-9]+$/i.test(rest)) return next();
      // The Mobile module is a subdirectory of the same client tree with its own entry
      // document, so a deep link inside it has to be answered with that document rather
      // than the desktop one - otherwise a refresh inside /mobile/settings dropped the
      // reader back into the desktop composition. Tested on the mount-relative path, so
      // both /app/mobile/... and /mobile/... resolve to the same base.
      if (rest === '/mobile' || rest.startsWith('/mobile/')) {
        // The request's own mount ('' at the origin root, /app under the mount), not
        // the configured one: a deep link on a root /mobile/... resolves its base
        // against /mobile/, and one under /app/mobile/... against /app/mobile/.
        return sendMobileDocument(clientDir, mount || '', res, next);
      }
      const seg = rest.split('/').filter(Boolean)[0] || '';

      // Auth pages live at root-level URLs: /login, /register, /forgot, /reset-password,
      // /verify-email, /two-step. When the client is mounted under /app those same
      // paths exist there too, but they redirect to the canonical root-level path so
      // there is one address for signing in and one place password-reset emails point.
      if (mount === '/app') {
        const target = '/' + seg + rest.slice(seg.length + 1);
        if (seg === 'login' || seg === 'register' || seg === 'forgot'
          || seg === 'reset-password' || seg === 'verify-email' || seg === 'two-step') {
          res.redirect(301, target);
          return;
        }
      }

      // An instance can also serve a marketing site from the same origin. Those clean
      // URLs belong to it, so the app only claims its own prefixes and anything else
      // falls through to the public site's own 404.
      if (!APP_ROUTE_PREFIXES.has(seg)) return next();
      // The base is stamped per request because the mount point is a deployment fact,
      // not a build-time constant: the same file is served from the origin root by a
      // self-hoster and from /app by the hosted deployment. Without it the document's
      // relative asset URLs resolve against the route, so /settings/security asked for
      // /settings/css/app.css and rendered with no stylesheet and no script. Always
      // rewritten, including the unmounted case - the file carries the hosted mount for
      // the Cloudflare deployment, which serves it statically with nothing to correct
      // it. Same rewriter as the front door, so a deep link and a cold visit cannot
      // disagree about the mount.
      fs.readFile(path.join(clientDir, 'index.html'), 'utf8', (err, html) => {
        if (err) { if (!res.headersSent) next(err); return; }
        // The base is the client's own mount, not the route's prefix. A root-level
        // app route (/login, /home) is still served by the client tree, and stamping
        // its own path as the base made it ask for /js/theme.js - which on an origin
        // that also serves a public site is the site's theme, and the module graph
        // died on a missing export before the first paint.
        res.status(200)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(html.replace(/<base href="[^"]*">/i, `<base href="${appMount || ''}/">`));
      });
    });
  }

  // Public site 404 page for unknown non-API GETs (only when the public website is
  // present). API paths keep their JSON error envelope.
  if (publicDir) {
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      // Mount-relative, for the same reason the handler above is: /app/api/nope is an
      // API request, and a guard on the raw path answered it with this HTML page.
      const mount = mountOf(req.path);
      const rest = mount ? req.path.slice(mount.length) || '/' : req.path;
      if (rest.startsWith('/api/') || rest.startsWith('/uploads') || rest.startsWith('/ws')) {
        return next();
      }
      res.status(404).set('Cache-Control', 'no-cache').sendFile('404.html', { root: publicDir }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    });
  }
}

module.exports = {
  mountClient,
  mountPublicSite,
  mountSpaFallback,
  originOf,
  apiOriginOnly,
  configuredApiBase,
  runtimeConfigRoute,
};