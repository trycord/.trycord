#!/usr/bin/env node
'use strict';

// Render the Mobile module in a real DOM, against a real backend.
//
// check-render.js does this for the Desktop module: jsdom loads index.html, the
// real modules are imported into it, fetch is proxied to a throwaway backend, and
// every registered page is visited and measured. Until this file existed, the
// Mobile module was checked by parsing it (check-client-modules), by importing it
// against stubs (check-client-load), and by reading its stylesheet (check-client-
// styles) - none of which run a renderer. A mobile view that throws at mount, or
// that paints an empty screen because it read the wrong field, passed all of them.
//
// The two modules share the platform packages and nothing else, so this is a
// second entry document, a second entry module and a second shell - a second
// check is the honest cost of that.
//
//   node scripts/check-mobile-render.js               every registered page
//   node scripts/check-mobile-render.js --route /home  one route
//   node scripts/check-mobile-render.js --dump /home   print the DOM of one route
//
// jsdom is a test-only dependency: npm install --no-save jsdom

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, '..', 'frontend');

// The mount the Mobile module is served under. The desktop module sits at the
// origin root in this harness; the mobile entry is one directory deeper, which is
// what its own base and its own setBase() describe. Kept as one constant so a
// change to the mount is a one-line change here rather than a dozen URLs.
const MOUNT = '/mobile';

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
let recording = false;
let requestLog = [];

let PORT = Number(process.env.RENDER_PORT || 0);
const origin = () => `http://127.0.0.1:${PORT}`;

// The registry and nav modules, imported once the DOM is up so visit() can resolve
// what a final address means without a second import graph.
let REG = null;
let NAV = null;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (f, fallback) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.error('\n  check-mobile-render needs jsdom: npm install --no-save jsdom\n');
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

function readFile(p) { return fs.readFileSync(p, 'utf8'); }
function pathToUrl(p) { return require('url').pathToFileURL(p).href; }

