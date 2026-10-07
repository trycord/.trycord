#!/usr/bin/env node
'use strict';

// Which origins this instance answers.
//
// originCovers() decides whether a browser is allowed to read a response, and it is the
// one piece of Trycord where a bug is a security bug rather than a broken page. It is
// also almost entirely comment: the rules it enforces - one label only, no bare star,
// http and https only, custom schemes matched exactly - are written down in prose, and
// prose is not a test.
//
// Nothing else covered this. The flow check drives HTTP with no Origin header at all,
// which is the "curl" branch, so every one of these rules could have been wrong and the
// suite would have stayed green.

const { originCovers, corsOptions, DESKTOP_ORIGIN } = require('../src/origins');

let passed = 0;
const failures = [];

// Objects are compared by value. Comparing them with === makes every assertion
// involving the cors callback's { err, allow } pair fail while printing two identical
// objects, which is a check that lies about itself.
const same = (a, b) => (a && typeof a === 'object')
  ? JSON.stringify(a) === JSON.stringify(b)
  : a === b;

function ok(label, actual, expected) {
  const good = same(actual, expected);
  if (good) {
    passed++;
    console.log('    ok   ' + label);
  } else {
    failures.push(label + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
    console.log('    FAIL ' + label + '  <- got ' + JSON.stringify(actual)
      + ', expected ' + JSON.stringify(expected));
  }
}

console.log('\n  which origins this instance answers');

console.log('\n  exact matches');
ok('a pattern equal to the origin matches', originCovers('https://trycord.dev', 'https://trycord.dev'), true);
ok('a different host does not match', originCovers('https://trycord.dev', 'https://evil.dev'), false);
ok('a different scheme does not match', originCovers('https://trycord.dev', 'http://trycord.dev'), false);
ok('a different port does not match', originCovers('https://trycord.dev:443', 'https://trycord.dev:8443'), false);
ok('case does not matter in the host', originCovers('https://TRYcord.dev', 'https://trycord.dev'), true);
ok('a trailing slash in the pattern does not match', originCovers('https://trycord.dev/', 'https://trycord.dev'), false);

console.log('\n  the bare star is never honoured');
ok('* matches nothing', originCovers('*', 'https://trycord.dev'), false);
ok('* matches nothing, not even itself', originCovers('*', '*'), false);

console.log('\n  a wildcard label covers exactly one label');
ok('a.b.trycord.dev covers a.trycord.dev', originCovers('https://*.trycord.dev', 'https://a.trycord.dev'), true);
ok('a wildcard does not cover two labels', originCovers('https://*.trycord.dev', 'https://a.b.trycord.dev'), false);
ok('a wildcard does not cover the apex', originCovers('https://*.trycord.dev', 'https://trycord.dev'), false);
ok('a wildcard does not cover another domain that ends the same way',
  originCovers('https://*.trycord.dev', 'https://a.nottrycord.dev'), false);
ok('the wildcard label is matched by the whole host, not a substring',
  originCovers('https://*.trycord.dev', 'https://trycord.dev.a.trycord.dev'), false);

console.log('\n  wildcards only over http and https');
ok('http wildcards are allowed', originCovers('http://*.trycord.dev', 'http://a.trycord.dev'), true);
ok('a wildcard with a custom scheme covers nothing',
  originCovers('trycord://*.app', 'trycord://a.app'), false);
ok('the scheme must agree', originCovers('https://*.trycord.dev', 'http://a.trycord.dev'), false);
ok('the port must agree', originCovers('https://*.trycord.dev:8443', 'https://a.trycord.dev:8443'), true);
ok('a port on the pattern still has to be matched',
  originCovers('https://*.trycord.dev:8443', 'https://a.trycord.dev'), false);

console.log('\n  malformed patterns are refused, not guessed');
ok('a pattern with no scheme is refused', originCovers('*.trycord.dev', 'https://a.trycord.dev'), false);
ok('a wildcard that is not at the start of the host is refused',
  originCovers('https://sub.*.trycord.dev', 'https://sub.a.trycord.dev'), false);
ok('two wildcards are refused', originCovers('https://*.*.trycord.dev', 'https://a.b.trycord.dev'), false);
ok('a nonsense scheme is refused', originCovers('ht tp://*.trycord.dev', 'https://a.trycord.dev'), false);
ok('an unparseable origin is refused', originCovers('https://*.trycord.dev', 'not a url'), false);

console.log('\n  the desktop app');
ok('the desktop scheme is matched exactly and never by wildcard',
  originCovers(DESKTOP_ORIGIN, DESKTOP_ORIGIN), true);
ok('a wildcard pattern cannot stand in for the desktop scheme',
  originCovers('trycord://*.app', DESKTOP_ORIGIN), false);
ok('another custom scheme does not get the desktop origin\'s permission',
  originCovers(DESKTOP_ORIGIN, 'other://app'), false);

console.log('\n  the cors middleware');
// The function itself, not just the matcher: this is what express actually calls.
//
// Two shapes of "no". cb(new Error(...)) is a hard refusal and the browser sees an error.
// cb(null, false) is a quiet one: the response goes out with no CORS headers, which the
// browser refuses to expose to the page. Both stop the caller reading the response, and
// the difference is only whether the console shows an error. What matters is that a
// refusal is a refusal, so that is what is asserted - not which of the two was chosen.
function decide(origin, configured) {
  return new Promise((resolve) => {
    corsOptions(configured).origin(origin, (err, allow) => resolve({ refused: !!err || allow !== true }));
  });
}

(async () => {
  const none = [];
  const allowSome = ['https://trycord.dev'];

  ok('a request with no Origin is allowed - curl, health probes',
    await decide(undefined, none), { refused: false });
  ok('a sandboxed iframe\'s "null" origin is allowed when nothing is configured',
    await decide('null', none), { refused: false });
  ok('file:// is allowed when nothing is configured',
    await decide('file:///tmp/trycord/index.html', none), { refused: false });
  ok('localhost is allowed when nothing is configured',
    await decide('http://localhost:5173', none), { refused: false });
  ok('an unknown origin with nothing configured is refused',
    await decide('https://evil.dev', none), { refused: true });
  ok('a configured origin is allowed',
    await decide('https://trycord.dev', allowSome), { refused: false });
  ok('an origin outside the list is refused even when others are configured',
    await decide('https://evil.dev', allowSome), { refused: true });
  ok('configuring a list removes the localhost shortcut',
    await decide('http://localhost:5173', allowSome), { refused: true });
  ok('configuring a list removes the file: shortcut',
    await decide('file:///tmp/trycord/index.html', allowSome), { refused: true });

  console.log(`\n  origin check ${failures.length ? 'FAILED - ' + failures.length + ' problem(s)' : 'passed'}`
    + ` - ${passed} assertions\n`);
  process.exit(failures.length ? 1 : 0);
})();