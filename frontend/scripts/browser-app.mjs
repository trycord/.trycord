#!/usr/bin/env node
'use strict';

// The client, driven in a real browser.
//
// The browser in this environment cannot complete an http request: a
// navigation to any address hangs, and the renderer's network service never
// answers. So the application cannot be loaded from the instance.
//
// What it *can* do is run a document from disk, and the client's own modules
// load from disk with it. What it cannot do is talk to the instance.
//
// So the harness answers the instance's questions itself. The fetch is
// replaced before the application's first line runs, and the answers are the
// shapes the instance really returns. The application then boots exactly as
// it does in production - the same modules, the same router, the same shell -
// and the harness measures what it drew.
//
// This is not a mock of the client. It is a stand-in for the *server*, and
// the client is the real one.
//
//   node scripts/browser-app.mjs --base http://127.0.0.1:9971
//   node scripts/browser-app.mjs --widths 320,768,1440 --shots /tmp/shots
//
// It exits non-zero when a page printed an error, so it can be a check.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const BASE = String(arg('base', '')).replace(/\/+$/, '');
const WIDTHS = String(arg('widths', '390,768,1280,1920')).split(',').map((n) => Number(n.trim())).filter(Boolean);
const ROUTES = String(arg('routes', '/home,/dms,/search,/settings,/menu')).split(',').map((r) => r.trim()).filter(Boolean);
// The Mobile module is a shell of its own, so it is driven separately.
const MOBILE = arg('mobile', 'yes') !== 'no';
const MOBILE_WIDTHS = String(arg('mobile-widths', '320,390,430')).split(',').map((n) => Number(n.trim())).filter(Boolean);
const MOBILE_ROUTES = String(arg('mobile-routes', '/home,/dms,/search,/settings,/menu')).split(',').map((r) => r.trim()).filter(Boolean);
const SHOTS = arg('shots', '');
const PORT = Number(process.env.BROWSER_APP_PORT || 9377);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The instance's answers.
//
// The shapes are the ones the real routes return. A stub that answered
// something else would be measuring the stub, so these are copied from the
// route handlers and the client's own expectations.
const ANSWERS = {
  'GET /api/instance': {
    instanceId: 'official', version: '3.0.0', name: 'Trycord Official',
    description: '', supportUrl: 'https://trycord.dev/support',
    apiVersion: 1, protocolVersion: 'trycord-continuum/1.0',
  },
  'GET /api/legal': { termsVersion: '1.0', privacyVersion: '1.0', updated: '2026-09-20' },
  'GET /api/me': {
    user: {
      id: 'u1', username: 'ada', displayName: 'Ada', isAdmin: true,
      avatarUrl: null, bannerUrl: null, bio: '', statusText: '',
    },
  },
  'GET /api/servers': [
    {
      id: 's1', name: 'The Community', description: 'A place to talk.',
      iconUrl: null, bannerUrl: null, memberCount: 12, isPublic: true,
      isDiscoverable: true, ownerId: 'u1', permissions: ['*'], is_owner: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  'GET /api/servers/s1/channels': {
    channels: [
      { id: 'c1', name: 'general', type: 'text', position: 1, categoryId: null, topic: '' },
      { id: 'c2', name: 'random', type: 'text', position: 2, categoryId: null, topic: '' },
      { id: 'c3', name: 'Voice', type: 'voice', position: 3, categoryId: null, topic: '' },
    ],
    categories: [{ id: 'cat1', name: 'Text Channels', position: 1 }],
  },
  'GET /api/servers/s1/members': {
    items: [{ id: 'u1', username: 'ada', displayName: 'Ada', nickname: null, roles: [], joinedAt: '2026-01-01T00:00:00.000Z' }],
    total: 1, hasMore: false,
  },
  'GET /api/servers/s1/settings': {
    welcomeContent: 'Welcome.', welcomeEnabled: true, guidelines: 'Be kind.',
    notificationDefaults: '{}', interactionSettings: '{}',
  },
  'GET /api/servers/s1/roles': { roles: [] },
  'GET /api/servers/s1/categories': [{ id: 'cat1', name: 'Text Channels', position: 1 }],
  'GET /api/dms': [],
  'GET /api/friends': [],
  'GET /api/notifications': [],
  'GET /api/me/privacy': { friendRequests: 'friends', dms: 'anyone', presence: 'anyone', discoverable: false },
  'GET /api/me/blocks': [],
  'GET /api/reports/mine': [],
  'GET /api/me/preferences': { locale: 'en', theme: 'trycord' },
  'GET /api/voice/capabilities': { voiceVideo: { available: true, provider: 'mesh', detail: '' } },
};

// The script that runs before the application's own.
//
// The fetch is replaced here, so the application never knows the difference,
// and the errors it printed are collected for the harness to read.
const STUB = `
(function () {
  var answers = ${JSON.stringify(ANSWERS)};
  var errors = window.__trycordErrors = window.__trycordErrors || [];
  var original = window.fetch;

  // A signed-in reader.
  //
  // The token is kept under the address of the instance, and the harness
  // answers the configuration with an empty address, so the key is the
  // prefix on its own. Without a token the client is signed out, and a
  // signed-out client draws the sign-in screen - so the harness was
  // measuring a page no reader ever sees.
  // The key is the prefix and the address of the instance the client
  // resolved. A document off disk has no address of its own, so it falls
  // back to the default one - and the stub answers the configuration with
  // an empty address, which is the same key. Both are set, so the reader is
  // signed in whichever the client ends up talking to.
  try {
    window.localStorage.setItem('trycord.token.', 'harness-token');
    window.localStorage.setItem('trycord.token.https://api.trycord.dev', 'harness-token');
    window.localStorage.setItem('trycord.token.http://localhost:9971', 'harness-token');
  } catch (e) { /* storage is off; the client will be signed out */ }
  window.fetch = function (input, options) {
    var url = String(input);
    var method = String((options && options.method) || 'GET').toUpperCase();
    // The configuration the client reads before anything else.
    if (url.indexOf('backend.json') !== -1) {
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK',
        headers: { get: function () { return null; } },
        json: function () { return Promise.resolve({ backendUrl: '' }); },
        text: function () { return Promise.resolve('{}'); },
      });
    }
    // A route the harness knows about.
    var answer = answers[method + ' ' + url];
    if (answer === undefined) {
      for (var key in answers) {
        var parts = key.split(' ');
        if (parts[0] === method && url.indexOf(parts[1]) !== -1) { answer = answers[key]; break; }
      }
    }
    if (answer === undefined) answer = {};
    var body = JSON.stringify(answer);
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: function () { return null; } },
      json: function () { return Promise.resolve(answer); },
      text: function () { return Promise.resolve(body); },
      arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); },
    });
  };
  window.addEventListener('error', function (event) {
    errors.push(String((event.error && event.error.stack) || event.message || 'an error'));
  });
  window.addEventListener('unhandledrejection', function (event) {
    errors.push('unhandled rejection: ' + String((event.reason && event.reason.stack) || event.reason));
  });
  var originalError = console.error;
  console.error = function () {
    errors.push('console.error: ' + Array.prototype.map.call(arguments, function (a) {
      return (a && (a.stack || a.message)) || String(a);
    }).join(' '));
    return originalError.apply(console, arguments);
  };
})();
`;

// The document the browser loads.
//
// The client's own index.html carries `<base href="/app/">`, which is right
// when the server serves it and wrong from a file: the modules would be
// looked for at the root of the filesystem. So a copy is made with the base
// relative, in the client's own directory, so the module paths still resolve
// to the real files.
const HARNESS_DOCUMENT = path.join(CLIENT, '.browser-harness.html');
function writeHarnessDocument() {
  const original = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
  fs.writeFileSync(HARNESS_DOCUMENT, original.replace(
    /<base href="[^"]*">/,
    '<base href="./">',
  ));
  return HARNESS_DOCUMENT;
}

// The Mobile module's own entry document, the same way.
//
// It is a second shell over the same packages, with its own stylesheet and
// its own router, so it has to be driven as its own document. The base is
// the module root, and every asset below it is relative to that, so the
// document is copied with the base rewritten to the directory it sits in.
function writeMobileHarnessDocument() {
  // The document is written two levels below the client, so the module's own
  // relative imports - "../../packages/..." - still reach the real packages
  // rather than a copy of them.
  const dir = path.join(CLIENT, '.browser-harness', 'mobile');
  fs.mkdirSync(dir, { recursive: true });
  const original = fs.readFileSync(path.join(CLIENT, 'mobile', 'index.html'), 'utf8');
  const target = path.join(dir, 'index.html');
  fs.writeFileSync(target, original.replace(
    /<base href="[^"]*">/,
    '<base href="./">',
  ));
  // The stylesheet is asked for as "./css/app.css", and the icons as
  // "../assets/...", so those two are copied beside the document.
  fs.cpSync(path.join(CLIENT, 'mobile', 'css'), path.join(dir, 'css'), { recursive: true });
  fs.cpSync(path.join(CLIENT, 'mobile', 'js'), path.join(dir, 'js'), { recursive: true });
  fs.cpSync(path.join(CLIENT, 'assets'), path.join(CLIENT, '.browser-harness', 'assets'),
    { recursive: true });
  // The module's own imports reach up two directories for the packages, so
  // they are copied to where that path lands.
  fs.cpSync(path.join(CLIENT, 'packages'), path.join(CLIENT, '.browser-harness', 'packages'),
    { recursive: true });
  return target;
}

