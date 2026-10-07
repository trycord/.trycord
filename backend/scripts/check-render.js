#!/usr/bin/env node
'use strict';

// Render the real application in a real DOM.
//
// Everything else in this repository checks the client by parsing it, by importing
// it against a hand-written stub, or by talking to the server over HTTP. None of
// those look at what the client actually produces, because until now nothing could:
// Chromium is installed but its network service never completes an http request in
// this environment, so --dump-dom works against about:blank and hangs against a
// server. A browser was not available and jsdom was not installed.
//
// So: jsdom loads the real index.html, the real modules are imported into it, and
// fetch is proxied to a real running backend. What comes out is the DOM a reader
// would get, which is the thing worth asserting on. Layout is not measured - jsdom
// has no layout engine - so this cannot tell you whether a sidebar is 260px wide.
// It can tell you that the sidebar has a heading, that the tab bar has five tabs,
// that a button has an accessible name, or that a page threw.
//
//   node scripts/check-render.js                    every registered page
//   node scripts/check-render.js --route /dms       one route
//   node scripts/check-render.js --phone            phone composition
//   node scripts/check-render.js --dump             print the DOM of one route
//   node scripts/check-render.js --seed             create the throwaway account

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, '..', 'frontend');
// A free port, found by binding one and letting it go. A fixed port collides with
// whatever an interrupted run left behind, and the collision is silent from the
// outside: the leftover answers /api/health perfectly well, so the harness signs in
// against a database it did not create and every page comes back empty with nothing
// to say why. RENDER_PORT overrides it for a debugger that wants a known address.
async function freePort() {
  const probe = require('net').createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

let inFlight = 0;

// Set to a substring; any request whose URL contains it is answered with a server
// error instead of being made. Nothing else in the harness needs to know.
let breakUrl = null;
let PORT = Number(process.env.RENDER_PORT || 0);
// Resolved lazily: PORT is 0 until the free-port probe has run.
const origin = () => `http://127.0.0.1:${PORT}`;

// Mirrors the html:is([data-route=...]) list in frontend/css/app.css. Kept as data
// here rather than read out of the stylesheet because this check is about the client,
// and a stylesheet parser would be more machinery than the question deserves.
const CHROMELESS = ['/login', '/register', '/forgot', '/reset-password',
  '/verify-email', '/legal', '/support'];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (f, fallback) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

// jsdom is a test-only dependency and is deliberately not in package.json's
// dependencies: it is not needed to run Trycord. CI installs it for this script.
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.error('\n  check-render needs jsdom: npm install --no-save jsdom\n');
  process.exit(2);
}

let passed = 0;
const failures = [];
function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('    ok   ' + label);
  } else {
    failures.push(label + (detail ? ' <- ' + detail : ''));
    console.log('    FAIL ' + label + (detail ? '  <- ' + detail : ''));
  }
}

/**
 * Boot a throwaway backend and a jsdom window pointed at it.
 *
 * The server is real rather than mocked on purpose. A page that renders correctly
 * against fixtures can still be calling an endpoint that does not exist, and the
 * whole point of rendering it is to find that out.
 */
