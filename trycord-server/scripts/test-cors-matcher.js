// Unit coverage for the CORS origin matcher.
//
// The matcher is the security boundary for "which callers may read API
// responses", so it is tested directly rather than only through a booted
// server. Pure: no database, no network.
//
// `originCovers` is not exported by server.js (server.js boots a listener on
// require), so it is loaded out of the source with a tiny harness that
// evaluates just the function. If the function is renamed or removed this
// fails loudly instead of silently passing.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src', 'server.js');
const source = fs.readFileSync(SRC, 'utf8');

const start = source.indexOf('function originCovers');
if (start < 0) {
  console.error('FATAL: originCovers not found in src/server.js - the test cannot verify anything.');
  process.exit(1);
}

// Extract the one function by brace matching rather than by slicing up to the
// next top-level declaration. Slicing to a sentinel silently swallows whatever
// gets inserted between the two - which is exactly what happened when the
// desktop-origin warning helpers were added, and it broke this test with a
// syntax error that looked nothing like a CORS problem.
function extractFunction(src, from) {
  let depth = 0, i = src.indexOf('{', from);
  if (i < 0) return null;
  for (let p = i; p < src.length; p++) {
    const c = src[p];
    if (c === '/' && src[p + 1] === '/') { p = src.indexOf('\n', p); if (p < 0) break; continue; }
    if (c === '/' && src[p + 1] === '*') { p = src.indexOf('*/', p) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; p++;
      while (p < src.length) {
        if (src[p] === '\\') { p += 2; continue; }
        if (src[p] === q) break;
        p++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(from, p + 1); }
  }
  return null;
}

const fnSrc = extractFunction(source, start);
if (!fnSrc) { console.error('FATAL: could not delimit originCovers'); process.exit(1); }
const originCovers = eval('(' + fnSrc + ')');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

const covers = (pattern, origin) => originCovers(pattern, origin);

// --- exact origins ---------------------------------------------------------
ok('exact apex match', covers('https://trycord.dev', 'https://trycord.dev'), 'should match');
ok('exact mismatch on path', !covers('https://trycord.dev', 'https://trycord.dev/app'), 'origin never has a path');
ok('exact mismatch on scheme', !covers('https://trycord.dev', 'http://trycord.dev'), 'http must not match https');
ok('exact mismatch on port', !covers('http://localhost:9971', 'http://localhost:9972'), 'port is part of an origin');
ok('exact mismatch on host', !covers('https://trycord.dev', 'https://nottrycord.dev'), 'suffix must not match');

// --- single-label subdomain wildcard ---------------------------------------
ok('wildcard covers one subdomain', covers('http://*.trycord.dev', 'http://beta.trycord.dev'), 'should match');
ok('wildcard covers another subdomain', covers('http://*.trycord.dev', 'http://alpha.trycord.dev'), 'should match');
ok('wildcard does not cover the bare apex', !covers('http://*.trycord.dev', 'http://trycord.dev'), 'apex is not a subdomain');
ok('wildcard does not cover two labels', !covers('http://*.trycord.dev', 'http://a.b.trycord.dev'), 'multi-label rejected');
ok('wildcard does not cross the scheme', !covers('https://*.trycord.dev', 'http://beta.trycord.dev'), 'scheme must be identical');
ok('wildcard does not cross the port', !covers('http://*.trycord.dev:8080', 'http://beta.trycord.dev'), 'port must be identical');
ok('wildcard does not match a lookalike suffix', !covers('http://*.trycord.dev', 'http://beta.ev.trycord.dev.attacker.example'), 'attacker suffix rejected');
ok('wildcard does not match an empty label', !covers('http://*.trycord.dev', 'http://.trycord.dev'), 'empty label rejected');
ok('wildcard matching is case-insensitive on host', covers('http://*.trycord.dev', 'http://BETA.Trycord.DEV'), 'hostnames are case-insensitive');

// --- the wildcard must never become a wildcard allow-all --------------------
ok('bare * is never honoured', !covers('*', 'https://evil.example'), 'would be ACAO: *');
ok('*.* is rejected', !covers('*.*', 'https://evil.example'), 'nonsense pattern');
ok('* in the scheme is rejected', !covers('*://trycord.dev', 'https://trycord.dev'), 'scheme must be literal');
ok('* in the port is rejected', !covers('http://trycord.dev:*', 'http://trycord.dev:8080'), 'port must be literal');
ok('* mid-host is rejected', !covers('http://try.*.dev', 'http://trycord.dev'), 'only a leading label wildcard is supported');
ok('trailing * is rejected', !covers('https://*.trycord.dev*', 'https://a.trycord.dev'), 'no partial wildcards');

// --- the desktop app origin is matched exactly, never as a wildcard ---------
ok('desktop app origin matches exactly', covers('trycord://app', 'trycord://app'), 'should match');
ok('desktop app origin is not extended to other hosts', !covers('trycord://app', 'trycord://evil'), 'must be exact');
ok('desktop app origin is not extended to other schemes', !covers('trycord://app', 'trycord2://app'), 'must be exact');
ok('a custom scheme is refused as a wildcard', !covers('trycord://*', 'trycord://anything'), 'custom schemes are not wildcarded');

// --- case sensitivity of the exact path -------------------------------------
ok('exact match is case-sensitive on scheme', !covers('https://trycord.dev', 'HTTPS://trycord.dev'), 'browsers send a lowercase scheme; a literal mismatch is refused rather than guessed');
ok('origin with trailing slash never occurs', !covers('https://trycord.dev', 'https://trycord.dev/'), 'origins carry no trailing slash');

// --- realistic deployment sets ----------------------------------------------
const OFFICIAL = ['https://trycord.dev', 'http://*.trycord.dev', 'trycord://app'];
const any = (list, o) => list.some((p) => originCovers(p, o));

ok('[official] browser apex allowed', any(OFFICIAL, 'https://trycord.dev'), 'browser must work');
ok('[official] browser subdomain allowed', any(OFFICIAL, 'http://beta.trycord.dev'), 'subdomain must work');
ok('[official] desktop app allowed', any(OFFICIAL, 'trycord://app'), 'Electron must work');
ok('[official] unapproved host refused', !any(OFFICIAL, 'https://evil.example'), 'must be refused');
ok('[official] localhost refused when not listed', !any(OFFICIAL, 'http://localhost:9971'), 'must be refused');

// A self-hosted instance that only needs the desktop client.
const SELFHOST = ['trycord://app'];
ok('[selfhost] desktop app allowed', any(SELFHOST, 'trycord://app'), 'Electron must work');
ok('[selfhost] arbitrary website refused', !any(SELFHOST, 'https://evil.example'), 'must be refused');
ok('[selfhost] a lookalike app-scheme origin refused', !any(SELFHOST, 'trycord://app.evil.example'), 'must be refused');

console.log('\ncors-matcher: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
