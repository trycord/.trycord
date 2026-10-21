// The browser harness.
//
// One place where the browser is started, the instance is answered, and a
// document is written for a module to be driven from.
//
// The answers are the shapes the instance really returns - the names the
// database uses, the names the routes use - because a stub that answers with
// different names measures a shape the instance never sends. The stub
// installs a token so the reader is signed in, because a signed-out client
// draws the sign-in screen and a harness that measures that measures a page
// no reader sees.
//
// A document off disk has no address to route on, so the route is named
// before the module boots. The browser here cannot reach the network, so the
// instance's questions are answered here.
//
//   import { harness, wait } from './browser-harness.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT = path.join(HERE, '..');
export const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The instance's answers.
//
// The shapes are the ones the real routes return, copied from the route
// handlers and the client's own expectations.
export const ANSWERS = {
  'GET /api/instance': {
    instanceId: 'official', version: '3.0.0', name: 'Trycord Official',
    description: '', supportUrl: 'https://trycord.dev/support',
    apiVersion: 1, protocolVersion: 'trycord-continuum/1.0',
  },
  'GET /api/legal': { termsVersion: '1.0', privacyVersion: '1.0', updated: '2026-09-20' },
  // The shape the instance answers with: the person, not a wrapper. The desk
  // asks for /api/users/me and the phone for /api/me.
  'GET /api/users/me': {
    id: 'u1', username: 'ada', displayName: 'Ada', isAdmin: true,
    avatarUrl: null, bannerUrl: null, bio: '', statusText: '',
    email: null, emailVerified: false, verificationRequired: false,
  },
  'GET /api/me': {
    id: 'u1', username: 'ada', displayName: 'Ada', isAdmin: true,
    avatarUrl: null, bannerUrl: null, bio: '', statusText: '',
    email: null, emailVerified: false, verificationRequired: false,
  },
  // The names the instance really uses: a community's columns are the
  // database's.
  'GET /api/servers': [
    {
      id: 's1', name: 'The Community', description: 'A place to talk.',
      icon_url: null, banner_url: null, slug: 'the-community',
      member_count: 12, channel_count: 3, is_public: true,
      is_discoverable: true, owner_id: 'u1', permissions: ['*'], is_owner: true,
      created_at: '2026-01-01T00:00:00.000Z', join_code: 'join-me',
    },
  ],
  'GET /api/servers/s1': {
    id: 's1', name: 'The Community', description: 'A place to talk.',
    icon_url: null, banner_url: null, slug: 'the-community',
    member_count: 12, channel_count: 3, is_public: true,
    is_discoverable: true, owner_id: 'u1', permissions: ['*'], is_owner: true,
    created_at: '2026-01-01T00:00:00.000Z', join_code: 'join-me',
  },
  'GET /api/servers/s1/channels': {
    channels: [
      { id: 'c1', name: 'general', type: 'text', position: 1, categoryId: null, topic: '' },
      { id: 'c2', name: 'random', type: 'text', position: 2, categoryId: null, topic: '' },
      { id: 'c3', name: 'Voice', type: 'voice', position: 3, categoryId: null, topic: '' },
    ],
    categories: [{ id: 'cat1', name: 'Text Channels', position: 1 }],
  },
  'GET /api/servers/s1/members': {
    items: [
      { id: 'u1', username: 'ada', displayName: 'Ada', nickname: null,
        roles: [{ id: 'r1', name: 'Maintainer', color: '#ff8a24' }],
        joinedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'u2', username: 'grace', displayName: 'Grace', nickname: null,
        roles: [{ id: 'r2', name: 'Member', color: null }],
        joinedAt: '2026-01-04T00:00:00.000Z' },
    ],
    total: 2, hasMore: false,
  },
  'GET /api/servers/s1/settings': {
    welcomeContent: 'Welcome.', welcomeEnabled: true, guidelines: 'Be kind.',
    notificationDefaults: '{}', interactionSettings: '{}',
  },
  'GET /api/servers/s1/roles': { roles: [] },
  'GET /api/servers/s1/categories': [{ id: 'cat1', name: 'Text Channels', position: 1 }],
  'GET /api/users/u2': {
    id: 'u2', username: 'grace', displayName: 'Grace Hopper',
    createdAt: '2024-02-11T09:00:00.000Z',
    bio: 'Compiler pioneer. Currently untangling a moth.',
    avatarUrl: null, bannerUrl: null, statusText: 'In the workshop',
    presence: 'online', isBot: false, relation: 'friend',
    membership: {
      joinedAt: '2024-03-01T09:00:00.000Z',
      roles: [
        { id: 'r1', name: 'Maintainer', position: 3, color: '#ff8a24' },
        { id: 'r2', name: 'Member', position: 1, color: null },
      ],
    },
  },
  // The communities that live on another instance.
  'GET /api/continuum/federated': [
    {
      id: 'fc1', originInstanceId: 'peer-1', originCommunityId: 'c-remote',
      name: 'General', description: 'A community somewhere else.', iconUrl: null,
      originName: 'The Other Instance', originUrl: 'https://peer.example',
      relationship: 'joined',
      channels: [
        { id: 'ch-1', name: 'general', type: 'text', topic: 'The one channel', canPost: true },
        { id: 'ch-2', name: 'announcements', type: 'text', topic: '', canPost: false },
      ],
    },
  ],
  'GET /api/continuum/communities/peer-1/c-remote/messages': [
    {
      id: 'm1', content: 'A message that was relayed from somewhere else.',
      author_name: 'Grace', created_at: '2026-02-01T10:00:00.000Z',
    },
  ],
  'GET /api/dms': [],
  'GET /api/friends': [],
  'GET /api/notifications': [],
  'GET /api/me/privacy': { friendRequests: 'friends', dms: 'anyone', presence: 'anyone', discoverable: false },
  'GET /api/me/blocks': [],
  'GET /api/reports/mine': [],
  'GET /api/me/preferences': { locale: 'en', theme: 'trycord' },
  'GET /api/voice/capabilities': { voiceVideo: { available: true, provider: 'mesh', detail: '' } },
};