// ---- the browser ------------------------------------------------------------

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-app-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--force-device-scale-factor=1',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErrors = '';
chrome.stderr.on('data', (data) => { chromeErrors += data.toString(); });

async function shutdown() {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* already gone */ }
  try { fs.rmSync(HARNESS_DOCUMENT, { force: true }); } catch { /* already gone */ }
  try { fs.rmSync(path.join(CLIENT, '.browser-harness'), { recursive: true, force: true }); } catch { /* already gone */ }
}

class Page {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.waiting = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.waiting.has(message.id)) {
        this.waiting.get(message.id)(message.result);
        this.waiting.delete(message.id);
      }
    };
  }

  send(method, params) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('the browser did not answer ' + method));
      }, 30000);
      this.waiting.set(id, (result) => { clearTimeout(timer); resolve(result); });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async evaluate(expression) {
    const answer = await this.send('Runtime.evaluate', {
      expression: '(function () {' + expression + '})()',
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer && answer.exceptionDetails) {
      const detail = answer.exceptionDetails;
      throw new Error('the page threw: '
        + ((detail.exception && detail.exception.description) || detail.text));
    }
    return answer && answer.result ? answer.result.value : undefined;
  }
}

// ---- the run ----------------------------------------------------------------

const report = [];
let failures = 0;

