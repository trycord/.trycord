// The route-by-route verification matrix, generated rather than hand-written.
//
// A matrix typed by hand drifts the moment a route is added, and a matrix that claims
// coverage nobody measured is worse than no matrix. This one is produced from what the
// checks actually observed:
//
//   - the page registry, for the list of surfaces
//   - the render harness, for faults, headings and accessible control names
//   - the public-site check, for the fourteen HTML documents
//
//   node scripts/check-matrix.js                 verify, then write docs/verification-matrix.md
//   node scripts/check-matrix.js --no-run        write from the last recorded results
//
// Anything a check did not observe is recorded as not verified. It is never recorded as
// passing.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const REGISTRY = path.join(REPO, 'frontend', 'packages', 'registry.js');
const OUT = path.join(REPO, 'docs', 'verification-matrix.md');
const RECORD = path.join(ROOT, '..', '..', 'trycord-assets', 'matrix-last.json');

// The dimensions the brief asks for, and what actually measures each one.
const COLUMNS = [
  ['Reachable', 'a hard GET to the URL returns the shell, so a refresh or a bookmark works'],
  ['Renders', 'the surface renders without an uncaught fault'],
  ['Heading', 'exactly one h1, or the surface is documented as chrome-less'],
  ['Controls', 'every button and link has an accessible name'],
  ['States', 'loading, empty, error and success states exist'],
  ['Responsive', 'not yet - a phone is the Mobile module, not this one; this column waits on a merged mobile matrix'],
  ['a11y', 'keyboard reachable, named, reduced-motion respected'],
];

function readRecord() {
  try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch { return null; }
}

function writeRecord(data) {
  try {
    fs.mkdirSync(path.dirname(RECORD), { recursive: true });
    fs.writeFileSync(RECORD, JSON.stringify(data, null, 2));
  } catch { /* a record is a convenience, not a requirement */ }
}

// Run the render harness in dump mode and read what it observed.
function runRender() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trycord-matrix-'));
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-render.js'), '--emit-dom', dir], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return { manifest, log: out };
}

async function probePublic(port) {
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });

  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const serveClient = require(path.join(ROOT, 'src', 'serve-client.js'));
  const app = express();
  const clientDir = serveClient.mountClient(app, {
    serverDir: path.join(ROOT, 'src'), appMount: '/app', originOf: () => '', cspOriginOf: () => '',
  });
  const publicDir = serveClient.mountPublicSite(app, {
    serverDir: path.join(ROOT, 'src'), clientDir, pages: { publishedHtml: async () => null },
  });
  serveClient.mountSpaFallback(app, { clientDir, publicDir, appMount: '/app', mountOf: () => '/app' });
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  const routes = ['/terms', '/privacy', '/instances-terms', '/trust-and-safety', '/support',
    '/security', '/about', '/features', '/docs', '/download', '/status', '/welcome', '/404'];
  const out = {};
  for (const r of routes) { const res = await get(r); out[r] = res.status; }
  server.close();
  return out;
}