/** Boot a throwaway backend and a jsdom window serving the Mobile entry. */
async function boot() {
  const dbDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trycord-mobile-'));
  const env = {
    ...process.env,
    DB_CLIENT: 'sqlite',
    TRYCOD_DB_ENV_ONLY: '1',
    DB_FILE: path.join(dbDir, 'mobile.db'),
    PORT: String(PORT),
    HOST: '127.0.0.1',
    UPLOAD_DIR: path.join(dbDir, 'uploads'),
    STORAGE_DRIVER: 'local',
    MAIL_MODE: 'log',
    ALLOW_TEST_HOOKS: 'true',
    JWT_SECRET: 'mobile-render-secret-0123456789abcdef',
    // The admin surfaces are registered like any other page; without a platform
    // administrator they render a redirect and every assertion about them
    // measures nothing.
    ADMIN_USERNAMES: 'mobileuser',
  };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;

  const child = require('child_process').spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

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
    throw new Error('the mobile render check could not start its own backend on '
      + origin() + '.\nServer said:\n' + log.slice(-1200));
  }

  // The document is loaded at its real address so that <base> and the relative
  // stylesheet resolve the way they do in production. The modules are imported
  // from disk (file://) because the harness runs them in Node; see importClient.
  const dom = new JSDOM(readFile(path.join(CLIENT, 'mobile', 'index.html')), {
    url: origin() + MOUNT + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

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

const realFetch = globalThis.fetch;

function postJSON(url, payload, token) {
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

const base = () => origin() + '/';

async function signIn() {
  const creds = {
    username: 'mobileuser',
    email: 'mobile@example.com',
    password: 'correct-horse-battery-staple',
    displayName: 'Mobile User',
    termsVersion: '1.0',
    privacyVersion: '1.0',
  };
  let res = await postJSON(base() + 'api/auth/register', creds);
  if (res.status !== 200 || !res.json.token) {
    res = await postJSON(base() + 'api/auth/login', {
      username: creds.username, password: creds.password,
    });
  }
  if (!res.json.token) throw new Error('could not sign in: ' + JSON.stringify(res.json).slice(0, 200));
  await postJSON(base() + 'api/test/self-verify', {}, res.json.token);
  return res.json.token;
}

/** Seed the rows the dynamic routes need, and return their ids. */
async function makeWorld(token) {
  const call = async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    const res = await realFetch(origin() + '/' + p.replace(/^\//, ''), {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };

  const me = await call('GET', '/api/users/me');
  const userId = me.json.id || me.json.userId;

  const server = await call('POST', '/api/servers',
    { name: 'Mobile Render', description: 'seeded by the mobile render check' });
  const serverId = server.json.id || server.json.serverId;
  if (!serverId) throw new Error('could not create a community: ' + JSON.stringify(server.json).slice(0, 200));
  const slug = server.json.slug || 'mobile-render';

  const channel = await call('POST', `/api/servers/${serverId}/channels`, { name: 'general', type: 'text' });
  const channelId = channel.json.id || channel.json.channelId || 'general';

  const message = await call('POST', `/api/channels/${channelId}/messages`,
    { content: 'A message the mobile render check planted.' });
  if (message.status >= 400 || !message.json.id) {
    throw new Error('could not seed a message: ' + message.status + ' '
      + JSON.stringify(message.json).slice(0, 200));
  }

  return { userId, serverId, channelId, slug, messageId: message.json.id };
}

/** Substitute real ids into a route template. */
function concrete(template, world) {
  if (!template) return '';
  let out = template
    .replace(':slug', world.slug)
    .replace(/:channel/g, world.channelId)
    .replace(':doc', 'terms')
    .replace(':code', 'nope')
    .replace(':token', 'nope');
  // /users/:id is a person; every other :id is a community. One substitution per
  // route, so a profile does not try to load a community as a user.
  if (out.startsWith('/users/')) return out.replace(':id', world.userId);
  return out.replace(':id', world.serverId);
}

/** Install the jsdom window's globals so the real modules run against this DOM. */
async function importClient(window) {
  const install = (name, val) => {
    try {
      Object.defineProperty(globalThis, name, {
        value: val, writable: true, configurable: true, enumerable: false,
      });
      return true;
    } catch { return false; }
  };
  const take = (name) => install(name, window[name]);

  for (const name of ['window', 'document', 'self', 'fetch', 'localStorage',
    'sessionStorage', 'location', 'history', 'navigator']) take(name);
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name in globalThis) continue;
    if (/^(webkit|chrome)/.test(name)) continue;
    take(name);
  }
  for (const name of ['matchMedia', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'scrollTo', 'scrollBy', 'alert', 'confirm', 'prompt']) {
    if (typeof window[name] === 'function') install(name, window[name].bind(window));
  }
}

/** Install fetch in the jsdom window, proxying to this run's backend only. */
function wireFetch(window, token) {
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.includes(String(PORT))) {
      throw new Error('the mobile render check refused a request to ' + url
        + ' - it only talks to its own backend on port ' + PORT);
    }
    const absolute = url.startsWith('http') ? url : origin() + (url.startsWith('/') ? url : '/' + url);
    const headers = Object.assign({}, (init && init.headers) || {});
    headers.Authorization = 'Bearer ' + token;
    if (recording) requestLog.push({ method: (init && init.method) || 'GET', path: absolute, at: Date.now() });
    inFlight++;
    try {
      return await realFetch(absolute, Object.assign({}, init, { headers }));
    } finally {
      inFlight--;
    }
  };
}

async function settle(window, ms = 400) {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < ms) {
    if (inFlight === 0) {
      quiet++;
      if (quiet >= 3) return;
    } else {
      quiet = 0;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Visit a route the way a reader would: put it in the address bar and run. */
async function visit(window, document, run, url) {
  window.history.replaceState({}, '', MOUNT + url);
  const errors = [];
  const onError = (e) => errors.push(e.message || String(e.error));
  window.addEventListener('error', onError);
  let thrown = null;
  try {
    await run();
    await settle(window);
  } catch (e) {
    thrown = e.message;
  } finally {
    window.removeEventListener('error', onError);
  }
  if (thrown) return { error: thrown };
  if (errors.length) return { error: errors[0] };

  const view = document.getElementById('m-view');
  const raw = document.documentElement.dataset.raw === 'true';
  // The Mobile shell carries the page title in its app bar rather than in an <h1>
  // inside the view: a phone has one line at the top and the title belongs there.
  // So "does this page say what it is" is the app bar's name, not a heading count.
  const appbarName = document.querySelector('#m-shell .m-appbar__name');
  const resolved = REG ? REG.matchRoute(NAV ? NAV.currentRoute() : window.location.pathname) : null;
  return {
    headings: document.querySelectorAll('h1, h2, h3').length,
    h1s: document.querySelectorAll('h1').length,
    buttons: document.querySelectorAll('button, a[href]').length,
    // A raw screen (sign-in, the public documents) is placed beside the hidden
    // shell, so its text is the body's, not the view's.
    text: raw ? (document.body.textContent || '') : ((view || document.body).textContent || ''),
    appBarTitle: appbarName ? (appbarName.textContent || '').trim() : '',
    resolvedId: resolved && resolved.page ? (resolved.page.aliasOf || resolved.page.id) : null,
    viewEmpty: !raw && (!view || view.children.length === 0),
    raw,
    composer: (() => {
      const host = document.getElementById('m-composer');
      return host && !host.hidden ? host : null;
    })(),
    faultOrigin: (() => {
      const n = document.querySelector('#m-view [data-fault-origin]');
      return n ? n.getAttribute('data-fault-origin') : null;
    })(),
    activeSeg: (() => {
      const n = document.querySelector('#m-view .m-seg__item.is-active');
      return n ? (n.textContent || '').trim() : null;
    })(),
    signature: (() => {
      // Content-based, not length-based: two different screens can be the same size,
      // and the settings sections differ only by which segment is active and what the
      // host holds. A hash of the view's HTML catches both.
      const html = view ? view.innerHTML : '';
      let hash = 0;
      for (let i = 0; i < html.length; i++) hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
      const headings = Array.from(document.querySelectorAll('h1')).map((h) => h.textContent.trim()).join('|');
      return html.length + ':' + (hash >>> 0) + ':' + headings;
    })(),
  };
}

// ---- accessibility, using the same precedence a screen reader applies ----------

function accessibleName(node) {
  const aria = node.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledBy = node.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => {
      const t = node.ownerDocument.getElementById(id);
      return t ? t.textContent : '';
    }).join(' ').trim();
    if (text) return text;
  }
  if (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA') {
    const id = node.getAttribute('id');
    if (id) {
      const label = node.ownerDocument.querySelector('label[for="' + id + '"]');
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

function accessibilityFaults(document) {
  const faults = [];
  const seenIds = new Set();
  for (const node of document.querySelectorAll('button, a[href], input, select, textarea')) {
    if (node.closest('[hidden]')) continue;
    if (!accessibleName(node)) {
      faults.push(node.tagName.toLowerCase()
        + (node.className && typeof node.className === 'string'
          ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
        + ' has no accessible name');
    }
  }
  for (const node of document.querySelectorAll('img')) {
    if (node.closest('[hidden]')) continue;
    if (!node.hasAttribute('alt')) {
      faults.push('img without alt: ' + (node.getAttribute('src') || '(no src)').slice(-40));
    }
  }
  for (const node of document.querySelectorAll('[id]')) {
    const id = node.getAttribute('id');
    if (seenIds.has(id)) faults.push('duplicate id: ' + id);
    seenIds.add(id);
  }
  return faults;
}

// ---- the run ---------------------------------------------------------------

(async () => {
  if (!PORT) {
    PORT = await freePort();
    console.log('  mobile render check backend on port ' + PORT);
  }
  const boot1 = await boot();
  const { window, document } = boot1;

  try {
    const token = await signIn();

    // The world is seeded before the entry module boots, and this ordering is the
    // whole reason the check works. Boot loads the session and then the server list,
    // and `can()`/`isOwner()` read the servers the list returned. A community created
    // after boot is not in that list, so every administrative screen would take its
    // permission guard and render "Not your call" - a green check over a page that
    // never drew. makeWorld talks to the backend directly, so it does not need the
    // window's fetch to be wired yet.
    const world = await makeWorld(token);
    console.log('  seeded: a community, a channel and a message');

    wireFetch(window, token);
    await importClient(window);

    console.log('\n  rendering the Mobile module against a real backend in jsdom');

    // The token and the backend the client reads. Set before the entry module is
    // imported, or boot signs in against the official instance.
    window.localStorage.setItem('trycord.token', token);
    window.localStorage.setItem('trycord.backendUrl', origin());

    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    recording = true;
    requestLog = [];
    let App = null;
    let importError = null;
    try {
      App = await import(pathToUrl(path.join(CLIENT, 'mobile', 'js', 'main.js')));
    } catch (e) {
      importError = e;
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    let bootError = importError;
    if (App && App.ready) {
      await App.ready.then(() => {}, (e) => { if (!bootError) bootError = e; });
    }
    if (!bootError && unhandled.length) bootError = unhandled[0];
    recording = false;

    ok('the Mobile entry boots without throwing', !bootError,
      bootError ? (bootError.name + ': ' + bootError.message) : '');

    if (bootError) {
      console.error('\n  the boot failed; the rest of the check cannot run\n');
      console.error((boot1.log() || '').slice(-1500));
      await boot1.stop();
      process.exit(1);
    }

    // The Mobile module's base is its own module directory. Imported from file://
    // that directory cannot be read out of the URL (file: is not a mount), so the
    // harness sets it explicitly to the mount the document is served under. This
    // is the same call main.js makes, given the value the server would have let it
    // derive.
    const nav = await import(pathToUrl(path.join(CLIENT, 'packages', 'nav.js')));
    nav.setBase(MOUNT);
    const { run } = await import(pathToUrl(path.join(CLIENT, 'mobile', 'js', 'router.js')));

    const registry = await import(pathToUrl(path.join(CLIENT, 'packages', 'registry.js')));
    const { PAGES } = registry;
    REG = registry;
    NAV = nav;
    console.log('  pages in the registry: ' + PAGES.length);

    // ---- the shell ----------------------------------------------------------
    const shell = document.getElementById('m-shell');
    ok('the Mobile shell is mounted into #app', !!shell && shell.parentElement
      && shell.parentElement.id === 'app', shell ? 'not inside #app' : '#m-shell missing');
    ok('the shell has an app bar, a view and a tab bar',
      !!document.querySelector('#m-shell .m-appbar')
      && !!document.getElementById('m-view')
      && !!document.getElementById('m-tabs'),
      'a region the module needs is not in the shell');

    const expectedTabs = registry.mobilePages()
      .map((p) => p.nav.tabLabel || p.nav.short || p.nav.label);
    const tabs = [...document.querySelectorAll('#m-tabs .m-tab')];
    const tabLabels = tabs.map((a) => (a.querySelector('.m-tab__label') || {}).textContent || '');
    ok('the tab bar carries the destinations the registry marks for the phone',
      expectedTabs.length > 0 && tabLabels.length === expectedTabs.length
        && expectedTabs.every((l) => tabLabels.includes(l)),
      'expected ' + expectedTabs.join(', ') + ' - got ' + (tabLabels.join(', ') || 'nothing'));

    // ---- every page the Mobile module can be addressed at --------------------
    //
    // Pages with no route of their own are the community settings sections, which
    // mobile folds into one screen chosen by ?section=. They are swept below.
    const dumpAt = argv.indexOf('--dump');
    const wanted = dumpAt >= 0 ? (argv[dumpAt + 1] || null) : value('--route', null);

    const routable = PAGES.filter((p) => p.route);
    const targets = wanted
      ? routable.filter((p) => p.route === wanted || p.id === wanted)
      : routable;

    if (dumpAt >= 0) {
      const page = targets[0];
      if (!page) { console.error('\n  no page matches: ' + wanted + '\n'); await boot1.stop(); process.exit(1); }
      const url = concrete(page.route, world);
      await visit(window, document, run, url);
      console.log('\n  ==== ' + page.id + '  ' + url + ' ====\n');
      console.log(document.getElementById('m-view').innerHTML.replace(/>\s*</g, '>\n<'));
      await boot1.stop();
      process.exit(0);
    }

    // Pages a visitor with no session sees are rendered signed out below, in the
    // state a visitor is actually in. Rendering them signed in measures a redirect.
    const sessionPages = targets.filter((p) => p.access !== 'guest');
    const guestPages = targets.filter((p) => p.access === 'guest');

    const seen = [];
    let previousSignature = null;
    let previousId = null;

    for (const page of sessionPages) {
      const url = concrete(page.route, world);
      const out = await visit(window, document, run, url);
      if (out.error) {
        failures.push(`${page.id} (${url}): ${out.error}`);
        console.log(`    FAIL ${page.id}  <- ${out.error}`);
        continue;
      }
      const problems = [];
      if (out.faultOrigin) problems.push('rendered a fault: ' + out.faultOrigin);
      // A page has to say what it is: an app bar title, or a heading inside the
      // view for the screens that own their own furniture.
      if (!out.appBarTitle && !out.headings) problems.push('nothing names the page');
      if (out.viewEmpty) problems.push('#m-view is empty');
      if (!out.buttons) problems.push('nothing interactive');
      // Two addresses can be one destination - /c/<slug> and /server/<id> are both
      // the community, and both redirect to its first channel - and those are
      // supposed to paint the same thing. So the comparison only means something
      // when this route resolved to a different page than the last one.
      const canonical = out.resolvedId || page.id;
      if (previousId && canonical !== previousId && out.signature === previousSignature) {
        problems.push('byte-identical to the previous route');
      }
      if (problems.length) {
        failures.push(`${page.id} (${url}): ${problems.join('; ')}`);
        console.log(`    FAIL ${page.id} (${url})  <- ${problems.join('; ')}`);
      } else {
        passed++;
        console.log(`    ok   ${page.id.padEnd(28)} ${url}`);
      }
      previousSignature = out.signature;
      previousId = canonical;
      seen.push(page.id);
    }

    // ---- the community settings sections, which live behind ?section= --------
    // The section ids are read from the registry rather than repeated here: the
    // registry is the one source of truth for the pages, and a section added there
    // should be swept without editing this check. Mobile folds them into one screen
    // chosen by the query, so the ids are page suffixes, not addresses.
    const SECTION_IDS = PAGES
      .filter((p) => p.id.startsWith('community.settings.'))
      .map((p) => p.id.slice('community.settings.'.length));
    let sectionsOk = 0;
    const sectionSignatures = new Set();
    for (const section of SECTION_IDS) {
      const url = `/server/${world.serverId}/settings?section=${section}`;
      const out = await visit(window, document, run, url);
      if (out.error) {
        failures.push(`community.settings.${section}: ${out.error}`);
        console.log(`    FAIL community.settings.${section}  <- ${out.error}`);
      } else if (out.faultOrigin) {
        failures.push(`community.settings.${section}: fault: ${out.faultOrigin}`);
        console.log(`    FAIL community.settings.${section}  <- ${out.faultOrigin}`);
      } else if (out.viewEmpty) {
        failures.push(`community.settings.${section}: empty`);
        console.log(`    FAIL community.settings.${section}  <- empty view`);
      } else {
        passed++;
        sectionsOk++;
        sectionSignatures.add(out.signature);
      }
    }
    ok('choosing a settings section changes the screen',
      sectionSignatures.size === SECTION_IDS.length,
      sectionSignatures.size + ' distinct screens for ' + SECTION_IDS.length + ' sections');
    console.log('    ' + (sectionsOk === SECTION_IDS.length ? 'ok  ' : 'note')
      + ' ' + sectionsOk + '/' + SECTION_IDS.length + ' community settings sections rendered');

    // ---- the signed-out screens ---------------------------------------------
    const keep = window.localStorage.getItem('trycord.token');
    window.localStorage.removeItem('trycord.token');
    const signedOut = [];
    for (const page of guestPages) {
      const url = concrete(page.route, world);
      const out = await visit(window, document, run, url);
      signedOut.push({ page, url, out });
      seen.push(page.id);
    }
    if (keep) window.localStorage.setItem('trycord.token', keep);

    const guestFaults = signedOut.filter((g) => g.out.error || g.out.faultOrigin);
    ok('every signed-out screen renders for a visitor with no session',
      guestFaults.length === 0,
      guestFaults.map((g) => g.page.id + ': ' + (g.out.error || g.out.faultOrigin)).join(' | '));

    const guestEmpty = signedOut.filter((g) => !g.out.error && !String(g.out.text).trim());
    ok('every signed-out screen puts something on the page',
      guestEmpty.length === 0, guestEmpty.map((g) => g.page.id).join(', '));

    // ---- the conversation, specifically -------------------------------------
    if (keep) window.localStorage.setItem('trycord.token', keep);
    const channelUrl = `/server/${world.serverId}/channel/${world.channelId}`;
    const convo = await visit(window, document, run, channelUrl);
    ok('a conversation shows the message that was sent',
      String(convo.text || '').includes('planted'),
      'the channel rendered without it');
    ok('a conversation has a composer', !!convo.composer, 'no composer in #m-composer');

    // ---- accessibility over everything that was rendered ---------------------
    const unnamed = [];
    let controls = 0;
    for (const page of targets) {
      const url = concrete(page.route, world);
      await visit(window, document, run, url);
      for (const fault of accessibilityFaults(document)) unnamed.push(`${page.id}: ${fault}`);
      controls += document.querySelectorAll('button, a[href], input, select, textarea').length;
    }
    ok('every interactive control has an accessible name', unnamed.length === 0,
      unnamed.slice(0, 4).join(' | '));
    console.log(`    ${controls} controls checked across ${targets.length} pages`);

    await boot1.stop();
  } catch (e) {
    console.error('\n  mobile render check failed to run: ' + e.message + '\n');
    console.error((e.stack || '').split('\n').slice(0, 10).map((l) => '    ' + l.trim()).join('\n'));
    console.error((boot1.log() || '').slice(-1500));
    await boot1.stop();
    process.exit(1);
  }

  console.log(`\n  mobile render check ${failures.length ? 'FAILED - ' + failures.length + ' problem(s)' : 'passed'}`
    + ` - ${passed} assertions\n`);
  process.exit(failures.length ? 1 : 0);
})();