// The stub.
//
// It answers the instance's questions, keeps a signed-in reader, and names
// the route the document is to be driven at.
export const STUB = `
(function () {
  var answers = ${JSON.stringify(ANSWERS)};
  var errors = window.__trycordErrors = window.__trycordErrors || [];
  var original = window.fetch;

  // A signed-in reader.
  //
  // The token is kept under the address of the instance, and the harness
  // answers the configuration with an empty address, so the key is the prefix
  // on its own. Without a token the client is signed out, and a signed-out
  // client draws the sign-in screen.
  var store = {};
  var realStorage = true;
  try {
    var probe = '__trycord_probe__';
    window.localStorage.setItem(probe, '1');
    if (window.localStorage.getItem(probe) !== '1') throw new Error('the storage did not keep it');
    window.localStorage.removeItem(probe);
  } catch (e) {
    realStorage = false;
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          get length() { return Object.keys(store).length; },
          key: function (i) { return Object.keys(store)[i] || null; },
          getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setItem: function (k, v) { store[k] = String(v); },
          removeItem: function (k) { delete store[k]; },
          clear: function () { store = {}; },
        },
      });
    } catch (inner) {
      // The shim would not install either, so the reader stays signed out.
    }
  }
  void realStorage;
  try {
    window.localStorage.setItem('trycord.token.', 'harness-token');
    window.localStorage.setItem('trycord.token.https://api.trycord.dev', 'harness-token');
    window.localStorage.setItem('trycord.token.http://localhost:9971', 'harness-token');
  } catch (e) { /* the client will be signed out */ }

  // The history, on a document off disk.
  //
  // A document on disk cannot change its own address, so a history write
  // throws and the navigation never happens: a community that opens its
  // first channel would ask for the same page for ever, because the route it
  // asked for was never recorded.
  //
  // The harness gives it a history that works, and the route it was asked
  // for is remembered, so a page that navigates actually goes there.
  (function () {
    var realPush = history.pushState.bind(history);
    var realReplace = history.replaceState.bind(history);
    function record(url) {
      if (typeof url !== 'string' || url.charAt(0) !== '/') return;
      window.__trycordRoute = url;
    }
    history.pushState = function (state, title, url) {
      record(url);
      try { realPush(state, title, location.pathname); } catch (e) { /* the address cannot change */ }
    };
    history.replaceState = function (state, title, url) {
      record(url);
      try { realReplace(state, title, location.pathname); } catch (e) { /* the address cannot change */ }
    };
  })();

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
    //
    // The path is matched against the address, not anywhere inside it: the
    // answer for "/api/servers" is not the answer for
    // "/api/servers/s1/members", and matching it loosely drew the roster
    // from the list of communities.
    var answer = answers[method + ' ' + url];
    if (answer === undefined) {
      // The path, without the address it was fetched from.
      //
      // Written without a regular expression: this source is a template
      // literal, and the backslashes in an escaped slash are eaten by it -
      // which broke the whole stub, and the harness quietly talked to the
      // real instance instead of the answers below.
      var scheme = url.indexOf('://');
      var path = scheme === -1 ? url : url.slice(url.indexOf('/', scheme + 3));
      var best = null;
      for (var key in answers) {
        var parts = key.split(' ');
        if (parts[0] !== method) continue;
        var wanted = parts[1];
        if (path !== wanted && path.indexOf(wanted + '?') !== 0
          && path.indexOf(wanted + '/') !== 0) continue;
        if (!best || wanted.length > best.length) best = wanted;
      }
      if (best) answer = answers[method + ' ' + best];
    }
    if (answer === undefined) answer = {};
    window.__calls = window.__calls || [];
    window.__calls.push(method + ' ' + url);
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

// -- the documents ------------------------------------------------------------

const HARNESS_DOCUMENT = path.join(CLIENT, '.browser-harness.html');

/** The desk's entry document, on disk, with its base rewritten. */
export function writeHarnessDocument() {
  const original = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
  fs.writeFileSync(HARNESS_DOCUMENT, original.replace(
    /<base href="[^"]*">/,
    '<base href="./">',
  ));
  return HARNESS_DOCUMENT;
}

/**
 * The Mobile module's own entry document.
 *
 * It is written two levels below the client, so the module's own relative
 * imports - "../../packages/..." - still reach the real packages rather than
 * a copy of them.
 */
export function writeMobileHarnessDocument() {
  const dir = path.join(CLIENT, '.browser-harness', 'mobile');
  fs.mkdirSync(dir, { recursive: true });
  const original = fs.readFileSync(path.join(CLIENT, 'mobile', 'index.html'), 'utf8');
  const target = path.join(dir, 'index.html');
  fs.writeFileSync(target, original.replace(
    /<base href="[^"]*">/,
    '<base href="./">',
  ));
  fs.cpSync(path.join(CLIENT, 'mobile', 'css'), path.join(dir, 'css'), { recursive: true });
  fs.cpSync(path.join(CLIENT, 'mobile', 'js'), path.join(dir, 'js'), { recursive: true });
  fs.cpSync(path.join(CLIENT, 'assets'), path.join(CLIENT, '.browser-harness', 'assets'),
    { recursive: true });
  fs.cpSync(path.join(CLIENT, 'packages'), path.join(CLIENT, '.browser-harness', 'packages'),
    { recursive: true });
  return target;
}

/** Everything the harness wrote, so it can be taken away again. */
export function cleanupHarness() {
  for (const file of [HARNESS_DOCUMENT, path.join(CLIENT, '.browser-harness')]) {
    try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

// -- the browser --------------------------------------------------------------

/** A page on the debugging protocol, with the calls it makes. */
export class Page {
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

  /**
   * Send a call and wait for its answer.
   *
   * The wait is bounded. A browser that is asked something it never answers
   * - a page that is navigating, a tab that is gone - would otherwise leave
   * the harness waiting for ever, with nothing to say so.
   */
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('the browser did not answer ' + method));
      }, 30000);
      this.waiting.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  /** Run an expression in the page and bring the answer back. */
  async evaluate(expression) {
    const answer = await this.send('Runtime.evaluate', {
      expression: '(() => { ' + expression + ' })()',
      returnByValue: true,
      awaitPromise: true,
    });
    if (!answer || answer.exceptionDetails) {
      const detail = answer && answer.exceptionDetails;
      throw new Error('the page refused to answer: '
        + ((detail && detail.text) || 'unknown'));
    }
    return answer.result ? answer.result.value : undefined;
  }
}

/**
 * Start the browser and hand back a page that answers the instance.
 *
 * The stub is registered before anything is navigated to, and the harness
 * refuses to run if the browser will not take it: a stub that is a syntax
 * error is a harness that quietly measures the real instance instead of the
 * answers.
 */
/**
 * A port nothing is listening on.
 *
 * A browser that cannot bind the port it was asked for leaves the harness
 * waiting for a browser that is never going to come - and a stale browser
 * from an interrupted run is enough to do it. So the port is checked first,
 * and a busy one is an error rather than a wait.
 */
export async function freePort(preferred) {
  const net = await import('node:net');
  const taken = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
  if (preferred && !(await taken(preferred))) return preferred;
  for (let port = 9400; port < 9500; port++) {
    if (!(await taken(port))) return port;
  }
  throw new Error('no free port for the browser');
}

export async function harness(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-app-'));
  // A run that is interrupted leaves the browser's profile behind, and a
  // hundred of those fill the disk the browser is run on. It is taken away
  // when the process goes, whatever happened to it.
  const forgetProfile = () => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  process.on('exit', forgetProfile);
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
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let chromeErrors = '';
  chrome.stderr.on('data', (data) => { chromeErrors += data.toString(); });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
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
  const registration = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  if (!registration || !registration.identifier) {
    chrome.kill('SIGKILL');
    throw new Error('the browser would not take the stub, so the harness would be '
      + 'talking to the real instance instead of the answers');
  }

  // The route is named before the client boots: a document off disk has no
  // path that carries one, and the client routes on the address.
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

  const shutdown = async () => {
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    forgetProfile();
    cleanupHarness();
  };

  return { page, nameRoute, shutdown, chromeErrors: () => chromeErrors };
}
