// The public website, verified the way the application is verified.
//
// The render harness covers the client, and the client is not the whole frontend: the
//
//   node scripts/check-public-site.js              reachability, content, no dead links
//   node scripts/check-public-site.js --tokens     also assert the design tokens

const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const PUBLIC = path.join(ROOT, '..', 'public');

const PAGES = [
  ['/', 'home.html', 'Home'],
  ['/demo', 'demo.html', 'Demo'],
  ['/communities', 'communities.html', 'Communities'],
  ['/features', 'features.html', 'Features'],
  ['/docs', 'documentation.html', 'Documentation'],
  ['/download', 'download.html', 'Download'],
  ['/about', 'about.html', 'About'],
  ['/changelog', 'changelog.html', 'Changelog'],
  ['/roadmap', 'roadmap.html', 'Roadmap'],
  ['/status', 'status.html', 'Status'],
  ['/support', 'support.html', 'Support'],
  ['/security', 'security.html', 'Security'],
  ['/terms', 'terms.html', 'Terms of Service'],
  ['/privacy', 'privacy.html', 'Privacy Policy'],
  ['/instances-terms', 'instances-terms.html', 'Instance terms'],
  ['/trust-and-safety', 'trust-and-safety.html', 'Trust and safety'],
  ['/welcome', 'home.html', 'Home (preview at /welcome)'],
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

const count = (body, re) => (body.match(re) || []).length;

async function main() {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const serveClient = require(path.join(ROOT, 'src', 'serve-client.js'));

  const app = express();
  // Mounted at /app, because that is what production runs: the public site's own links
  // point there, and a scan that cannot serve /app/* would report every one of them as a
  // dead link that in fact resolves.
  const APP_MOUNT = '/app';
  const publicDir = serveClient.mountPublicSite(app, {
    serverDir: path.join(ROOT, 'src'),
    clientDir: null,
    originOf: () => 'https://trycord.test',
    pages: { publishedHtml: async () => null },
  });
  const clientDir = serveClient.mountClient(app, {
    serverDir: path.join(ROOT, 'src'),
    appMount: APP_MOUNT,
    originOf: () => '',
    cspOriginOf: () => '',
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
    const bodies = new Map();
    for (const [url, file, label] of PAGES) {
      const r = await get(port, url);
      bodies.set(url, r.body);
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
      for (const m of (bodies.get(url) || '').matchAll(/href="(\/[^"#?]*)"/g)) internal.add(m[1]);
    }
    // Routes that belong to the application, not the public site.
    const isAppRoute = (href) => href === '/' || href.startsWith('/app');
    const dead = [];
    for (const href of [...internal].sort()) {
      if (isAppRoute(href)) continue;
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
      const publicTokens = path.join(REPO, 'public', 'css', 'design-tokens.css');
      ok('the standalone public copy of the tokens exists',
        fs.existsSync(tokens) && fs.existsSync(publicTokens), tokens + ' / ' + publicTokens);
      if (fs.existsSync(tokens) && fs.existsSync(publicTokens)) {
        ok('the standalone copy matches the generated one',
          fs.readFileSync(tokens, 'utf8') === fs.readFileSync(publicTokens, 'utf8'));
      }
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

    console.log('\n  every page carries the same masthead and footer');
    const shellMissing = { skip: [], header: [], footer: [], nav: [], theme: [], discord: [] };
    for (const [url, , label] of PAGES) {
      const b = bodies.get(url) || '';
      if (!/class="skip-link"/.test(b)) shellMissing.skip.push(url);
      if (!/class="site-header"/.test(b)) shellMissing.header.push(url);
      if (!/class="site-footer"/.test(b)) shellMissing.footer.push(url);
      if (!/class="nav-trigger"/.test(b)) shellMissing.nav.push(url);
      if (!/data-theme-toggle/.test(b)) shellMissing.theme.push(url);
      if (!/discord\.gg\/dSF7eqsJuP/.test(b)) shellMissing.discord.push(url);
      void label;
    }
    ok('every page offers a skip link', shellMissing.skip.length === 0, shellMissing.skip.join(', '));
    ok('every page has the site header', shellMissing.header.length === 0, shellMissing.header.join(', '));
    ok('every page has the site footer', shellMissing.footer.length === 0, shellMissing.footer.join(', '));
    ok('every page has the grouped navigation', shellMissing.nav.length === 0, shellMissing.nav.join(', '));
    ok('every page offers the theme switch', shellMissing.theme.length === 0, shellMissing.theme.join(', '));
    ok('every page links the Discord community', shellMissing.discord.length === 0, shellMissing.discord.join(', '));

    // ---- the composition, which is the part that was actually redesigned ----
    //
    // A page that serves fine and still carries the old composition passes every
    // assertion above, so the layout is asserted separately. Sharing a design
    // system is not the same as being redesigned.
    console.log('\n  the composition is the redesigned one');

    const home = bodies.get('/') || '';

    ok('the masthead pairs the brand with grouped navigation',
      /class="[^"]*masthead"/.test(home) && /class="brand"/.test(home)
      && /class="site-nav"/.test(home) && /class="masthead-actions"/.test(home));
    ok('the brand mark is the library SVG, not a raster',
      /<svg class="mark"/.test(home) && !/<img class="brand-mark"/.test(home));

    ok('the hero is a two-column composition',
      /class="hero-grid"/.test(home) && /class="hero-copy"/.test(home) && /class="hero-stage"/.test(home),
      'no .hero-grid / .hero-copy / .hero-stage');
    ok('the hero holds the live client, not a screenshot',
      /class="app-window"/.test(home) && /data-demo="compact"/.test(home),
      'no .app-window[data-demo] in the hero');

    const points = (home.match(/<li>/g) || []).length;
    ok('the hero states its case in a short list',
      /class="hero-points"/.test(home) && points >= 3, points + ' list items');

    const sections = (home.match(/<section class="section/g) || []).length;
    ok('the body is a sequence of copy-led sections', sections >= 3, sections + ' sections');
    const rows = (home.match(/class="feature"/g) || []).length;
    ok('the narrative uses ruled feature rows',
      rows >= 4 && /class="feature-copy"/.test(home) && !/<div class="card-icon"/.test(home),
      rows + ' feature rows');

    const cardCount = (home.match(/<article class="card"/g) || []).length;
    ok('the capability inventory is a card grid', cardCount >= 4, cardCount + ' cards');

    ok('the getting-started section is a numbered sequence',
      /class="steps"/.test(home) && /class="step"/.test(home));

    ok('the page closes on an ember statement band', /class="band"/.test(home));

    ok('the footer opens with a call to action',
      /class="footer-brand"/.test(home) && /class="footer-brand"[\s\S]*?class="btn/.test(home));
    const cols = (home.match(/class="footer-col"/g) || []).length;
    ok('the footer has four link columns', cols >= 4, cols + ' columns');
    const discover = await get(port, '/app/discover');
    ok('the community directory link resolves', discover.status < 400, 'status ' + discover.status);

    const demo = bodies.get('/demo') || '';
    ok('the demo mounts the full client with its controls',
      /data-demo="full"/.test(demo) && /data-demo-controls/.test(demo),
      'no [data-demo="full"] / [data-demo-controls]');
    ok('the demo states what is live and what is simulated',
      /live:/i.test(demo) && /simulat/i.test(demo),
      'no live/simulated note');

    const dir = bodies.get('/communities') || '';
    ok('the directory offers search, sort, preview and paging',
      /data-directory/.test(dir) && /class="dir-search"/.test(dir)
      && /class="dir-sort"/.test(dir) && /data-dir-preview/.test(dir)
      && /data-dir-pager/.test(dir));
    ok('the directory reads the public discovery API',
      /\/api\/discover\/servers/.test((await get(port, '/js/public-api.js')).body),
      'endpoint not found in public-api.js');

    const terms = bodies.get('/terms') || '';
    ok('a prose page uses the two-column layout with a contents list',
      /prose-layout/.test(terms) && /<aside class="toc"/.test(terms),
      'no .prose-layout or .toc');
    const beginAt = terms.indexOf('page:begin');
    const endCount = (terms.match(/page:end/g) || []).length;
    const beginCount = (terms.match(/page:begin/g) || []).length;
    const layoutAt = terms.indexOf('prose-layout');
    const proseAt = terms.indexOf('<div class="prose">');
    const headAt = terms.indexOf('<h1>');
    const tocAt = terms.indexOf('<aside class="toc"');
    ok('the editable region is marked exactly once',
      beginCount === 1 && endCount === 1, beginCount + ' begin, ' + endCount + ' end');
    ok('the layout wrapper is outside the editable region',
      layoutAt !== -1 && beginAt !== -1 && layoutAt < beginAt,
      'wrapper at ' + layoutAt + ', page:begin at ' + beginAt);
    ok('the reading column is the thing that is edited',
      proseAt !== -1 && beginAt !== -1 && proseAt < beginAt,
      'prose at ' + proseAt + ', page:begin at ' + beginAt);
    ok('the page title lives outside the editable region',
      headAt !== -1 && beginAt !== -1 && headAt < beginAt,
      'title at ' + headAt + ', page:begin at ' + beginAt);
    ok('the contents list lives outside the editable region',
      tocAt !== -1 && beginAt !== -1 && beginAt < tocAt,
      'toc at ' + tocAt + ', page:begin at ' + beginAt);

    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'site.css'), 'utf8');
    ok('the contents list is sticky on a wide screen and gone on a narrow one',
      /\.toc \{[\s\S]*?position: sticky/.test(css)
      && /@media \(max-width: 1080px\)[\s\S]*?\.toc \{ display: none/.test(css));
    ok('the hero collapses to one column on a narrow screen',
      /@media \(max-width: 1000px\)[\s\S]*?\.hero-grid \{ grid-template-columns: 1fr/.test(css));
    ok('the navigation becomes a panel and yields to the menu control',
      /@media \(max-width: 1000px\)[\s\S]*?\.menu-toggle \{ display: inline-flex/.test(css)
      && /class="menu-toggle"/.test(home));
    ok('the feature rows and footer collapse on a narrow screen',
      /@media \(max-width: 760px\)[\s\S]*?\.feature \{ grid-template-columns: 1fr/.test(css)
      && /@media \(max-width: 760px\)[\s\S]*?\.footer-grid \{ grid-template-columns: 1fr 1fr/.test(css));
    ok('reduced motion removes the motion rather than shortening it',
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration: 0\.01ms/.test(css));

    // ---- the site announces itself to search engines ----
    console.log('\n  the site announces itself to search engines');

    const badCanonical = [];
    for (const [url] of PAGES) {
      const b = bodies.get(url) || '';
      const want = 'https://trycord.test' + url;
      const m = /<link rel="canonical" href="([^"]*)"/.exec(b);
      const og = /<meta property="og:url" content="([^"]*)"/.exec(b);
      if (!m || m[1] !== want || !og || og[1] !== want) {
        badCanonical.push(url + ' -> ' + (m ? m[1] : 'none'));
      }
    }
    ok('every page carries a correct canonical URL', badCanonical.length === 0, badCanonical.slice(0, 6).join(', '));

    const robots = await get(port, '/robots.txt');
    ok('GET /robots.txt serves crawl rules',
      robots.status === 200 && /User-agent: \*/.test(robots.body) && /Sitemap:/.test(robots.body),
      'status ' + robots.status);

    const sitemap = await get(port, '/sitemap.xml');
    const locs = [...(sitemap.body.match(/<loc>([^<]+)<\/loc>/g) || [])]
      .map((m) => m.replace(/<\/?loc>/g, ''));
    const expected = PAGES.map(([r]) => r).filter((r) => r !== '/welcome');
    const match = expected.every((route) => locs.some((l) => l === route || l === 'https://trycord.test' + route));
    ok('GET /sitemap.xml lists every clean URL and the home page',
      sitemap.status === 200 && match, 'status ' + sitemap.status + ', ' + locs.join(', '));

    console.log('\n  the status page is wired to real health endpoints, not static labels');
    const statusHtml = bodies.get('/status') || '';
    const statusJs = fs.readFileSync(path.join(PUBLIC, 'js', 'status.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    ok('the status page lists a state cell per component',
      ['site', 'api', 'db', 'app'].every((k) => statusHtml.includes('data-state-cell="' + k + '"')));
    ok('the status script probes the real health routes',
      statusJs.includes("'/health'") && statusJs.includes("'/api/health'"));
    ok('the server defines the health routes the page probes',
      serverSrc.includes("app.get('/health'") && serverSrc.includes("app.get('/api/health'"));

    console.log('\n  the status page learns about a configured status monitor');
    const previousMonitor = process.env.STATUS_MONITOR_PUBLIC_URL;
    try {
      process.env.STATUS_MONITOR_PUBLIC_URL = 'http://monitor.test:9972';
      const withMonitor = await get(port, '/status');
      const otherPage = await get(port, '/about');
      ok('a configured monitor URL is stamped into the status page',
        withMonitor.body.includes('<meta name="status-monitor" content="http://monitor.test:9972">'));
      ok('and not into any other page', !otherPage.body.includes('status-monitor'));
      delete process.env.STATUS_MONITOR_PUBLIC_URL;
      const withoutMonitor = await get(port, '/status');
      ok('with no monitor configured the status page is unchanged',
        !withoutMonitor.body.includes('status-monitor'));
    } finally {
      if (previousMonitor === undefined) delete process.env.STATUS_MONITOR_PUBLIC_URL;
      else process.env.STATUS_MONITOR_PUBLIC_URL = previousMonitor;
    }
  } finally {
    server.close();
  }

  console.log(`\n  public site check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('public site check could not run: ' + e.stack); process.exit(1); });
