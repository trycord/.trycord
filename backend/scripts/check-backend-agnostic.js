#!/usr/bin/env node
'use strict';

// The client is backend-agnostic: which instance it talks to is configuration, not
// code.
//
// This is the one property of the front end that is also a security property. A
// presentation module that names a backend, or an API layer that reaches for the
// page's own origin instead of the resolved address, is how a reader's bearer token
// ends up at the wrong instance - and the failure is silent, because everything
// renders and every request succeeds against somebody else's server.
//
// It is enforced by reading the shipped modules and by calling the resolver, so the
// two halves of the claim - "no component hardcodes an address" and "the address is
// changeable in one place" - are both checked rather than asserted in prose.
//
//   node scripts/check-backend-agnostic.js

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const FRONTEND = path.join(REPO, 'frontend');
const CLIENT_ROOTS = ['js', 'packages', 'mobile'];

// The official instance. It belongs in packages/config.js, as the last entry in the
// resolution order, and in the two shipped backend.json files that name the hosted
// default. Anywhere else is a component deciding where credentials go.
const OFFICIAL_HOSTS = ['api.trycord.dev', 'trycord-api.wispbyte.app'];
const CONFIG = path.join(FRONTEND, 'packages', 'config.js');

let failures = 0;
let assertions = 0;
const ok = (label, cond, detail) => {
  assertions++;
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');

const files = CLIENT_ROOTS.flatMap((r) => walk(path.join(FRONTEND, r)));
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

// ---- 1. no component hardcodes a production backend address -------------------
// The check is intentionally a plain substring search across every shipped client
// module: a string literal, a template, or a comment that names the official host in
// a presentation module is a decision that credentials go there, and the resolver is
// the only place that decision belongs.
const namingHost = [];
for (const [file, src] of sources) {
  if (file === CONFIG) continue;
  for (const host of OFFICIAL_HOSTS) {
    if (src.includes(host)) { namingHost.push(rel(file) + ' names ' + host); break; }
  }
}
ok('only packages/config.js names a production backend host',
  namingHost.length === 0, namingHost.join(', '));

// ---- 2. the address lives in exactly one place --------------------------------
// The storage key is the whole of "which backend the reader chose". If a second
// module reads or writes that key, changing the backend has two implementations and
// they will disagree.
const keyUsers = [];
for (const [file, src] of sources) {
  if (/trycord\.backendUrl/.test(src)) keyUsers.push(rel(file));
}
ok('the backend address is stored and read in one module',
  keyUsers.length === 1 && keyUsers[0] === rel(CONFIG),
  keyUsers.join(', ') || '(nobody reads it)');

// ---- 3. the API layer addresses requests through the resolver -----------------
// Every request URL is resolved, never built from the page origin or a literal. The
// page origin is right only when the client and the API are the same deployment,
// which is exactly the assumption the resolver exists to avoid making for you.
const api = sources.get(path.join(FRONTEND, 'packages', 'api.js')) || '';
ok('the request layer resolves its base rather than assuming it',
  (api.match(/TrycordConfig\.backendUrl\(\)/g) || []).length >= 1
  && !/location\.origin/.test(api),
  'api.js does not go through TrycordConfig.backendUrl()');

// Credentials are attached in one place. A second module writing an Authorization
// header is a second place a token can be sent to an address this check does not see.
const authWriters = [];
for (const [file, src] of sources) {
  // A comment that mentions the header is not an attachment; only an assignment is.
  if (/headers\.Authorization\s*=|setRequestHeader\(\s*['"]Authorization['"]/.test(src)) {
    authWriters.push(rel(file));
  }
}
ok('the Authorization header is attached in exactly one module',
  authWriters.length === 1 && authWriters[0] === 'frontend/packages/api.js',
  authWriters.join(', ') || '(nobody attaches it)');

// The socket derives its address from the resolved backend, so a failover moves the
// socket with it rather than leaving realtime pointed at the old instance.
const wsDerives = /export function wsUrl\(ticket\)[\s\S]*?backendUrl\(\)/.test(sources.get(CONFIG) || '');
ok('the socket address is derived from the resolved backend', wsDerives,
  'config.wsUrl does not build from backendUrl()');

// ---- 4. the client does not reach into the backend ----------------------------
// A local import that resolves outside frontend/ is the front end depending on the
// server's source, which an independent deployment cannot ship. Local specifiers
// that are not modules are left alone; a .js import is never an asset.
const escapes = [];
for (const [file, src] of sources) {
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), spec);
    const within = path.relative(FRONTEND, target);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      escapes.push(rel(file) + ' -> ' + spec);
    }
  }
}
ok('no client module imports anything outside frontend/',
  escapes.length === 0, escapes.slice(0, 6).join(', '));

