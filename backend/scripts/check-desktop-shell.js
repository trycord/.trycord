#!/usr/bin/env node
'use strict';

// The desktop window, and the one rule it has to keep.
//
// trycord-desktop serves the client over the trycord:// scheme from files on disk. That means
// nothing rewrites index.html for it, and index.html contains `<base href="/app/">` - the
// mount a hosted server rewrites per request and rewrites because it is the only thing that
// knows where it is mounted. Left as "/app/", every relative asset request from
// trycord://app/index.html goes to trycord://app/app/js/app.js, which is not a file.
//
// The old resolver answered every miss with index.html, so that request came back as the
// shell with status 200. The browser received HTML where it asked for a module, the module
// graph never started, and the application was a black screen. The crash screen could see
// the 200 and had no way to know it was not JavaScript - which is why this was so hard to
// see from the outside.
//
// Two properties, both asserted here:
//
//   1. A request for something that looks like a file and is not one is a 404.
//   2. index.html is served with the base href the window actually serves from.
//
//   node scripts/check-desktop-shell.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DESKTOP = path.join(ROOT, 'trycord-desktop');
const CLIENT = path.join(DESKTOP, 'client');
const SHELL_HTML = path.join(CLIENT, 'index.html');

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

// ── the resolver, read out of main.js rather than restated ──────────────────────────
//
// A copy would be a second implementation, and the whole point of these checks has been that
// a copy stops matching. So main.js is loaded and its resolver called for real.

function loadMain() {
  const src = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  // The module is written for Electron. Take the two functions out of the source text and
  // give them the two things they close over. If either is renamed or removed, this fails
  // loudly instead of quietly asserting nothing.
  const grab = (name) => {
    const start = src.indexOf('function ' + name);
    if (start === -1) throw new Error('main.js has no function ' + name);
    const end = src.indexOf('\n}\n', start);
    if (end === -1) throw new Error('main.js function ' + name + ' is unterminated');
    return src.slice(start, end + 3);
  };
  const appHost = /APP_HOST\s*=\s*'([^']+)'/.exec(src);
  if (!appHost) throw new Error('main.js does not name its app host');
  // APP_HOST is the module-scope constant resolveClientFile closes over. It is read out of
  // main.js rather than written here, so a change to the scheme host cannot leave this check
  // asserting about a host the window no longer uses.
  // eslint-disable-next-line no-new-func
  // Wrapping the grab in a function expression and calling it with the module's own `fs` and
  // `path` would leave the resolver closing over the check's imports, which is a second
  // dependency it should not have. It gets them as arguments instead.
  const factory = new Function(
    'fs', 'path', 'APP_HOST', '__dirname',
    grab('clientDir') + grab('isFile') + grab('resolveClientFile')
    + '\nreturn resolveClientFile;'
  );
  // The resolver takes a full request URL, because that is what the protocol handler hands
  // it. Passing the path alone is not what main.js ever does.
  // __dirname because that is where clientDir() looks for the bundle - the check runs from
// backend/scripts and main.js runs from trycord-desktop, and both must agree on the layout.
const resolve = factory(fs, path, appHost[1], DESKTOP);
  return (requestUrl) => resolve(requestUrl.startsWith('trycord://')
    ? requestUrl
    : 'trycord://app' + (requestUrl.startsWith('/') ? requestUrl : '/' + requestUrl));
}

// ── 1. a missing asset is a 404, not the shell ───────────────────────────────────────

const ask = loadMain();

ok('the desktop bundle is present', fs.existsSync(CLIENT),
  'no ' + CLIENT + ', so nothing about the window can be checked');

if (fs.existsSync(CLIENT)) {
  const asFile = (p) => {
    const f = ask(p);
    if (f === null) return '404';
    return f.endsWith('index.html') ? 'index.html' : 'file';
  };

  ok('the entry document is served', asFile('/index.html') === 'index.html');
  ok('a real module is served as itself', asFile('/js/app.js') === 'file',
    'got ' + asFile('/js/app.js'));
  ok('the stylesheet is served as itself', asFile('/css/app.css') === 'file');

  // The bug. This is the exact request the unrewritten <base href> produces.
  ok('the request an /app/ base produces is a 404, not the shell',
    asFile('/app/js/app.js') === '404',
    'got ' + asFile('/app/js/app.js') + ' - the browser was handed the shell as a module');
  ok('a missing module is a 404', asFile('/js/no-such-module.js') === '404',
    'got ' + asFile('/js/no-such-module.js'));
  ok('a missing stylesheet is a 404', asFile('/css/no-such-file.css') === '404');

  // A route has no file and must still land on the application.
  ok('a deep route still reaches the shell', asFile('/settings') === 'index.html');
  ok('a deep route with params still reaches the shell', asFile('/dms/abc-123') === 'index.html');
  ok('a deep route asking for a module is a 404',
    asFile('/settings/js/app.js') === '404',
    'got ' + asFile('/settings/js/app.js'));

  // Every module the client ships must be reachable from the window at the paths index.html
  // actually asks for. A file present on disk but not resolvable is invisible until the
  // browser asks for it.
  const jsDir = path.join(CLIENT, 'js');
  const mods = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        mods.push('/js/' + path.relative(jsDir, p).split(path.sep).join('/'));
      }
    }
  })(jsDir);
  const unreachable = mods.filter((m) => asFile(m) !== 'file');
  ok('every module in the bundle is reachable from the window', unreachable.length === 0,
    unreachable.length + ' not served, e.g. ' + unreachable.slice(0, 3).join(', '));
}

// ── 2. the shell is served with the base href this window can actually serve ──────────

const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
ok('the shell is rewritten on the way out', /<base href=/.test(mainSrc)
  && /replace\(\/<base href=/.test(mainSrc),
  'main.js does not rewrite <base href>, so the window serves the hosted mount');

ok('the desktop bundle carries a document to rewrite', fs.existsSync(SHELL_HTML),
  'no ' + SHELL_HTML);

// And the rewrite must actually produce a base the window can serve from, using the same
// function main.js uses.
{
  const grab = (name) => {
    const start = mainSrc.indexOf('async function ' + name)
      >= 0 ? mainSrc.indexOf('async function ' + name) : mainSrc.indexOf('function ' + name);
    const end = mainSrc.indexOf('\n}\n', start);
    return mainSrc.slice(start, end + 3);
  };
  const start = mainSrc.indexOf('async function serveShell');
  ok('serveShell exists to do the rewrite', start >= 0);
  if (start >= 0 && fs.existsSync(SHELL_HTML)) {
    const html = fs.readFileSync(SHELL_HTML, 'utf8');
    const before = /<base href="([^"]*)"/i.exec(html);
    const body = grab('serveShell');
    // The rewrite is one line in that function; check it against this bundle's own markup.
    const rewritten = html.replace(/<base href="[^"]*">/i, '<base href="/">');
    ok('the document has a base href to rewrite', !!before,
      'no <base href> in ' + SHELL_HTML);
    ok('the rewritten base points at the window root, not the hosted mount',
      /<base href="\/">/i.test(rewritten) && !/\/app\//.test(/<base href="([^"]*)"/i.exec(rewritten)[1]),
      'rewritten to ' + (/<base href="([^"]*)"/i.exec(rewritten) || [])[1]);
    ok('the function under test contains that rewrite', /<base href="\/">/.test(body),
      'serveShell does not rewrite the base href');
  }
}

console.log(failures
  ? `\n  desktop shell check FAILED - ${failures} assertion(s)\n`
  : '\n  desktop shell check passed - the window serves what the document asks for\n');
process.exitCode = failures ? 1 : 0;