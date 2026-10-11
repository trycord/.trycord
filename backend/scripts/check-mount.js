// The mounted deployment: what a client served under /app actually gets.
//
// Two faults lived here and neither was visible from the origin root, which is where a
// self-hoster runs and where every test ran:
//
//   1. /app/api/nope was answered with the public site's HTML 404 page. The handlers
//      judged "is this an API path" on the raw request path, and under a mount that path
//      reads /app/api/... which does not start with /api/ - so the guard missed and the
//      request fell through to the marketing site's error document.
//
//   2. /app/backend.json was served straight off disk as the shipped file, which names
//      the official instance. The client fetches ./backend.json relative to its document,
//      so under the mount it asked for /app/backend.json - the one path the repointing
//      handler was never registered on. A self-hoster's client therefore signed people in
//      against api.trycord.dev while sitting on their own API, which is the exact failure
//      the repointing exists to prevent.
//
// Both are about ordering and prefix-stripping, so this builds the real static stack with
// the real modules and makes real requests against it. No server boot, no database.
//
//   node scripts/check-mount.js

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const CLIENT = path.join(REPO, 'frontend');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

// The official instance, which must never leak into a self-hoster's response.
const OFFICIAL = 'api.trycord.dev';

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout ' + urlPath)));
  });
}

// originOf and cspOriginOf as server.js defines them: the request's own origin, used to
// repoint backend.json at whoever is serving it.
const originOf = (req) => {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  return proto + '://' + host;
};
const cspOriginOf = (o) => {
  try { return new URL(o).origin; } catch { return ''; }
};

async function build(appMount) {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const serveClient = require(path.join(ROOT, 'src', 'serve-client.js'));
  const app = express();
  const mountOf = (reqPath) => {
    if (!appMount) return '';
    const seg = reqPath.split('/').filter(Boolean)[0] || '';
    return seg === appMount.replace(/^\//, '') ? appMount : '';
  };

  const clientDir = serveClient.mountClient(app, {
    serverDir: path.join(ROOT, 'src'),
    appMount, originOf, cspOriginOf,
  });
  const publicDir = serveClient.mountPublicSite(app, {
    serverDir: path.join(ROOT, 'src'),
    clientDir,
    // The page editor is not under test here; serving the file on disk is the behaviour
    // an instance that never publishes gets, and that is what these assertions want.
    pages: { publishedHtml: async () => null },
  });
  serveClient.mountSpaFallback(app, { clientDir, publicDir, appMount, mountOf });
  // The API's own 404, mounted the way server.js mounts it, so the comparison is
  // between the mounted and unmounted forms of the same handler.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no API route for ' + req.method + ' ' + req.path } });
  });
  return app;
}

(async () => {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const port = await new Promise((resolve) => {
    const probe = express ? require('http').createServer() : null;
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });

  const app = await build('/app');
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });

  console.log('\n  the mounted client');
  try {
    // The front door and a deep link under the mount.
    for (const p of ['/app/', '/app/home', '/app/settings', '/app/dms']) {
      const r = await get(port, p);
      ok('GET ' + p + ' is the shell', r.status === 200 && /<base href="\/app\/">/.test(r.body),
        'status ' + r.status);
    }

    // Assets under the mount.
    const css = await get(port, '/app/css/app.css');
    ok('GET /app/css/app.css is the stylesheet', css.status === 200 && !/^\s*</.test(css.body.trim()));

    console.log('\n  the API under the mount');
    // The fault: an API path under the mount must not be answered by the public site's
    // HTML 404 page, nor by the SPA shell.
    const apiMiss = await get(port, '/app/api/nope');
    ok('GET /app/api/nope is not the public site 404 page',
      !/Page not found/.test(apiMiss.body), 'status ' + apiMiss.status);
    ok('GET /app/api/nope is not the SPA shell',
      !/<base href=/.test(apiMiss.body), 'status ' + apiMiss.status);

    // A mounted API 404 is a 404 either way; what matters is that it is not HTML from a
    // different site.
    ok('GET /app/api/nope answers 404', apiMiss.status === 404, 'status ' + apiMiss.status);

    console.log('\n  backend.json, repointed');
    // The fault: the shipped file names the official instance, and a mounted client read
    // exactly that.
    const mounted = await get(port, '/app/backend.json');
    ok('GET /app/backend.json answers 200', mounted.status === 200, 'status ' + mounted.status);
    let json = null;
    try { json = JSON.parse(mounted.body); } catch { /* handled below */ }
    ok('GET /app/backend.json is JSON', !!json, mounted.body.slice(0, 60));
    if (json) {
      ok('the mounted backend.json names this instance, not the official one',
        !String(json.backendUrl || '').includes(OFFICIAL), 'backendUrl=' + json.backendUrl);
      ok('the mounted backend.json keeps no fallback to the official network',
        !(json.fallbackUrls || []).some((u) => String(u).includes(OFFICIAL)),
        JSON.stringify(json.fallbackUrls || []));
    }

    // The origin root keeps behaving, because a mount is additive.
    const root = await get(port, '/backend.json');
    ok('GET /backend.json is still repointed', /127\.0\.0\.1/.test(root.body), root.body.slice(0, 60));

    console.log('\n  the public site is untouched by the mount');
    for (const p of ['/features', '/about', '/terms', '/support', '/welcome']) {
      const r = await get(port, p);
      ok('GET ' + p + ' is the public site', r.status === 200 && !/<base href=/.test(r.body),
        'status ' + r.status);
    }

    // A public 404 for something that is neither.
    const miss = await get(port, '/definitely-not-a-page');
    ok('an unknown non-API path still gets the public 404', miss.status === 404, 'status ' + miss.status);
  } finally {
    server.close();
  }

  console.log(`\n  mount check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('mount check could not run: ' + e.stack); process.exit(1); });
