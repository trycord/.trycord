// Asserts that every route the client can navigate to is a prefix the server
// will hand index.html for.
//
// These two lists have to agree. The client owns a route table; the server owns
// the set of path prefixes it treats as an application route rather than as a
// file request. A route in the first and not the second works perfectly when you
// click to it and 404s on reload, on a bookmark, on a shared link, or on any
// request the browser makes without the SPA having run first.
//
// That is why this drifted for so long without anyone noticing: navigation
// testing never issues a hard request, so the missing entry is invisible until
// someone refreshes. It is exactly the failure this file exists to make
// impossible to ship.
//
// Run from the server root: node scripts/check-routes.js

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CLIENT_PAGES = path.join(ROOT, '..', 'trycord-client', 'js', 'pages', 'registry.js');
const SERVE_CLIENT = path.join(ROOT, 'src', 'serve-client.js');

// Prefixes the server answers with the shell even though no client route uses
// them. They are real application URLs - the ones the client reaches by
// rewriting rather than by routing - so their absence from the route table is
// not a disagreement.
const SERVER_ONLY = new Set(['channel', 'message', 'profile', 'account', 'home', 'settings']);

// Imported rather than pattern-matched out of the source. This used to grep
// routes.js for `prefix: '...'` literals, which meant the check was really
// asserting that a file it had been taught to read still had the shape it expected
// - and when the routes moved into the page registry it failed by opening a file
// that no longer existed, which says nothing about routes.
async function clientSegments() {
  const mod = await import(pathToFileURL(CLIENT_PAGES).href);
  const pages = mod.PAGES || [];
  if (!pages.length) throw new Error('no pages found in the registry');
  return new Set(
    pages
      .map((page) => String(page.path || '').split('/').filter(Boolean)[0])
      .filter(Boolean)
  );
}

// The list lives with the code that uses it rather than with the entry point. It was
// in server.js until the static serving moved out; this check caught the move, which is
// the sort of thing it is here for.
function serverSegments() {
  const src = fs.readFileSync(SERVE_CLIENT, 'utf8');
  const block = src.match(/const APP_ROUTE_PREFIXES = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('APP_ROUTE_PREFIXES not found in ' + SERVE_CLIENT);
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}


(async () => {
const client = await clientSegments();
const server = serverSegments();

const missing = [...client].filter((s) => !server.has(s)).sort();
const orphaned = [...server].filter((s) => !client.has(s) && !SERVER_ONLY.has(s)).sort();

if (missing.length || orphaned.length) {
  console.error('route check FAILED');
  if (missing.length) {
    console.error('\n  routable in the client, 404 on a hard request (add to APP_ROUTE_PREFIXES):');
    for (const s of missing) console.error('    ' + s);
  }
  if (orphaned.length) {
    console.error('\n  served as the app but no client route uses it:');
    for (const s of orphaned) console.error('    ' + s);
  }
  process.exit(1);
}

console.log(
  'route check passed (' + client.size + ' client segments, all served by the server)'
);
})();
