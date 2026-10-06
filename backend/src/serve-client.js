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
  'login', 'register', 'forgot', 'reset-password', 'verify-email',
  'menu', 'legal', 'channel', 'message', 'support',
]);

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

    // backend.json, repointed at whoever is serving it.
    //
    // The shipped file names the official instance so the hosted front end has
    // something to talk to. A self-hoster deploys this same repository, so they
    // inherit that name - and because backend.json outranks the serving origin in the
    // client's resolution order, their client would sign people in against
    // api.trycord.dev while sitting on their own API. Repointing the file here makes
    // the rule one line: a client served by a backend talks to that backend. It holds
    // for the official deployment too, with no domain written into the client.
    app.get('/backend.json', (req, res, next) => {
      fs.readFile(path.join(candidate, 'backend.json'), 'utf8', (err, raw) => {
        if (err) return next();
        let json;
        try { json = JSON.parse(raw); } catch { return next(); }
        const self = originOf(req);
        if (!self) return res.type('json').set('Cache-Control', 'no-store').send(raw);
        // Compare against what the file said before overwriting it, so the test below
        // is "is this the instance these backups belong to".
        const wasPinned = cspOriginOf(json.backendUrl);
        json.backendUrl = self;
        // Backup origins are spare capacity for the instance they were built for. When
        // we are that instance, keeping them is failover worth having. When we are
        // somebody else's - a self-hoster running this repository - they would quietly
        // walk the client onto the official network, so they go.
        if (wasPinned !== self) delete json.fallbackUrls;
        res.set('Cache-Control', 'no-store')
          .type('json')
          .send(JSON.stringify(json, null, 2) + '\n');
      });
    });

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
  const { serverDir, clientDir, pages } = opts;

  let publicDir = null;
  for (const candidate of [
    path.join(serverDir, '..', '..', 'public'),
    path.join(serverDir, '..', 'public'),
  ]) {
    if (!fs.existsSync(path.join(candidate, 'home.html'))) continue;
    publicDir = candidate;
    app.use(express.static(candidate, {
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    break;
  }
  if (!publicDir) return null;

  const sendPublic = (res, name, status) => {
    res.status(status || 200).set('Cache-Control', 'no-cache').sendFile(name, { root: publicDir }, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
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
        return sendPublic(res, exists ? name : '404.html', exists ? 200 : 404);
      }
      const file = fs.readFileSync(path.join(publicDir, name), 'utf8');
      const marked = '<!-- page:begin -->';
      const markedEnd = '<!-- page:end -->';
      if (!file.includes(marked) || !file.includes(markedEnd)) {
        // The file has no editable region, so there is nowhere safe to substitute
        // content. Serving the file is better than guessing.
        return sendPublic(res, name, 200);
      }
      const start = file.indexOf(marked) + marked.length;
      const end = file.indexOf(markedEnd);
      const html = file.slice(0, start) + '\n' + body + '\n' + file.slice(end);
      res.status(200).set('Cache-Control', 'no-cache').type('html').send(html);
    };
  };

  // Map one public HTML file to one clean URL. Missing files fall back to the site's
  // own 404 page instead of a bare Express "Cannot GET".
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
  // Contact was merged into Support: /contact redirects rather than 404ing, so
  // existing inbound links and bookmarks keep working.
  app.get('/contact', (req, res) => res.redirect(301, '/support'));
  app.get('/features', publicPage('features.html'));
  app.get('/docs', publicPage('documentation.html'));
  app.get('/download', publicPage('download.html'));
  app.get('/status', publicPage('status.html'));
  app.get('/welcome', publicPage('home.html'));
  app.get('/404', publicPage('404.html'));

  // Browsers auto-request /favicon.ico on every page: serve the brand icon instead of
  // logging a 404 into every console. The icon is read from the client tree, which is
  // the single copy; public/ no longer carries one.
  app.get('/favicon.ico', (req, res) => {
    const root = clientDir || publicDir;
    res.set('Cache-Control', 'public, max-age=86400').sendFile('assets/trycord-logo.ico', { root }, () => {
      if (!res.headersSent) res.status(404).end();
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
      if (req.path.startsWith('/api/') || req.path.startsWith('/uploads') || req.path.startsWith('/ws')) return next();
      // Anything with a file extension is an asset that genuinely is missing;
      // answering it with HTML would turn a broken script tag into a syntax error
      // far from the cause.
      if (/\.[a-z0-9]+$/i.test(req.path)) return next();
      // An instance can also serve a marketing site from the same origin. Those clean
      // URLs belong to it, so the app only claims its own prefixes and anything else
      // falls through to the public site's own 404.
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
      const seg = rest.split('/').filter(Boolean)[0] || '';
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
        res.status(200)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(html.replace(/<base href="[^"]*">/i, `<base href="${mount || ''}/">`));
      });
    });
  }

  // Public site 404 page for unknown non-API GETs (only when the public website is
  // present). API paths keep their JSON error envelope.
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
}

module.exports = { mountClient, mountPublicSite, mountSpaFallback };