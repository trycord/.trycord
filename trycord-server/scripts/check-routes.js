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

const ROOT = path.join(__dirname, '..');
const CLIENT_ROUTES = path.join(ROOT, '..', 'trycord-client', 'js', 'routes.js');
const SERVER = path.join(ROOT, 'src', 'server.js');

// Prefixes the server answers with the shell even though no client route uses
// them. They are real application URLs - the ones the client reaches by
// rewriting rather than by routing - so their absence from the route table is
// not a disagreement.
const SERVER_ONLY = new Set(['channel', 'message', 'profile', 'account', 'home', 'settings']);

function clientSegments() {
  const src = fs.readFileSync(CLIENT_ROUTES, 'utf8');
  const prefixes = [...src.matchAll(/prefix:\s*'(\/[^']*?)'/g)].map((m) => m[1]);
  if (!prefixes.length) throw new Error('no route prefixes found in routes.js');
  return new Set(
    prefixes
      .map((p) => p.split('/').filter(Boolean)[0])
      .filter(Boolean)
  );
}

function serverSegments() {
  const src = fs.readFileSync(SERVER, 'utf8');
  const block = src.match(/const APP_ROUTE_PREFIXES = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('APP_ROUTE_PREFIXES not found in server.js');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const client = clientSegments();
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