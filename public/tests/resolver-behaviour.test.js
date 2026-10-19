// The resolver, run.
//
// The static checks in resolver.test.js catch a path written into a fetch
// call. This file runs the actual scripts against a stub DOM and a stub
// network, so the resolution itself is checked rather than its shape: which
// address is asked for, in which order, and what the pages end up with.
//
// The stubs are the smallest thing that can run the scripts: a document that
// answers two selectors, a location, a local storage, and a fetch that
// records what it was asked for.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PUBLIC_DIR } = require('./helpers');

function element(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    textContent: '',
    className: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    get firstChild() { return this.children[0] || null; },
  };
}

// A context the scripts can run in, and a record of what was fetched.
function harness(options) {
  options = options || {};
  const calls = [];
  const store = {};

  const meta = (name) => {
    const value = options[name];
    if (!value) return null;
    return { content: value, getAttribute: () => value };
  };

  const context = {
    console,
    Promise,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    document: {
      querySelector(selector) {
        if (selector === 'meta[name="trycord-api"]') return meta('apiMeta');
        if (selector === 'meta[name="trycord-app"]') return meta('appMeta');
        return null;
      },
      getElementById() { return null; },
      createElement: element,
      createElementNS: (ns, tag) => element(tag),
      documentElement: element('html'),
      body: element('body'),
    },
    location: {
      origin: options.origin || 'https://site.example',
      href: (options.origin || 'https://site.example') + '/',
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch(url, init) {
      const method = (init && init.method) || 'GET';
      calls.push({ url: String(url), method });
      return options.fetch(String(url), method);
    },
  };
  context.window = context;
  context.globalThis = context;

  return { context, calls };
}

function run(file, context) {
  const code = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: file });
  return context.window;
}

function json(body, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 404,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

function empty(status) {
  return Promise.resolve({
    ok: status < 400,
    status,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({}),
  });
}

test('the page\'s own answer for the API wins, and nothing is fetched', async () => {
  const { context, calls } = harness({
    apiMeta: 'https://api.example.test',
    fetch: () => json({ backendUrl: 'https://wrong.example.test' }),
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.apiBase(), 'https://api.example.test');
  assert.deepEqual(calls, [], 'the resolver fetched something it did not need');
});

test('without the page\'s answer, the instance\'s own file is used', async () => {
  const { context, calls } = harness({
    fetch: (url) => {
      if (url.includes('backend.json')) {
        return json({ backendUrl: 'https://from-file.example.test', appUrl: '/app' });
      }
      return json({});
    },
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.apiBase(), 'https://from-file.example.test');
  assert.equal(await TrycordApi.appBase(), 'https://site.example/app');
  assert.equal(await TrycordApi.appHref(''), 'https://site.example/app/');
  assert.equal(await TrycordApi.appHref('support/appeals'), 'https://site.example/app/support/appeals');
  assert.deepEqual(calls.map((c) => c.url), ['./backend.json']);
});

test('with nothing configured, the application is looked for', async () => {
  const { context, calls } = harness({
    fetch: (url, method) => {
      if (url.includes('backend.json')) return json({ backendUrl: 'https://api.example.test' });
      if (method === 'HEAD' && url.endsWith('/app/')) return empty(200);
      return empty(404);
    },
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.appBase(), 'https://site.example/app');
  assert.ok(calls.some((c) => c.method === 'HEAD' && c.url === 'https://site.example/app/'),
    'the application was never looked for: ' + JSON.stringify(calls));
});

test('an instance serving the application from the origin root is found', async () => {
  const { context } = harness({
    fetch: (url) => {
      if (url.includes('backend.json')) return json({ backendUrl: 'https://api.example.test' });
      return empty(404);
    },
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.appBase(), '');
  // With no mount, the application's own front door is its home view: the
  // website owns the origin root.
  assert.equal(await TrycordApi.appHref(''), '/home');
  assert.equal(await TrycordApi.appHref('settings/updates'), '/settings/updates');
});

test('a site on its own origin finds the application on the API\'s', async () => {
  const { context, calls } = harness({
    origin: 'https://static.example',
    fetch: (url, method) => {
      if (url.includes('backend.json')) return json({ backendUrl: 'https://api.example.test' });
      if (method === 'HEAD' && url.startsWith('https://static.example')) return empty(404);
      if (method === 'HEAD' && url.startsWith('https://api.example.test/app/')) return empty(200);
      return empty(404);
    },
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.appBase(), 'https://api.example.test/app');
  assert.equal(await TrycordApi.appHref(''), 'https://api.example.test/app/');
  assert.ok(calls.some((c) => c.url === 'https://api.example.test/app/'));
});

test('a page that states the application\'s own address is believed', async () => {
  const { context, calls } = harness({
    appMeta: '/mounted',
    fetch: (url) => {
      if (url.includes('backend.json')) return json({ appUrl: '/from-file' });
      return json({});
    },
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.appBase(), 'https://site.example/mounted');
  assert.equal(await TrycordApi.appHref(''), 'https://site.example/mounted/');
  // The page's own answer is enough; there is nothing to look for.
  assert.deepEqual(calls, []);
});

test('an icon path is completed against the API, not the page', async () => {
  const { context } = harness({
    apiMeta: 'https://api.example.test',
    fetch: () => json({}),
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.assetUrl('/uploads/icon.png'), 'https://api.example.test/uploads/icon.png');
  // An address that is already complete is left alone.
  assert.equal(await TrycordApi.assetUrl('https://cdn.example.test/i.png'), 'https://cdn.example.test/i.png');
});

test('the session is read from the API\'s own origin', async () => {
  const { context } = harness({
    apiMeta: 'https://api.example.test',
    origin: 'https://site.example',
    fetch: () => json({}),
  });
  const { TrycordApi } = run('js/public-api.js', context);
  assert.equal(await TrycordApi.signedIn(), false);
  context.localStorage.setItem('trycord.token.https://api.example.test', 'a-token');
  assert.equal(await TrycordApi.signedIn(), true);
  assert.equal(await TrycordApi.token(), 'a-token');
});
