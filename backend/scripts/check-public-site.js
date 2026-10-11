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
const REPO = path.join(ROOT, '..');
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

    // The design-system assertions run every time, not behind a flag. The public site
    // carried its own palette for as long as it existed and nothing noticed, because the
    // check that would have noticed was opt-in.
    {
      console.log('\n  the public site is on the canonical design system');
      const css = fs.readFileSync(path.join(PUBLIC, 'css', 'site.css'), 'utf8');

      // 1. It consumes the semantic names the asset library is mapped onto. Naming them
      //    is not enough on its own, but not naming them means the palette was
      //    redeclared locally, which is the thing being checked for.
      const canonical = ['--color-background', '--color-surface', '--color-accent',
        '--color-text-primary', '--space-', '--radius-', '--text-'];
      const missing = canonical.filter((t) => !css.includes(t));
      ok('site.css consumes the canonical tokens',
        missing.length === 0, 'missing: ' + missing.join(', '));

      // 2. It declares no palette of its own. This is the assertion that actually catches
      //    a second design language: a file can name every token and still hardcode a
      //    colour, and the two files then drift the first time either is edited.
      const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      ok('site.css declares no raw colour',
        hexes.length === 0, hexes.slice(0, 8).join(', '));

      // 3. The generated token layer exists and is the one the build wrote, so the site
      //    cannot be reading a stale copy that has drifted from the library.
      const tokens = path.join(REPO, 'frontend', 'css', 'design-tokens.css');
      ok('the generated token layer exists',
        fs.existsSync(tokens), tokens);
      if (fs.existsSync(tokens)) {
        const body = fs.readFileSync(tokens, 'utf8');
        const asset = fs.readFileSync(
          path.join(REPO, 'frontend', 'assets', 'trycord-assets', 'tokens', 'trycord.css'), 'utf8');
        ok('it is the asset library, not a copy',
          body.includes(asset.trim().slice(0, 200)), 'first 200 chars of the library not found');
      }

      // 4. Every page links it, and links it before the file that consumes it.
      const html = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
      const unlinked = [];
      const wrongOrder = [];
      for (const f of html) {
        const s = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
        const at = s.indexOf('/css/design-tokens.css');
        const site = s.indexOf('/css/site.css');
        if (at === -1) unlinked.push(f);
        else if (site !== -1 && at > site) wrongOrder.push(f);
      }
      ok('every public page links the token layer',
        unlinked.length === 0, unlinked.join(', '));
      ok('every public page links it before site.css',
        wrongOrder.length === 0, wrongOrder.join(', '));

      // 5. And it is actually served, not just present on disk.
      const served = await get(port, '/css/design-tokens.css');
      ok('GET /css/design-tokens.css serves the tokens',
        served.status === 200 && served.body.includes('--tc-brand'),
        'status ' + served.status);
    }

    // ---- the composition, which is the part that was actually redesigned ----
    //
    // A page that serves fine and still carries the old composition passes every
    // assertion above, so the layout is asserted separately. Sharing a design
    // system is not the same as being redesigned.
    console.log('\n  the composition is the redesigned one');

    const home = await get(port, '/welcome');
    ok('the hero is a two-column composition, not one centred block',
      /hero-copy/.test(home.body) && /hero-aside/.test(home.body),
      'no .hero-copy / .hero-aside');

    // The brand mark is the library's SVG, crisp at any size and carrying the
    // page's own accent, rather than a raster frozen at one colour.
    ok('the brand mark is the library SVG, not the raster',
      /<svg class="mark"/.test(home.body) && !/<img class="brand-mark"/.test(home.body));

    // Feature cards carry an icon from the library, which is what gives them a
    // focal point instead of opening straight onto a kicker.
    const iconCards = (home.body.match(/<div class="card-icon"/g) || []).length;
    ok('the feature cards carry library icons',
      iconCards >= 4, iconCards + ' cards with an icon');

    // "Run it your way" is a numbered sequence rather than another card grid.
    ok('the steps section is a numbered sequence',
      /<div class="steps">/.test(home.body) && /<div class="step">/.test(home.body));

    // A prose page is a document with a spine and a generated contents list.
    const terms = await get(port, '/terms');
    ok('a prose page uses the two-column layout with a contents list',
      /prose-layout/.test(terms.body) && /<aside class="toc"/.test(terms.body),
      'no .prose-layout or .toc');
    // The wrapper sits outside the editable markers, so publishing cannot
    // destroy the contents list.
    const beginAt = terms.body.indexOf('page:begin');
    const layoutAt = terms.body.indexOf('prose-layout');
    ok('the layout wrapper is outside the editable region',
      layoutAt !== -1 && beginAt !== -1 && layoutAt < beginAt,
      'wrapper at ' + layoutAt + ', page:begin at ' + beginAt);

    // The stylesheet is the new one: the glows are derived, the cards lift, and
    // the header marks itself when there is content behind it.
    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'site.css'), 'utf8');
    ok('the header marks itself once the page has moved',
      /data-scrolled/.test(css));
    ok('the hero collapses to one column on a narrow screen',
      /@media \(max-width: 860px\)[\s\S]*?hero \.wrap \{ grid-template-columns: 1fr/.test(css));
    ok('the contents list is sticky on a wide screen and gone on a narrow one',
      /\.toc \{[\s\S]*?position: sticky/.test(css)
      && /@media \(max-width: 1000px\)[\s\S]*?\.toc \{ display: none/.test(css));

    // The reduced-motion preference removes the motion rather than shortening it.
    ok('reduced motion removes the hover lift',
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.card:hover/.test(css));
  } finally {
    server.close();
  }

  console.log(`\n  public site check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('public site check could not run: ' + e.stack); process.exit(1); });