// ---- 5. both presentation modules build on the shared platform -----------------
// The directive is "independent modules over one shared platform". This is the one
// place it is measured here: if a module stopped importing packages/, it is a fork
// of the platform, whatever the directory says. check-frontend-modules enforces the
// boundary; this asserts the dependency exists at all.
const dependsOnPlatform = (root) => {
  for (const file of files) {
    if (!rel(file).startsWith('frontend/' + root + '/')) continue;
    const src = sources.get(file);
    for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (rel(target).startsWith('frontend/packages/')) return true;
    }
  }
  return false;
};
ok('the Desktop module builds on the shared platform', dependsOnPlatform('js'));
ok('the Mobile module builds on the shared platform', dependsOnPlatform('mobile'));

// ---- 6. the shipped default is data, and the two modules agree on it ----------
// frontend/backend.json is the hint the desktop document fetches; the mobile
// document fetches its own copy because it sits one directory deeper. They describe
// the same official instance, so a divergence is a phone and a laptop signing in to
// different defaults.
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
const desktopCfg = readJson(path.join(FRONTEND, 'backend.json'));
const mobileCfg = readJson(path.join(FRONTEND, 'mobile', 'backend.json'));
ok('both entry documents ship a backend.json',
  !!desktopCfg && !!mobileCfg,
  (desktopCfg ? '' : 'frontend/backend.json missing or invalid ')
  + (mobileCfg ? '' : 'frontend/mobile/backend.json missing or invalid'));
if (desktopCfg && mobileCfg) {
  const same = desktopCfg.backendUrl === mobileCfg.backendUrl
    && JSON.stringify(desktopCfg.fallbackUrls || []) === JSON.stringify(mobileCfg.fallbackUrls || []);
  ok('the two backend.json files name the same instance and backups', same,
    'desktop ' + JSON.stringify(desktopCfg) + ' vs mobile ' + JSON.stringify(mobileCfg));
  // The shipped default must be the official host, and not some third origin that a
  // self-hoster would inherit as their backend.
  ok('the shipped default is the official instance',
    typeof desktopCfg.backendUrl === 'string' && desktopCfg.backendUrl.includes('api.trycord.dev'),
    String(desktopCfg.backendUrl));
}

// ---- 7. the resolver, called ---------------------------------------------------
// The static half says no component hardcodes an address. This half says the one
// place that owns the address actually accepts a change and refuses a bad one,
// which is "the API configuration can change without a UI rewrite" and "invalid
// configuration fails understandably" in the only form a check can observe.
(async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  globalThis.window = { location: { protocol: 'https:', origin: 'https://client.example' } };

  let config;
  try {
    config = await import(pathToFileURL(CONFIG).href);
  } catch (e) {
    ok('packages/config.js loads on its own', false, e.message);
    console.log('\n  backend-agnostic FAILED - config did not load\n');
    process.exit(1);
  }
  ok('packages/config.js loads on its own', true);

  // An invalid address is refused rather than stored and then used.
  const bad = config.setApiUrl('not-a-url');
  ok('an invalid address is refused, not stored',
    bad === null && config.readStored() === null,
    'setApiUrl returned ' + JSON.stringify(bad) + ', stored=' + JSON.stringify(config.readStored()));

  // A valid address is stored and becomes the resolved one, with no other module
  // involved.
  const good = config.setApiUrl('https://api.example.com/');
  ok('a valid address is stored and trimmed',
    good === 'https://api.example.com' && config.readStored() === 'https://api.example.com',
    'setApiUrl returned ' + JSON.stringify(good));
  const resolved = config.resolveBackend();
  ok('the stored address is the resolved backend',
    resolved.url === 'https://api.example.com' && resolved.source === 'stored',
    JSON.stringify(resolved));

  // Switching the resolver moves the socket with it.
  ok('the socket follows the resolved backend',
    config.wsUrl('ticket').startsWith('wss://api.example.com/'),
    config.wsUrl('ticket'));

  // Resetting hands control back to the shipped/derived default.
  config.resetBackend();
  ok('resetting forgets the chosen address',
    config.readStored() === null && config.resolveBackend().source !== 'stored',
    JSON.stringify(config.resolveBackend()));

  // The default the resolution order falls back to is the official instance and it
  // is the only address the client names.
  ok('the built-in default is the official instance',
    config.DEFAULT_BACKEND_URL.includes('api.trycord.dev') && /^https:/.test(config.DEFAULT_BACKEND_URL),
    config.DEFAULT_BACKEND_URL);

  console.log(failures
    ? `\n  backend-agnostic FAILED - ${failures} of ${assertions} assertion(s)\n`
    : `\n  backend-agnostic passed - ${assertions} assertions: one place names an`
      + ' address, one place stores it, one place attaches credentials, and both'
      + ' modules build on the platform\n');
  process.exit(failures ? 1 : 0);
})();
