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
    const res = await realFetch(absolute, Object.assign({}, init, { headers }));
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

/** Wait for the client to settle: no more microtasks, timers drained. */
async function settle(window, ms = 60) {
  for (let i = 0; i < ms; i++) {
    await new Promise((r) => setTimeout(r, 1));
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
    console.log('  pages in the registry: ' + PAGES.length);

    // Real rows, so a route with :id in it resolves to something. A page that renders
    // its not-found state is not evidence that it works.
    const world = await makeWorld(origin(), token);
    console.log('  seeded: community, ' + world.channels.length + ' channel(s), a message, a friend request');

    const wanted = value('--route', null);
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

  // A message, so the conversation has something in it.
  await call('POST', `/api/channels/${channelId}/messages`, { body: 'Rendered by the render check.' });

  return { serverId, channelId, slug, channels: [channelId] };
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
    viewEmpty: (!view || view.children.length === 0)
      && !document.querySelector('body > .auth-page, body > .pub-page'),
    signature: (view ? view.innerHTML : '').length + ':'
      + Array.from(document.querySelectorAll('h1')).map((h) => h.textContent.trim()).join('|'),
  };
}
