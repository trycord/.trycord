// Shared helpers for the public-site tests.
//
// The link checker needs to know which addresses the server actually serves.
// That list lives in backend/src/serve-client.js, and it is read from there
// rather than copied, so a route added there and forgotten here fails the
// test instead of passing it.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(PUBLIC_DIR, '..');

// The clean URLs the server mounts, one per file, and the two aliases the
// server registers by hand. Read out of the server's own list so the two
// cannot disagree.
function serverRoutes() {
  const source = fs.readFileSync(path.join(REPO_DIR, 'backend', 'src', 'serve-client.js'), 'utf8');
  const routes = new Map();
  const block = /const CLEAN_PAGES = \[([\s\S]*?)\n\];/.exec(source);
  if (!block) throw new Error('CLEAN_PAGES not found in serve-client.js');
  const entry = /\{\s*route:\s*'([^']+)',\s*file:\s*'([^']+)'/g;
  let m;
  while ((m = entry.exec(block[1]))) routes.set(m[1], m[2]);
  routes.set('/welcome', 'home.html');
  routes.set('/404', '404.html');
  return routes;
}

// Addresses the server answers itself, with no file behind them.
const SERVER_ONLY_ROUTES = new Set([
  '/contact',        // redirects to /support
  '/robots.txt',
  '/sitemap.xml',
  '/backend.json',
  '/favicon.ico',
]);

// The application is a separate tree, mounted at a prefix. A link into it is
// checked by the application, not by this site, so it is allowed through -
// but it must carry the marker that says the mount is resolved rather than
// assumed.
const APP_PREFIX = '/app';

function htmlFiles() {
  return fs.readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => path.join(PUBLIC_DIR, name));
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// Every href and src in a document, with the attribute they came from.
function references(html) {
  const out = [];
  const pattern = /\b(href|src)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = pattern.exec(html))) {
    out.push({ attribute: m[1].toLowerCase(), value: m[2] });
  }
  return out;
}

// The body of a named function in a source file, matched on braces. Used to
// assert on what a function does rather than on the whole file, so an
// unrelated mention elsewhere in the file cannot satisfy the check.
function functionBody(source, name) {
  const start = source.indexOf('function ' + name);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

module.exports = {
  PUBLIC_DIR,
  REPO_DIR,
  SERVER_ONLY_ROUTES,
  APP_PREFIX,
  serverRoutes,
  htmlFiles,
  read,
  references,
  functionBody,
};