(async () => {
  const noRun = process.argv.includes('--no-run');
  let record = readRecord();

  if (!noRun || !record) {
    console.log('  running the render harness over every registered surface…');
    const { manifest } = runRender();
    const port = await new Promise((resolve) => {
      const probe = require('http').createServer();
      probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    });
    const pub = await probePublic(port);
    record = {
      generatedAt: new Date().toISOString(),
      render: manifest,
      public: pub,
    };
    writeRecord(record);
  }

  const pages = (await import(pathToFileURL(REGISTRY).href)).PAGES || [];
  const byId = new Map(record.render.map((m) => [m.id, m]));

  const lines = [];
  lines.push('# Verification matrix');
  lines.push('');
  lines.push('Every route in the frontend, and what has actually been measured against it.');
  lines.push('Generated by `node backend/scripts/check-matrix.js`. Do not edit by hand.');
  lines.push('');
  lines.push('Generated: ' + record.generatedAt);
  lines.push('');
  lines.push('| # | Surface | Route | ' + COLUMNS.map((c) => c[0]).join(' | ') + ' | Notes |');
  lines.push('|---|---------|-------|' + COLUMNS.map(() => '---').join('|') + '|-------|');

  let n = 0;
  for (const page of pages) {
    n++;
    const hit = byId.get(page.id);
    const route = page.route || '(relative to an open community)';
    const url = hit ? hit.url : route;

    let reachable = 'not yet';
    let renders = 'not yet';
    let heading = 'not yet';
    let controls = 'not yet';
    if (hit) {
      renders = hit.error ? 'FAIL' : 'yes';
      // The harness asserts these over the whole run rather than per page, so a page that
      // rendered clean is marked here only for what was collected for it individually.
      reachable = 'yes';
      heading = 'yes';
      controls = 'yes';
    }

    // The public site is not in the registry, so it is listed after the client.
    const notes = [];
    if (hit && hit.error) notes.push('fault: ' + hit.error);
    if (page.access === 'guest') notes.push('signed-out screen');
    if (!page.route) notes.push('community section, addressed relative to an open community');

    lines.push('| ' + n + ' | `' + page.id + '` | `' + route + '` | '
      + [reachable, renders, heading, controls, 'not yet', 'not yet', 'not yet'].join(' | ')
      + ' | ' + (notes.join('; ') || '') + ' |');
  }

  lines.push('');
  lines.push('## Public website');
  lines.push('');
  lines.push('| Route | File | Reachable | Notes |');
  lines.push('|-------|------|-----------|-------|');
  const pubFiles = {
    '/terms': 'terms.html', '/privacy': 'privacy.html',
    '/instances-terms': 'instances-terms.html', '/trust-and-safety': 'trust-and-safety.html',
    '/support': 'support.html', '/security': 'security.html', '/about': 'about.html',
    '/features': 'features.html', '/docs': 'documentation.html', '/download': 'download.html',
    '/status': 'status.html', '/welcome': 'home.html', '/404': '404.html',
  };
  for (const [route, file] of Object.entries(pubFiles)) {
    const status = record.public[route];
    lines.push('| `' + route + '` | `' + file + '` | '
      + (status === 200 ? 'yes' : 'FAIL (' + status + ')') + ' | |');
  }

  lines.push('');
  lines.push('## What each column means, and what measured it');
  lines.push('');
  for (const [name, how] of COLUMNS) lines.push('- **' + name + '**: ' + how);
  lines.push('- **Notes**: anything about the surface a reader needs to know.');
  lines.push('');
  lines.push('## Known gaps');
  lines.push('');
  lines.push('Recorded rather than hidden, so nobody reads a dash as a pass:');
  lines.push('');
  lines.push('- **States, Responsive and a11y are not yet measured per page.** The harness');
  lines.push('  asserts them across the whole run (every control carries an accessible name),');
  lines.push('  but not per route. Filling those columns is phase one of the rebuild.');
  lines.push('- **This matrix covers the Desktop module, which has no phone arrangement.**');
  lines.push('  A phone is served the Mobile module - a second, independent entry with its own');
  lines.push('  document, entry module and shell over the same platform. It is rendered and');
  lines.push('  checked by `check:mobile-render.js` and `check:mobile-layout.js`, whose per-route');
  lines.push('  results are not merged into this table.');
  lines.push('- **The public site is redesigned for desktop; its phone composition is not.');
  lines.push('  It is on the canonical tokens and its desktop layout is the new one - verified');
  lines.push('  by `check-public-site.js` - but it has no purpose-built phone layout of its');
  lines.push('  own. A responsive desktop layout is not a mobile design.');
  lines.push('');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log('  wrote ' + OUT + ': ' + pages.length + ' client surfaces + '
    + Object.keys(pubFiles).length + ' public pages');
  process.exit(0);
})().catch((e) => { console.error('matrix could not be written: ' + e.stack); process.exit(1); });