try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find((entry) => entry.type === 'page') || null;
    } catch { /* not up yet */ }
    if (!target) await wait(200);
  }
  if (!target) throw new Error('the browser did not start');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('the browser refused the connection'));
  });
  const page = new Page(socket);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

  const document = writeHarnessDocument();

  // The route has to be named before the client boots: a document off disk
  // has no path that carries one, and the client routes on the address.
  // A script added to every new document is the only thing that runs early
  // enough, so it is registered per route and the previous one removed.
  let routeScript = null;
  const nameRoute = async (route) => {
    if (routeScript) {
      await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: routeScript });
      routeScript = null;
    }
    const added = await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__trycordRoute = ' + JSON.stringify(route) + ';',
    });
    routeScript = added && added.identifier;
  };

  for (const width of WIDTHS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    for (const route of ROUTES) {
      await nameRoute(route);
      await page.send('Page.navigate', { url: 'file://' + document });
      // The client reads its configuration, asks the instance, and draws.
      // Give it the time it needs rather than a fixed guess.
      for (let i = 0; i < 60; i++) {
        const ready = await page.evaluate(
          'return !!(document.querySelector(".ws") || document.querySelector(".auth-page"));',
        ).catch(() => false);
        if (ready) break;
        await wait(120);
      }
      await wait(400);

      const measured = await page.evaluate(`
        var root = document.querySelector('.ws');
        var rail = document.querySelector('.rail');
        var column = document.querySelector('.context');
        var stage = document.querySelector('.stage');
        function box(node) {
          if (!node) return null;
          var r = node.getBoundingClientRect();
          var style = getComputedStyle(node);
          return {
            x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
            shown: style.display !== 'none' && style.visibility !== 'hidden',
          };
        }
        var errors = (window.__trycordErrors || []).slice();
        window.__trycordErrors = [];
        return {
          regions: root ? root.getAttribute('data-regions') : null,
          column: root ? root.getAttribute('data-column') : null,
          nav: root ? root.getAttribute('data-nav') : null,
          rail: box(rail), columnBox: box(column), stage: box(stage),
          hasContext: !!column,
          contextText: column ? (column.textContent || '').trim().slice(0, 80) : null,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          errors: errors,
          bodyClass: document.body ? document.body.className : null,
          appChildren: (document.getElementById('app') || {}).childNodes ? document.getElementById('app').childNodes.length : -1,
          appHtml: (document.getElementById('app') || {}).innerHTML ? document.getElementById('app').innerHTML.slice(0, 200) : null,
          scripts: Array.from(document.querySelectorAll('script')).map(function (n) { return n.src || '(inline)'; }),
        };
      `);

      const entry = { width, route, ...measured };
      report.push(entry);

      const faults = [];
      for (const error of measured.errors || []) faults.push(error);
      if (measured.overflow > 2) {
        faults.push('the page scrolls sideways by ' + measured.overflow + ' pixels');
      }
      if (width >= 1024 && measured.hasContext && measured.columnBox && !measured.columnBox.shown) {
        faults.push('the place column is not shown at ' + width + ' pixels');
      }
      if (width >= 1024 && measured.hasContext && measured.columnBox && measured.columnBox.w < 160) {
        faults.push('the place column is ' + measured.columnBox.w + ' pixels wide');
      }
      if (width >= 1024 && measured.hasContext && measured.rail && !measured.rail.shown) {
        faults.push('the communities rail is not shown at ' + width + ' pixels');
      }

      if (process.env.BROWSER_APP_VERBOSE) {
        console.log('        body:', JSON.stringify(measured).slice(0, 700));
      }
      if (faults.length) {
        failures += faults.length;
        console.log('  FAIL  ' + width + 'px ' + route);
        for (const fault of faults) console.log('          ' + fault);
      } else {
        console.log('  ok    ' + width + 'px ' + route
          + '  regions=' + measured.regions
          + ' column=' + (measured.columnBox ? measured.columnBox.w + 'px' : 'none')
          + ' rail=' + (measured.rail ? measured.rail.w + 'px' : 'none'));
      }

      if (SHOTS) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(
          path.join(SHOTS, 'app-' + width + '-' + route.replace(/[^a-z0-9]+/gi, '-') + '.png'),
          Buffer.from(shot.data, 'base64'),
        );
      }
    }
  }
