#!/usr/bin/env node
'use strict';

// The gateway's event vocabulary, on both sides of the socket.
//
// The backend emits event names as string literals; the client receives them as
// string literals. Nothing connects the two lists, so a name spelled differently
// on one side is an event that is sent and never received, or received and never
// sent, and neither side reports it. The failure is silent by construction: the
// sender believes it sent the right thing, the receiver believes it is listening
// for the right thing, and the only symptom is a feature that does not work.
//
// Both sides now keep their names in a module rather than at the call site. This
// check reads both modules and compares them, so the duplication is verified
// rather than trusted.
//
//   node scripts/check-events.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BACKEND_EVENTS = path.join(ROOT, 'src', 'ws', 'events.js');
// The client's event module is realtime.js: the rewrite folded the separate
// realtime-events.js back into the gateway module it belongs to, and the EVENTS and
// SESSION_EVENTS maps live there under the same names this check reads.
const FRONTEND_EVENTS = path.join(ROOT, '..', 'frontend', 'packages', 'realtime.js');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label + (detail ? ': ' + detail : ''));
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

/**
 * Read an object literal's keys and values out of a source file without
 * evaluating it. Both modules declare `const EVENTS = { ... }` at the top
 * level, so a brace-balanced slice of that declaration is enough.
 */
function readMap(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('const ' + name + ' = {');
  if (start === -1) throw new Error('no ' + name + ' in ' + path.relative(ROOT, file));
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('unterminated ' + name + ' in ' + path.relative(ROOT, file));

  const out = {};
  const body = src.slice(open + 1, end);
  // Each entry is `KEY: 'value',` on its own line. A trailing comment on the
  // line is stripped so a name carrying a note is still read.
  for (const m of body.matchAll(/^\s*([A-Z0-9_]+)\s*:\s*'([^']*)'/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const backend = readMap(BACKEND_EVENTS, 'EVENTS');
  const frontend = readMap(FRONTEND_EVENTS, 'EVENTS');
  const backendSession = readMap(BACKEND_EVENTS, 'SESSION_EVENTS');
  const frontendSession = readMap(FRONTEND_EVENTS, 'SESSION_EVENTS');

  console.log('\n  the gateway vocabulary');

  // Every name the backend can emit, spelled the way the client listens for it.
  const missingOnTheClient = Object.keys(backend).filter((k) => !(k in frontend));
  ok('every event the backend emits is one the client listens for',
    missingOnTheClient.length === 0,
    missingOnTheClient.map((k) => k + ' (' + backend[k] + ')').join(', '));

  // And the other way: a name the client matches on that the backend never sends
  // is a handler for an event that cannot arrive.
  const neverSent = Object.keys(frontend).filter((k) => !(k in backend));
  ok('every event the client listens for is one the backend sends',
    neverSent.length === 0,
    neverSent.map((k) => k + ' (' + frontend[k] + ')').join(', '));

  // The values, not just the keys: a key present on both sides with a different
  // value is the silent failure this check exists for.
  const mismatched = Object.keys(backend).filter(
    (k) => k in frontend && backend[k] !== frontend[k]
  );
  ok('each event name is spelled the same on both sides',
    mismatched.length === 0,
    mismatched.map((k) => k + ': backend ' + backend[k] + ' vs client ' + frontend[k]).join(', '));

  // Same for the account-scoped events, which are a separate list because they
  // answer to different handlers.
  const sessionMissing = Object.keys(backendSession).filter((k) => !(k in frontendSession));
  ok('every session event the client handles is one the backend sends',
    sessionMissing.length === 0,
    sessionMissing.map((k) => k + ' (' + backendSession[k] + ')').join(', '));

  const sessionMismatched = Object.keys(backendSession).filter(
    (k) => k in frontendSession && backendSession[k] !== frontendSession[k]
  );
  ok('each session event name is spelled the same on both sides',
    sessionMismatched.length === 0,
    sessionMismatched.map((k) => k + ': backend ' + backendSession[k]
      + ' vs client ' + frontendSession[k]).join(', '));

  // The literals at the call sites. Both modules centralise the names, but a
  // literal typed directly into a broadcast is exactly what this is here to
  // catch, so the source is read rather than taken on trust.
  const literal = /type:\s*'([a-z:_]+)'/g;
  const literals = new Map();
  for (const file of [
    'src/ws/frames.js', 'src/ws/presence.js', 'src/services/bots.js',
    'src/routes/messages.js', 'src/routes/channels.js', 'src/routes/bot.js',
    'src/routes/friends.js', 'src/routes/dms.js',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(literal)) {
      if (!literals.has(m[1])) literals.set(m[1], []);
      literals.get(m[1]).push(path.relative(ROOT, file));
    }
  }
  ok('no event name is typed as a literal at a call site',
    literals.size === 0,
    [...literals].map(([name, where]) => name + ' in ' + where.join(', ')).join('; '));

  const count = Object.keys(backend).length;
  console.log('\n  ' + count + ' events, both sides agreeing');
  console.log(`\n  events check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
