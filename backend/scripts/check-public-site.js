// The public website, verified the way the application is verified.
//
// The render harness covers the client, and the client is not the whole frontend: the
// public site is fourteen plain HTML documents served from public/, and until now nothing
// asserted they were reachable, that they were on the canonical design system, or that
// their own navigation went anywhere. They were the half of the frontend that lost its
// server entirely during the backend cutover - every page 404d on the live instance.
//
//   node scripts/check-public-site.js              reachability, content, no dead links
//   node scripts/check-public-site.js --tokens     also assert the design tokens

const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, '..', 'public');

// The clean URLs serve-client.js mounts, and what each is for.
const PAGES = [
  ['/terms', 'terms.html', 'Terms of Service'],
  ['/privacy', 'privacy.html', 'Privacy Policy'],
  ['/instances-terms', 'instances-terms.html', 'Instance terms'],
  ['/trust-and-safety', 'trust-and-safety.html', 'Trust and safety'],
  ['/support', 'support.html', 'Support'],
  ['/security', 'security.html', 'Security'],
  ['/about', 'about.html', 'About'],
  ['/features', 'features.html', 'Features'],
  ['/docs', 'documentation.html', 'Documentation'],
  ['/download', 'download.html', 'Download'],
  ['/status', 'status.html', 'Status'],
  ['/welcome', 'home.html', 'Home (preview at /welcome)'],
  ['/404', '404.html', 'Not found'],
];

const REDIRECTS = [['/contact', '/support']];

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout ' + urlPath)));
  });
}

async function main() {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const serveClient = require(path.join(ROOT, 'src', 'serve-client.js'));

  const app = express();
  // Mounted at /app, because that is what production runs: the public site's own links
  // point there, and a scan that cannot serve /app/* would report every one of them as a
  // dead link that in fact resolves.
  const APP_MOUNT = '/app';
  const clientDir = serveClient.mountClient(app, {
    serverDir: path.join(ROOT, 'src'),
    appMount: APP_MOUNT,
    originOf: () => '',
    cspOriginOf: () => '',
  });
  const publicDir = serveClient.mountPublicSite(app, {
    serverDir: path.join(ROOT, 'src'),
    clientDir,
    pages: { publishedHtml: async () => null },
  });
  serveClient.mountSpaFallback(app, {
    clientDir, publicDir, appMount: APP_MOUNT, mountOf: () => APP_MOUNT,
  });

  const port = await new Promise((resolve) => {
    const probe = require('http').createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });

  try {
    console.log('\n  every public page is reachable at its clean URL');
    for (const [url, file, label] of PAGES) {
      const r = await get(port, url);
      ok(url.padEnd(20) + ' ' + label,
        r.status === 200 && /<!doctype html>/i.test(r.body),
        'status ' + r.status);
    }

    console.log('\n  the contact redirect still works');
    for (const [from, to] of REDIRECTS) {
      const r = await get(port, from);
      ok(from + ' redirects to ' + to,
        r.status === 301 || r.status === 302,
        'status ' + r.status + (r.headers.location ? ' -> ' + r.headers.location : ''));
    }

    console.log('\n  the brand icon is served, not 404d');
    const ico = await get(port, '/favicon.ico');
    ok('GET /favicon.ico', ico.status === 200, 'status ' + ico.status);

    console.log('\n  no public page links to a URL that is not served');
    // An internal href that 404s is a dead link on the marketing site. Checked against
    // this same server, so what is measured is what a reader would get.
    const internal = new Set();
    for (const [url] of PAGES) {
      const r = await get(port, url);
      for (const m of r.body.matchAll(/href="(\/[^"#?]*)"/g)) internal.add(m[1]);
    }
    // Routes that belong to the application, not the public site.
    const appRoutes = new Set(['/app/', '/']);
    const dead = [];
    for (const href of [...internal].sort()) {
      if (appRoutes.has(href)) continue;
      const r = await get(port, href);
      if (r.status >= 400) dead.push(href + ' (' + r.status + ')');
    }
    ok('every internal link on the public site resolves',
      dead.length === 0, dead.slice(0, 6).join(', '));

    console.log('\n  the public site is not serving application routes');
    // /home and /login are application prefixes; the public site must not claim them, or
    // a refreshed deep link in the app gets a marketing page.
    for (const url of ['/home', '/login', '/settings']) {
      const r = await get(port, url);
      ok(url + ' is the application, not the public site',
        /<base href=/.test(r.body) || r.status === 404,
        'status ' + r.status);
    }

    if (process.argv.includes('--tokens')) {
      console.log('\n  the public site is on the canonical design system');
      const css = fs.readFileSync(path.join(PUBLIC, 'css', 'site.css'), 'utf8');
      // The tokens the application's stylesheet defines, which the public site has to
      // consume rather than redeclare under its own names.
      const canonical = ['--color-background', '--color-surface', '--color-accent',
        '--color-text-primary', '--space-', '--radius-', '--text-'];
      const missing = canonical.filter((t) => !css.includes(t));
      ok('site.css consumes the canonical tokens',
        missing.length === 0, 'missing: ' + missing.join(', '));
    }
  } finally {
    server.close();
  }

  console.log(`\n  public site check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('public site check could not run: ' + e.stack); process.exit(1); });