// ---- the mobile shell --------------------------------------------------------
//
// The Mobile module is a second shell over the same packages, with its own
// entry document, its own stylesheet and its own router. It is driven here
// as its own document, at the widths a phone is, and what is measured is
// what a thumb has to reach: every control is at least a touch target, and
// nothing is drawn outside the width of the screen.
//
// The limit of this is the same as the limit of the desktop pass: the
// browser here cannot reach the network, so the instance's answers are
// stubbed and the module is measured against those. It is a real browser,
// real CSS and real pixels; it is not a real phone.

if (MOBILE) {
  console.log('\n--- the mobile shell ---');
  const mobileDocument = writeMobileHarnessDocument();

  for (const width of MOBILE_WIDTHS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile: true,
    });

    for (const route of MOBILE_ROUTES) {
      await nameRoute(route);
      await page.send('Page.navigate', { url: 'file://' + mobileDocument });
      for (let i = 0; i < 60; i++) {
        const ready = await page.evaluate(
          'return !!(document.querySelector(".m-app") || document.querySelector(".auth-page")'
          + ' || (document.getElementById("app") && document.getElementById("app").childNodes.length));',
        ).catch(() => false);
        if (ready) break;
        await wait(120);
      }
      await wait(400);
      const measured = await page.evaluate(`
        // Every control a thumb has to reach.
        var small = [];
        var controls = Array.from(document.querySelectorAll(
          'button, a[href], [role="button"], [role="tab"], input[type="checkbox"], input[type="radio"]'
        ));
        for (var i = 0; i < controls.length; i++) {
          var node = controls[i];
          var rect = node.getBoundingClientRect();
          var style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (rect.width === 0 && rect.height === 0) continue;
          // A link inside a line of text is not a control a thumb presses.
          if (node.tagName === 'A' && node.closest('p, li, .lede, .m-row__sub')) continue;
          // A control whose middle is not on the screen is not one a thumb
          // reaches: the skip link sits off the top until it is focused, and
          // it is a keyboard affordance rather than a touch one.
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          if (cy < 0 || cy > window.innerHeight || cx < 0 || cx > window.innerWidth) continue;
          if (rect.width < 44 || rect.height < 44) {
            small.push({
              tag: node.tagName,
              cls: String(node.className || '').slice(0, 40),
              label: String(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40),
              w: Math.round(rect.width), h: Math.round(rect.height),
            });
          }
        }
        var errors = (window.__trycordErrors || []).slice();
        window.__trycordErrors = [];
        return {
          small: small,
          errors: errors,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          controls: controls.length,
          text: String(document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
          appChildren: (document.getElementById('app') || {}).childNodes
            ? document.getElementById('app').childNodes.length : -1,
        };
      `);

      const faults = [];
      for (const error of measured.errors || []) faults.push(error);
      if (measured.overflow > 2) {
        faults.push('the page scrolls sideways by ' + measured.overflow + ' pixels');
      }
      for (const control of measured.small || []) {
        faults.push('a control is ' + control.w + 'x' + control.h
          + ' (' + control.cls + (control.label ? ' "' + control.label + '"' : '') + ')');
      }
      if (measured.appChildren <= 0) faults.push('the module drew nothing');

      if (faults.length) {
        failures += faults.length;
        for (const fault of faults) console.log('        ' + fault);
      }
      console.log('  ' + (faults.length ? 'FAIL' : 'ok ') + '    ' + width + 'px ' + route
        + ' controls=' + measured.controls
        + ' small=' + (measured.small || []).length
        + ' | ' + (measured.text || ''));
    }
  }
}

} catch (error) {
  console.log('the run failed: ' + (error && error.message));
  console.log(chromeErrors.slice(0, 600));
  failures += 1;
} finally {
  await shutdown();
}

console.log('\n' + report.length + ' page(s) at ' + WIDTHS.length + ' width(s); '
  + failures + ' fault(s).');
process.exit(failures ? 1 : 0);