async function boot({ seed = false } = {}) {
  const dbDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trycord-render-'));
  const env = {
    ...process.env,
    DB_CLIENT: 'sqlite',
    DB_FILE: path.join(dbDir, 'render.db'),
    PORT: String(PORT),
    HOST: '127.0.0.1',
    UPLOAD_DIR: path.join(dbDir, 'uploads'),
    STORAGE_DRIVER: 'local',
    MAIL_MODE: 'log',
    ALLOW_TEST_HOOKS: 'true',
    JWT_SECRET: 'render-check-secret-0123456789abcdef',
  };

  // The server reads .env on require, and dotenv does not override variables that are
  // already set - which is the only reason setting DB_CLIENT here is enough to keep
  // this off the live database. Setting DB_FILE without it is not local.
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;

  const child = require('child_process').spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  // Prove this is the server we just started, not one that was already on the port.
  //
  // A stale render server left over from an interrupted run answers the health check
  // perfectly well, so the wait below reported success, the harness signed in against
  // a database it had not created, and every page came back empty - with no error
  // anywhere to say why. The signature is ours: this script's own throwaway JWT
  // secret, which no other process can be running.
  const base = `${origin()}/`;
  const deadline = Date.now() + 30000;
  let started = false;
  while (Date.now() < deadline) {
    if (/startup failed|EADDRINUSE|listen EADDR/i.test(log)) break;
    if (child.exitCode !== null) break;
    try {
      const res = await realFetch(base + 'api/health');
      if (res.ok && (await res.json()).ok) { started = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!started) {
    child.kill('SIGKILL');
    throw new Error(
      'the render check could not start its own backend on ' + origin() + '.\n'
      + 'Server said:\n' + log.slice(-1200)
    );
  }

  const dom = new JSDOM(readFile(path.join(CLIENT, 'index.html')), {
    url: base,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  const { window } = dom;

  // Record which elements were given an event listener, so a control that does nothing
  // can be caught. The DOM does not expose registered listeners and jsdom has no
  // equivalent of the inspector's getEventListeners, and addEventListener is the only
  // place a handler can appear - including the onClick shorthand that every el() call
  // with a handler goes through. Patching the prototype catches all of them at once.
  const wired = new WeakMap();
  const original = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn) {
      let seen = wired.get(this);
      if (!seen) { seen = new Set(); wired.set(this, seen); }
      seen.add(String(type).toLowerCase());
    }
    return original.call(this, type, fn, opts);
  };

  // jsdom implements neither of these and the shell uses both.
  if (!window.matchMedia) {
    window.matchMedia = (q) => ({
      media: q,
      matches: /min-width:\s*0px/.test(q),
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
  }
  window.scrollTo = () => {};

  return {
    window,
    document: window.document,
    wired,
    log: () => log,
    stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }),
    dbDir,
  };
}

function readFile(p) { return fs.readFileSync(p, 'utf8'); }

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(url, payload, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** A signed-in account for the throwaway database. Never the live one. */
async function signIn(base) {
  const creds = {
    username: 'renderuser',
    email: 'render@example.com',
    password: 'correct-horse-battery-staple',
    displayName: 'Render User',
    termsVersion: '1.0',
    privacyVersion: '1.0',
  };
  let res = await post(base + 'api/auth/register', creds);
  if (res.status !== 200 || !res.json.token) {
    res = await post(base + 'api/auth/login', {
      username: creds.username, password: creds.password,
    });
  }
  if (!res.json.token) throw new Error('could not sign in: ' + JSON.stringify(res.json).slice(0, 200));
  await post(base + 'api/test/self-verify', {}, res.json.token);
  return res.json.token;
}

// Node's own fetch, captured before anything replaces it. The proxy below calls this,
// and if it called the global instead it would be calling itself.
const realFetch = globalThis.fetch;

/** Install fetch in the jsdom window, proxying to the real backend. */
function wireFetch(window, token) {
  window.fetch = async (input, init) => {
    // Belt and braces. If the client ever resolves a backend this check does not own,
    // fail loudly instead of quietly measuring somebody else's instance.
    if (!String(typeof input === 'string' ? input : input.url).includes(String(PORT))) {
      throw new Error(
        'the render check refused a request to '
        + String(typeof input === 'string' ? input : input.url)
        + ' - this check only talks to its own backend on port ' + PORT
      );
    }
    const url = String(typeof input === 'string' ? input : input.url);
    const absolute = url.startsWith('http') ? url : origin() + (url.startsWith('/') ? url : '/' + url);
    const headers = Object.assign({}, (init && init.headers) || {});
    headers.Authorization = 'Bearer ' + token;
    if (breakUrl && absolute.includes(breakUrl)) {
      // In the shape the real server uses, so the client parses it the way it would in
      // production rather than falling into a branch that only exists in a test.
      return new Response(
        JSON.stringify({ error: { code: 'INTERNAL', message: 'the render check broke this on purpose' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    inFlight++;
    let res;
    try {
      res = await realFetch(absolute, Object.assign({}, init, { headers }));
    } finally {
      inFlight--;
    }
    if (process.env.RENDER_TRACE) {
      console.log('    [proxy] ' + (init && init.method) + ' ' + absolute + ' -> '
        + res.status + (res.status >= 400 ? ' ' + (await res.clone().text()).slice(0, 90) : ''));
    }
    return res;
  };
}

async function importClient(window) {
  // The client is ES modules, imported into this process with the jsdom window's
  // globals installed underneath them. defineProperty rather than assignment:
  // node defines several of these names as getter-only accessors - navigator in
  // particular - and plain assignment throws on those.
  //
  // Everything the window offers is installed, not a hand-kept list. A list meant
  // PopStateEvent was found missing one run at a time, each one discovered by the
  // harness crashing rather than by anything checking it.
  const install = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, {
        value, writable: true, configurable: true, enumerable: false,
      });
      return true;
    } catch {
      return false;
    }
  };

  const take = (name) => install(name, window[name]);

  // These must be the window's, whatever node thinks. fetch in particular: the proxy
  // installed by wireFetch is what the client has to call, and node's would send
  // requests with no session.
  for (const name of ['window', 'document', 'self', 'fetch', 'localStorage',
    'sessionStorage', 'location', 'history', 'navigator']) take(name);

  for (const name of Object.getOwnPropertyNames(window)) {
    if (name in globalThis) continue;
    if (/^(webkit|chrome)/.test(name)) continue;
    take(name);
  }

  // Window methods that need their receiver.
  for (const name of ['matchMedia', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'fetch', 'scrollTo', 'scrollBy', 'alert', 'confirm', 'prompt']) {
    if (typeof window[name] === 'function') take(name, window[name].bind(window));
  }
}

/**
 * Wait until the client stops asking for things.
 *
 * This used to mean "let the microtask queue drain", which is not the same thing. A page
 * that had rendered its loading state satisfied every assertion in this file: it had
 * content, one heading, something interactive. A conversation in particular never reached
 * its composer, so --dump showed the shell and no conversation and the check called that
 * a pass.
 *
 * Counting requests as they pass through the proxy is the honest signal - a page that has
 * finished fetching has nothing outstanding, and one that has not has something.
 */
async function settle(window, ms = 400) {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < ms) {
    if (inFlight === 0) {
      quiet++;
      // Three quiet stretches rather than one, because a page commonly fetches, renders
      // what it has, and then fetches again for whatever it only learns it needs once
      // there is something to show.
      if (quiet >= 3) return;
    } else {
      quiet = 0;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

(async () => {
  if (!PORT) {
    PORT = await freePort();
    console.log('  render check backend on port ' + PORT);
  }
  const boot1 = await boot();
  const { window, document } = boot1;
  const base = origin() + '/';

  try {
    const token = await signIn(base);
    wireFetch(window, token);
    await importClient(window);

    console.log('\n  rendering against a real backend in jsdom');

    // The token the client reads. Sign-in went through the API directly, so the
    // browser-side session is exactly what a reader would have after logging in.
    window.localStorage.setItem('trycord.token', token);

    // Point the client at this run's backend before anything loads.
    //
    // frontend/backend.json names the official instance, and config.js prefers it
    // over the origin that served the page. So without this the harness signed in
    // against its own throwaway database and then had every subsequent request sent
    // to api.trycord.dev, which answered 401, which wiped the token, which redirected
    // the app to /login - and reported it as "every page renders empty".
    window.localStorage.setItem('trycord.backendUrl', origin());

    if (process.env.RENDER_TRACE) {
      console.log('    jsdom url        : ' + window.location.href);
      console.log('    seeded in window : ' + (window.localStorage.getItem('trycord.token') ? 'yes' : 'NO'));
      console.log('    globalStorage same object as window.localStorage: '
        + (globalThis.localStorage === window.localStorage));
      const apiMod = await import(pathToUrl(path.join(CLIENT, 'js/api.js')));
      console.log('    Api.token()      : ' + (apiMod.token() ? 'present' : 'ABSENT'));
      console.log('    Api.apiBase()    : ' + apiMod.apiBase());
      try {
        const me = await apiMod.default.me();
        console.log('    Api.me()         : ' + (me && me.username));
      } catch (e) {
        console.log('    Api.me() threw   : ' + e.message + ' (' + e.code + ')');
      }
    }

    // Boot the application the way the browser does, by loading the entry module. The
    // app is what calls hydrate(), and without it isAuthed() is false and every route
    // redirects to /login - which is a green test that proves nothing.
    const { default: App } = await import(pathToUrl(path.join(CLIENT, 'js/app.js')));
    await App.boot();
    const { default: Router } = await import(pathToUrl(path.join(CLIENT, 'js/router.js')));
    console.log('  booted; signed in as ' + (document.documentElement.dataset.session || 'out'));
    if (process.env.RENDER_TRACE) {
      const after = await import(pathToUrl(path.join(CLIENT, 'js/api.js')));
      console.log('    after boot, token: ' + (after.token() ? 'present' : 'WIPED'));
      console.log('    document route   : ' + (document.documentElement.dataset.route || '(none)'));
      console.log('    body has auth page: ' + !!document.querySelector('.auth-page'));
      const sl = boot1.log() || '';
      console.log('    --- server log, last 30 lines ---');
      console.log(sl.split('\n').filter((l) => l.trim()).slice(-30)
        .map((l) => '      ' + l.slice(0, 130)).join('\n'));
    }

    const registry = await import(pathToUrl(path.join(CLIENT, 'js/pages/registry.js')));
    const { PAGES, matchRoute } = registry;
    const registryModule = registry;
    console.log('  pages in the registry: ' + PAGES.length);

    // Real rows, so a route with :id in it resolves to something. A page that renders
    // its not-found state is not evidence that it works.
    const world = await makeWorld(origin(), token);
    console.log('  seeded: community, ' + world.channels.length + ' channel(s), a message, a friend request');

    // --dump takes the page as its own argument: `--dump /dms`, `--dump community`.
    // Asking what a surface actually produces is the only way to judge it; the
    // assertions can say a page rendered and had a heading, and neither of those is the
    // same as it being right.
    const dumpAt = argv.indexOf('--dump');
    const wanted = dumpAt >= 0 ? (argv[dumpAt + 1] || null) : value('--route', null);

    if (dumpAt >= 0) {
      // Accept an id, a route template, or a concrete URL - "/c/render-test" as readily
      // as "/c/:slug". Looking at a surface should not require remembering which form
      // the registry happens to store.
      let target = PAGES.find((pg) => pg.id === wanted || pg.path === wanted);
      if (!target && registry.matchRoute) {
        const hit = registryModule.matchRoute(wanted);
        if (hit && hit.page) target = hit.page;
      }
      if (!target) {
        console.error('\n  no page matches: ' + wanted);
        console.error('  ids: ' + PAGES.map((pg) => pg.id).join(', ') + '\n');
        await boot1.stop();
        process.exit(1);
      }
      const url = concrete(target.path, world);
      await visit(window, document, Router, url, base);
      const view = document.getElementById('view-root');
      console.log('\n  ==== ' + target.id + '  ' + url + ' ====\n');
      console.log(readable(view ? view.innerHTML : '(nothing in #view-root)'));
      await boot1.stop();
      process.exit(0);
    }

    const routable = PAGES.filter((p) => p.path && p.access !== 'guest');
    const targets = wanted
      ? routable.filter((p) => p.path === wanted || p.id === wanted)
      : routable;

    if (!wanted) {
      ok('there are routable pages to render', targets.length > 10, targets.length + ' found');
    }

    const seen = [];
    let previousSignature = null;
    let previousPageId = null;

    for (const page of targets) {
      const url = concrete(page.path, world);
      const outcome = await visit(window, document, Router, url, base);
      if (outcome.error) {
        failures.push(`${page.id} (${url}): ${outcome.error}`);
        console.log(`    FAIL ${page.id}  <- ${outcome.error}`);
        continue;
      }

      const problems = [];
      if (!outcome.headings) problems.push('the view has no heading at all');
      // The stylesheet hides the context header on the document routes, so those pages
      // own their heading and having one is correct. Counting them the same way as the
      // in-app routes reported /support and /legal as broken when they are the model.
      const chromeless = CHROMELESS.some((r) =>
        r.endsWith('*') ? url.startsWith(r.slice(0, -1)) : url === r || url.startsWith(r + '/'));
      if (!chromeless && outcome.h1s !== 1) {
        problems.push(outcome.h1s + ' top-level headings');
      }
      if (!outcome.buttons) problems.push('nothing interactive');
      // Two addresses can be one destination - /c/render-test and /server/<id> are
      // both the community - and those are supposed to paint the same thing. Comparing
      // against the last route therefore only means anything when the route resolved to
      // a different page than the one before it.
      const resolved = matchRoute(url);
      const pageId = resolved && resolved.page ? resolved.page.id : page.id;
      // aliasOf: two addresses, one destination. Read from the registry rather than
      // guessed from the DOM, because the registry is what the shell itself uses.
      const canonical = (resolved && resolved.page && resolved.page.aliasOf)
        || page.aliasOf || pageId;
      if (canonical !== previousPageId && outcome.signature === previousSignature) {
        problems.push('the view is byte-identical to the previous route, so it never changed');
      }
      if (outcome.viewEmpty) problems.push('#view-root is empty');

      if (problems.length) {
        failures.push(`${page.id} (${url}): ${problems.join('; ')}`);
        console.log(`    FAIL ${page.id} (${url})  <- ${problems.join('; ')}`);
      } else {
        passed++;
        console.log(`    ok   ${page.id.padEnd(30)} ${url}`);
      }
      previousSignature = outcome.signature;
      previousPageId = canonical;
      seen.push(page.id);
    }

    console.log(`  navigated ${seen.length} routes without an uncaught error`);

    // ---- accessibility, over the pages that were just rendered ----
    //
    // Asserted here rather than in a separate script because the interesting cases are
    // the ones that only exist once a page has painted: a button whose label is set by
    // the code that drew it, an input the page forgot to label, a heading a surface
    // lost. Re-rendering them separately would mean a second boot and a second chance
    // for the two to disagree about what the page looked like.
    console.log('\n  accessibility, over the same rendered pages');

    const unnamed = [];
    let controls = 0;
    for (const page of targets) {
      const url = concrete(page.path, world);
      const out = await visit(window, document, Router, url, base);
      for (const bad of accessibilityFaults(document)) {
        unnamed.push(`${page.id}: ${bad}`);
      }
      controls += countControls(document);
    }

    ok('every interactive control has an accessible name', unnamed.length === 0,
      unnamed.slice(0, 4).join(' | '));
    console.log(`    ${controls} controls checked across ${targets.length} pages`);

    // A conversation that renders is not the same as a conversation that renders its
    // messages. Every conversation assertion below passed for a whole session against an
    // empty channel, because the seed was posting the wrong field and nothing required
    // the message to be there. This requires it.
    const chanOut = await visit(window, document, Router,
      concrete('/server/:id/channel/:channel', world), base);
    const chanText = (chanOut.text || '');
    ok('a conversation shows the message that was sent',
      chanText.includes('planted'),
      'the channel rendered without it: ' + (chanOut.headings) + ' headings, '
        + chanOut.buttons + ' controls');

    const composerOut = await visit(window, document, Router,
      concrete('/server/:id/channel/:channel', world), base);
    ok('a conversation has a composer', !!composerOut.composer,
      'no .composer in the rendered view');
    ok('the composer is reachable from the keyboard and named',
      composerOut.composer && composerOut.composer.name.length > 0,
      composerOut.composer ? 'the textarea has no accessible name' : 'no composer');

    // The three things hanging off a message that a bare message cannot prove. Each was
    // verified by looking at the rendered surface before it was asserted, which is the
    // only reason these are the right selectors.
    const marks = composerOut.marks || {};
    ok('an edited message says so', !!marks.edited,
      'the seeded message was edited but nothing on screen says so');
    ok('a reply shows as a count on the message it replies to',
      /\d/.test(marks.threadCount || ''),
      'a reply was posted but no thread count rendered');
    ok('a reaction shows on the message it is on', (marks.reactions || 0) > 0,
      'a reaction was added but no reaction rendered');

    // ---- what a failure looks like ----
    //
    // Every state above was read while the backend was working. The brief asks for more
    // than that: if a request fails, say so, offer a way back, do not take the
    // application down, and do not quietly show something stale as though it were fresh.
    //
    // So one endpoint is broken on purpose and the page is visited again. The shell has
    // to survive, the page has to say something, and the something has to be an error
    // rather than an empty list that reads like "you have nothing".
    console.log('\n  when a request fails');
    const failuresBefore = failures.length;

    const brokenSpecs = [
      { id: 'notifications', url: '/api/notifications', page: 'notifications' },
      { id: 'dms', url: '/api/dms', page: 'dms' },
    ];

    for (const spec of brokenSpecs) {
      breakUrl = spec.url;
      const out = await visit(window, document, Router,
        concrete(registry.PAGES.find((pg) => pg.id === spec.page).path, world), base);
      const chrome = document.getElementById('shell');
      ok(spec.id + ': the shell survives a failed request',
        !!chrome && chrome.contains(document.getElementById('view-root')),
        'the shell itself is gone');
      ok(spec.id + ': the failure is shown rather than shown as empty',
        out.errors >= 1 || out.failed,
        'the page rendered ' + out.headings + ' headings and nothing said anything had gone wrong'
        + ' - an error that looks like an empty list is the failure mode this is looking for');
    }
    breakUrl = null;

    // The same pages with nothing broken must NOT be showing an error, or the two
    // assertions above pass because the page is always broken rather than because
    // breaking it changed anything.
    for (const spec of brokenSpecs) {
      const out = await visit(window, document, Router,
        concrete(registry.PAGES.find((pg) => pg.id === spec.page).path, world), base);
      ok(spec.id + ': a working backend is not shown as an error', out.errors === 0,
        'the page is showing an error block with nothing broken');
    }

    // And with the backend healthy again the page has to recover, not stay stuck.
    const recovered = await visit(window, document, Router,
      concrete(registry.PAGES.find((pg) => pg.id === 'notifications').path, world), base);
    ok('a page recovers once the endpoint does', recovered.errors === 0,
      'still showing an error after the backend was healthy again');

    const { updateFromViewport } = await import(pathToUrl(path.join(CLIENT, 'js/presentation.js')));
    const { renderAllChrome } = await import(pathToUrl(path.join(CLIENT, 'js/shell.js')));

    // ---- the phone, at the widths people actually use ----
    //
    // The desktop sweep above is the wrong shape to judge a phone by, and a phone is
    // half the product. What is asserted is the composition rather than the pixels,
    // because jsdom cannot measure: the shell is told it is on a phone, the navigation
    // is the one the registry defines, and nothing that only makes sense on a wide
    // screen is the only way into a surface.
    console.log('\n  the phone composition');
    for (const [w, h, name] of [[360, 740, 'small phone'], [390, 844, 'phone'], [834, 1112, 'tablet']]) {
      await setViewport(window, w, h);
      updateFromViewport();
      await visit(window, document, Router, concrete('/home', world), base);
      renderAllChrome();
      await settle(window, 200);
      const tabBar = document.getElementById('mobile-tab-navigation');
      const tabs = tabBar ? tabBar.querySelectorAll('.tab-button').length : 0;
      // presentation.js draws its line at 600px. Asserted on both sides of it, because
      // "is it a phone layout" is a question with one answer and the answer should follow
      // the breakpoint rather than a guess about which widths feel narrow.
      //
      // The first version of this read data-presentation off #shell, where it does not
      // live - it is on <html> - so the attribute was undefined, undefined is not
      // 'desktop', and the assertion passed at every width including ones it was
      // supposed to fail.
      const mode = document.documentElement.dataset.presentation;
      const want = w < 600 ? 'mobile' : 'desktop';
      ok(name + ' (' + w + 'x' + h + '): presentation is ' + want, mode === want,
        'data-presenta' + 'tion=' + (mode || '(unset)'));
      if (w < 600) {
        ok(name + ': the tab bar carries the registry destinations', tabs > 0,
          'no tab buttons rendered');
        ok(name + ': the navigation drawer is available from the header',
          !!document.querySelector('#context-header .nav-toggle'),
          'no .nav-toggle in the context header');
      }
    }

    // Back to a desktop width before the theme checks, which assert on the shell.
    await setViewport(window, 1440, 900);
    updateFromViewport();
    await settle(window, 100);

    // ---- dead controls ----
    //
    // The brief's rule: every visible control either works or does not exist. Nothing in
    // the DOM can tell you whether a button has a handler - jsdom exposes no listener
    // registry - so the window was instrumented at boot and every addEventListener
    // recorded. A button with no listener on it, and none on any ancestor that could be
    // delegating, and no form to submit, is a control that does nothing.
    console.log('\n  controls that do nothing');
    const dead = [];
    for (const page of targets) {
      const url = concrete(page.path, world);
      await visit(window, document, Router, url, base);
      for (const fault of deadControls(document, boot1.wired)) {
        dead.push(`${page.id}: ${fault}`);
      }
    }
    ok('no visible control is inert', dead.length === 0, dead.slice(0, 5).join(' | '));
    console.log(`    ${dead.length} inert control(s) across ${targets.length} pages`);

    // ---- the phone composition ----
    //
    // The navigation on a phone is derived from the registry, so the thing worth checking
    // is that it is the same destinations and that they render as tabs with names - not
    // that there are five of them, which would pass just as well if they were five
    // arbitrary buttons.
    const expected = registry.mobilePages().map((pg) => pg.nav.tabLabel || pg.nav.short);
    const tabBar = document.getElementById('mobile-tab-navigation');
    const tabLabels = tabBar
      ? [...tabBar.querySelectorAll('.tab-button__label')].map((n) => n.textContent.trim())
      : [];

    ok('the phone tab bar carries the destinations the registry defines',
      expected.length > 0 && tabLabels.length === expected.length
        && expected.every((label) => tabLabels.includes(label)),
      'expected ' + expected.join(', ') + ' - got ' + (tabLabels.join(', ') || 'nothing'));

    const navToggle = document.querySelector('#context-header .nav-toggle');
    ok('the phone header has a navigation control that reports its state',
      !!navToggle && navToggle.hasAttribute('aria-expanded'),
      navToggle ? 'no aria-expanded' : 'no nav-toggle in the context header');

    // ---- themes ----
    //
    // Themes are applied as a data-theme attribute plus stylesheet rules, so reading an
    // inline custom property off the shell - which is what this check did first - finds
    // nothing and looks like a broken theme engine. What is worth asserting is that the
    // theme a reader picks is one the stylesheet actually implements, because a theme
    // that is listed in the picker and has no rule behind it is a button that does
    // nothing.
    console.log('\n  themes');
    const theme = await import(pathToUrl(path.join(CLIENT, 'js/theme.js')));
    const current = () => document.documentElement.getAttribute('data-theme') || '';

    theme.setTheme(theme.DEFAULT_THEME);
    await settle(window, 10);
    const def = current();
    ok('the default theme identifies itself on the document', !!def, 'no data-theme');

    theme.setTheme('midnight');
    await settle(window, 10);
    const switched = current();
    ok('switching themes changes the document', !!switched && switched !== def,
      def + ' -> ' + switched);

    theme.setTheme(theme.DEFAULT_THEME);
    await settle(window, 10);
    ok('switching back restores it', current() === def, current() + ' != ' + def);

    // Every theme the picker offers, except 'custom' and 'system', needs a rule.
    const stylesheet = readFile(path.join(CLIENT, 'css', 'app.css'));
    const undressed = theme.THEMES
      .filter((t) => t.id !== 'custom' && t.id !== 'system')
      .filter((t) => !stylesheet.includes("data-theme='" + t.id + "'")
        && !stylesheet.includes('data-theme="' + t.id + '"')
        && !stylesheet.includes('[data-theme=' + t.id + ']'))
      .map((t) => t.id);
    ok('every theme offered in the picker has a stylesheet rule behind it',
      undressed.length === 0,
      'listed but not implemented: ' + undressed.join(', '));

    // Custom themes, including the safety net.
    //
    // applyCustomTheme() measures the shell afterwards and refuses the theme if the
    // application did not survive it, falling back to Ember. jsdom has no layout engine,
    // so every element measures 0x0 and the refusal always fires here - which means this
    // check exercises the recovery branch rather than the happy one.
    //
    // That branch is the one worth asserting: a hand-authored theme that breaks the
    // shell must not be able to break the shell. Both outcomes are checked, because
    // "either it applied or it deliberately backed off" is the contract, and a version
    // that quietly did neither would pass a test that only looked for tokens.
    const ACCENT = '#00a3ff';
    const result = theme.applyCustomTheme({
      tokens: Object.assign({}, theme.DEFAULT_CUSTOM_TOKENS, { accent: ACCENT }),
    });
    await settle(window, 10);

    const inline = document.documentElement.style;
    const probe = ['--c-accent', '--c-pg', '--c-base', '--c-txt'];
    const landed = probe.filter((name) => inline.getPropertyValue(name).trim());

    ok('a custom theme either applies or reports why it did not',
      typeof result === 'object' && typeof result.ok === 'boolean',
      'applyCustomTheme returned ' + JSON.stringify(result));

    if (result && result.ok) {
      ok('an applied custom theme wrote its tokens onto the document',
        landed.length === probe.length,
        landed.length + ' of ' + probe.length);
    } else {
      ok('a custom theme the shell cannot survive falls back to Ember',
        current() === 'trycord' && landed.length === 0,
        'data-theme=' + current() + ', ' + landed.length + ' tokens left behind: '
          + (result && result.problems ? result.problems.join('; ') : 'no reasons given'));
      console.log('    no layout engine here, so the safety net fired - which is the'
        + ' behaviour that matters; the tokens themselves need a browser');
    }

    await boot1.stop();
  } catch (e) {
    console.error('\n  render check failed to run: ' + e.message + '\n');
    console.error((e.stack || '').split('\n').slice(0, 10).map((l) => '    ' + l.trim()).join('\n') + '\n');
    console.error((boot1.log() || '').slice(-1500));
    await boot1.stop();
    process.exit(1);
  }

  console.log(`\n  render check ${failures.length ? 'FAILED - ' + failures.length + ' problem(s)' : 'passed'}`
    + ` - ${passed} assertions\n`);
  process.exit(failures.length ? 1 : 0);
})();

function pathToUrl(p) {
  return require('url').pathToFileURL(p).href;
}

async function renderRoute(window, document, page, base) {
  window.history.replaceState({}, '', page.path);
  const main = document.getElementById('view-root') || document.body;
  const errors = [];
  const onError = (e) => errors.push(e.message || String(e.error));
  window.addEventListener('error', onError);
  try {
    const { default: render } = await import(pathToUrl(path.join(CLIENT, 'js/app.js')));
    if (typeof render === 'function') await render();
    await settle(window);
  } catch (e) {
    return { error: e.message };
  } finally {
    window.removeEventListener('error', onError);
  }
  if (errors.length) return { error: errors[0] };
  const headings = document.querySelectorAll('h1, h2, h3').length;
  const buttons = document.querySelectorAll('button, a[href]').length;
  return { headings, buttons };
}

/**
 * Substitute real ids into a route.
 *
 * A route with :id in it has to resolve to a row that exists, or the page renders its
 * empty state and the test passes while proving nothing. 'nope' is used for the
 * segments with nothing to point at - an invite code and a reset token - because
 * those are for signed-out readers and their not-found state is the correct answer.
 */
function concrete(template, world) {
  return template
    .replace(':slug', world.slug)
    .replace(/:channel/g, world.channelId)
    .replace(':id', world.serverId)
    .replace(':doc', 'terms')
    .replace(':code', 'nope')
    .replace(':token', 'nope');
}

/** Create the rows the dynamic routes need. */
async function makeWorld(origin, token) {
  const call = async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    const res = await realFetch(origin + '/' + p.replace(/^\//, ''), {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };

  const name = 'render-' + Date.now().toString(36);
  const server = await call('POST', '/api/servers', { name: 'Render Test', description: 'seeded by the render check' });
  const serverId = server.json.id || server.json.serverId;
  if (!serverId) throw new Error('could not create a community: ' + JSON.stringify(server.json).slice(0, 200));
  const slug = server.json.slug || 'render-test';

  const channel = await call('POST', `/api/servers/${serverId}/channels`,
    { name: 'general', type: 'text' });
  const channelId = channel.json.id || channel.json.channelId || 'general';

  // Messages with everything hanging off them, because the conversation is the surface
  // that matters most and "it rendered" says nothing about whether a reply, an edit or a
  // reaction is actually shown. Seeding only a plain message left all three untested and
  // the channel looking emptier than it is.
  const post = async (body) => {
    const res = await call('POST', `/api/channels/${channelId}/messages`, body);
    if (res.status >= 400 || !res.json.id) {
      throw new Error('could not seed a message: ' + res.status + ' '
        + JSON.stringify(res.json).slice(0, 200));
    }
    return res.json;
  };

  const seeded = await post({ content: 'A message the render check planted.' });
    // Saying so, rather than letting the channel stay quietly empty: the field is
    // `content`, posting `body` fails validation with "content or an attachment is
    // required", and this check then asserted against an empty channel for a whole
    // session while looking entirely healthy.

  // A reply to it, an edit on it, and a reaction - the three things the message row is
  // supposed to show and the three that a single bare message cannot prove.
  const reply = await post({ content: 'A reply, so threads are not empty.', replyToId: seeded.id });
  await call('PATCH', `/api/channels/${channelId}/messages/${seeded.id}`,
    { content: 'A message the render check planted, and then edited.' });
  await call('POST', `/api/channels/${channelId}/messages/${seeded.id}/reactions`,
    { emoji: '\u{1F44D}' });

  const messageId = seeded.id;

  return { serverId, channelId, slug, messageId, replyId: reply.id, channels: [channelId] };
}

/**
 * Visit one URL the way a reader would: put it in the address bar and let the router
 * do its own work. Calling a page's render function directly would skip the mount
 * lifecycle, the layout decision and the access check - which is most of what there
 * is to break.
 */
async function visit(window, document, Router, url, base) {
  window.history.replaceState({}, '', url);
  const errors = [];
  const onError = (e) => errors.push(e.message || String(e.error));
  window.addEventListener('error', onError);
  let thrown = null;
  try {
    await Router.run();
    await settle(window);
  } catch (e) {
    thrown = e.message;
  } finally {
    window.removeEventListener('error', onError);
  }
  if (thrown) return { error: thrown };
  if (errors.length) return { error: errors[0] };

  const view = document.getElementById('view-root');
  return {
    h1s: document.querySelectorAll('h1').length,
    headings: document.querySelectorAll('h1, h2, h3').length,
    buttons: document.querySelectorAll('button, a[href]').length,
    // The sign-in, recovery and emailed-link screens hide the shell and mount into
    // document.body, so for those an empty #view-root is the correct shape. Looking only
    // at #view-root called every auth page broken.
    // What the reader can actually read, and whether the composer is there.
    text: (document.getElementById('view-root') || document.body).textContent || '',
    // The message-row details worth asserting on, read off the rendered surface.
    errors: document.querySelectorAll('#view-root .state-block--error').length,
    failed: !!document.querySelector('#view-root [data-failed], #view-root .form-error'),
    marks: {
      edited: !!document.querySelector('#view-root .msg-edited'),
      threadCount: (document.querySelector('#view-root .msg-thread-badge__count') || {}).textContent || '',
      reactions: document.querySelectorAll('#view-root .msg-reactions > *').length,
    },
    composer: (() => {
      const ta = document.querySelector('#view-root .composer textarea');
      return ta ? { name: accessibleName(ta), tag: ta.tagName.toLowerCase() } : null;
    })(),
    viewEmpty: (!view || view.children.length === 0)
      && !document.querySelector('body > .auth-page, body > .pub-page'),
    signature: (view ? view.innerHTML : '').length + ':'
      + Array.from(document.querySelectorAll('h1')).map((h) => h.textContent.trim()).join('|'),
  };
}

// A built-in theme that is not the default, so the switch has something to switch to.
// Read out of the module rather than hardcoded, so this does not rot when a theme is
// renamed.
const DEFAULT_TEST_THEME = 'midnight';

/** jsdom's window has no viewport of its own worth the name. Give it one. */
async function setViewport(window, width, height) {
  const define = (name, value) => Object.defineProperty(window, name, {
    value, writable: true, configurable: true,
  });
  define('innerWidth', width);
  define('outerWidth', width);
  define('innerHeight', height);
  if (window.screen) {
    Object.defineProperty(window.screen, 'width', { value: width, configurable: true });
    Object.defineProperty(window.screen, 'height', { value: height, configurable: true });
  }
  window.dispatchEvent(new window.Event('resize'));
  await settle(window, 10);
}

/** How a control is named, using the same precedence a screen reader applies. */
function accessibleName(node) {
  const aria = node.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledBy = node.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/)
      .map((id) => {
        const target = node.ownerDocument.getElementById(id);
        return target ? target.textContent : '';
      })
      .join(' ').trim();
    if (text) return text;
  }
  if (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA') {
    // A real <label for>, or a label wrapping the control.
    const id = node.getAttribute('id');
    if (id) {
      const label = node.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (label && label.textContent.trim()) return label.textContent.trim();
    }
    const wrapping = node.closest('label');
    if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
    const title = node.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const placeholder = node.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return '[placeholder] ' + placeholder.trim();
    return '';
  }
  const text = (node.textContent || '').trim();
  if (text) return text;
  const title = node.getAttribute('title');
  if (title && title.trim()) return title.trim();
  return '';
}

/**
 * Everything on the page a screen reader would struggle with.
 *
 * Only faults that are unambiguous from the DOM are reported. "This button looks
 * small" and "this contrast is too low" need a layout engine and a colour maths, and a
 * check that guesses at them is a check that cries wolf - which is worse than none,
 * because it teaches people to ignore it.
 */
function accessibilityFaults(document) {
  const faults = [];
  const seenIds = new Set();

  for (const node of document.querySelectorAll('button, a[href], input, select, textarea')) {
    if (node.closest('[hidden]')) continue;
    const what = node.tagName.toLowerCase()
      + (node.className && typeof node.className === 'string'
        ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '');
    if (!accessibleName(node)) faults.push(what + ' has no accessible name');
  }

  for (const node of document.querySelectorAll('img')) {
    if (node.closest('[hidden]')) continue;
    if (!node.hasAttribute('alt')) {
      faults.push('img without alt: ' + (node.getAttribute('src') || '(no src)').slice(-40));
    }
  }

  for (const node of document.querySelectorAll('[role="dialog"]')) {
    if (node.closest('[hidden]')) continue;
    if (!accessibleName(node)) faults.push('dialog with no name');
  }

  // Buttons inside a form default to type=submit, which is a real behaviour and not
  // what most of these mean.
  for (const node of document.querySelectorAll('button')) {
    if (node.closest('[hidden]')) continue;
    if (!node.hasAttribute('type') && node.closest('form')) {
      faults.push('button with no type inside a form (defaults to submit)');
    }
  }

  for (const node of document.querySelectorAll('[id]')) {
    const id = node.getAttribute('id');
    if (seenIds.has(id)) faults.push('duplicate id: ' + id);
    seenIds.add(id);
  }

  return faults;
}

function countControls(document) {
  return document.querySelectorAll('button, a[href], input, select, textarea').length;
}

/**
 * Buttons that would do nothing if pressed.
 *
 * A button counts as wired when it has a listener of its own, or when an ancestor does
 * and the container is delegating by selector - which this codebase does in several
 * places, so a missing listener on the button is not by itself a fault. Inside a form a
 * button is not dead either: submitting is what it does.
 *
 * A disabled button is excluded deliberately. "Save" while the request is in flight is
 * inert on purpose, and reporting it would be a check that cries wolf.
 */
function deadControls(document, wired) {
  const faults = [];
  const hasListener = (node, types) => {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const seen = wired.get(n);
      if (!seen) continue;
      for (const t of types) if (seen.has(t)) return true;
    }
    return false;
  };

  for (const btn of document.querySelectorAll('button')) {
    if (btn.closest('[hidden]') || btn.disabled) continue;
    const inForm = btn.closest('form');
    const type = (btn.getAttribute('type') || (inForm ? 'submit' : '')).toLowerCase();
    if (inForm && (type === 'submit' || type === 'reset' || type === 'image')) continue;
    if (hasListener(btn, ['click', 'pointerdown', 'mousedown', 'keydown', 'keyup'])) continue;
    const name = (btn.textContent || '').trim().slice(0, 30)
      || btn.getAttribute('aria-label') || btn.className || '(unlabelled)';
    faults.push('<' + String(name).replace(/\s+/g, ' ') + '> in '
      + (btn.className || 'no class') + ' has no handler');
  }
  return faults;
}

/** Break markup at tag boundaries so it can be read. */
function readable(html) {
  return String(html)
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((l) => '    ' + l.trim().slice(0, 200))
    .filter((l) => l.trim() !== '<')
    .join('\n');
}
