#!/usr/bin/env node
'use strict';


// The module graph the server actually serves, walked over HTTP from the browser's entry.
//
// Every relative import in every module the server hands out has to resolve to another
// module the server hands out. One that does not is a load failure at runtime, which is a
// black screen with nothing worth reading in the console, and it is invisible to the
// checks that read files: a specifier can be perfectly resolvable on disk and still 404
// because it points one directory too high.
//
// It exists because I checked three files by hand, told a reader the server was serving the
// new UI, and it was not: `ui/usercard.js` imported `./components.js` when the module sits
// one level up, and every static check was green. Four hours of that would have been one
// command here.
//
//   npm run check:graph                       # boots a throwaway server on a free port
//   node scripts/check-graph.js http://host   # or walks an instance that is already up

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let origin = process.argv[2] || '';
let child = null;
let tmp = null;

const cache = new Map();   // path -> text | null
const missing = [];
const from = [];
const askedBy = new Map();
let fetched = 0;

async function get(p) {
  if (cache.has(p)) return cache.get(p);
  const res = await fetch(origin + p, { cache: 'no-store' });
  if (!res.ok) {
    cache.set(p, null);
    missing.push(p + '  ->  ' + res.status);
    from.push(p + '   <- imported by ' + (askedBy.get(p) || '?'));
    return null;
  }
  const text = await res.text();
  cache.set(p, text);
  fetched++;
  return text;
}

function specs(src) {
  // Comments come out first. A doc comment that quotes an old import path - and this tree
  // has several, each explaining why a name stays re-exported - reads as a real import and
  // sends the walk to a file the server does not serve.
  const body = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/^([ \t]*)(\/\/)[^\n]*$/gm, '$1 ');
  const out = new Set();
  // import ... from 'x'   |  import('x')   |  export ... from 'x'
  for (const m of body.matchAll(/(?:^|[^\w$])(?:import|export)\s*(?:[\s\S]*?\s*from\s*)?\(?\s*['"](\.[^'"]+)['"]/gm)) {
    out.add(m[1]);
  }
  return out;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function boot(port) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-graph-'));
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', DB_CLIENT: 'sqlite',
      DB_FILE: path.join(tmp, 'g.sqlite'), MAIL_MODE: 'log',
      JWT_SECRET: 'graph-check-secret-0123456789abcdef', BCRYPT_COST: '4',
      RATE_LIMIT_MAX: '1000', UPLOAD_DIR: path.join(tmp, 'up'), SERVER_HOST_TYPE: 'express',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(origin + '/api/health')).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('  the server never came up:\n' + log.join('').split('\n').slice(-8).join('\n'));
  process.exit(1);
}

(async () => {
  if (!origin) {
    const port = await freePort();
    origin = 'http://127.0.0.1:' + port;
    // boot() takes the port, because allocating a second one here is how this script spent
    // its first run polling a port nothing was listening on.
    await boot(port);
  }
  const entry = '/js/app.js';
  const seen = new Set([entry]);
  const queue = [entry];
  let rounds = 0;

  while (queue.length) {
    if (++rounds > 400) { console.log('  refusing to follow more than 400 modules'); break; }
    const p = queue.shift();
    const src = await get(p);
    if (src === null) continue;
    for (const s of specs(src)) {
      let target = new URL(s, origin + p).pathname;
      if (!/\.[a-z]+$/.test(target)) target += '.js';
      if (!seen.has(target)) { seen.add(target); askedBy.set(target, p); queue.push(target); }
    }
  }

  console.log('  entry            : ' + entry);
  console.log('  modules walked   : ' + seen.size);
  console.log('  bodies fetched   : ' + fetched);
  console.log('  not served       : ' + missing.length);
  for (const m of from.slice(0, 20)) console.log('    from ' + m);
  for (const m of missing.slice(0, 15)) console.log('    ' + m);
  const stop = () => {
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on('exit', stop);
  stop();
  if (missing.length) {
    console.error('\n  graph check FAILED - ' + missing.length + ' import(s) the server does'
      + ' not answer\n');
    process.exit(1);
  }
  console.log('\n  graph check passed - every import the server is asked for is one it serves'
    + '\n');
  process.exit(0);
})();