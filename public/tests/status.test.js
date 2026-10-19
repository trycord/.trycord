// The status page, run.
//
// The defect this file exists to catch: the status page asked the site for
// the instance's health. On a deployment where the site and the API are
// different origins that is the wrong host, the request 404s, and a healthy
// instance is reported as unavailable.
//
// So the checks are made against a stub network that records every address
// asked for, and the assertions are about those addresses: the API's own
// health endpoints at the API's address, and the website at the website's.

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
    innerHTML: '',
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

// The page the status script expects: a panel with a table and one cell per
// component.
function statusPage() {
  const cells = { site: element('span'), api: element('span'), db: element('span'), app: element('span') };
  const tbody = element('tbody');
  const root = element('section');
  root.querySelector = (selector) => {
    if (selector === 'tbody') return tbody;
    if (selector === '[data-status-refresh]') return null;
    const cell = /\[data-state-cell="([^"]+)"\]/.exec(selector);
    if (cell) return cells[cell[1]] || null;
    return null;
  };
  return { root, cells, tbody };
}

function runStatus(options) {
  const calls = [];
  const page = statusPage();
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
        if (selector === '[data-status]') return page.root;
        if (selector === 'meta[name="status-monitor"]') return null;
        if (selector === 'meta[name="trycord-api"]') {
          return options.apiMeta ? { content: options.apiMeta, getAttribute: () => options.apiMeta } : null;
        }
        return null;
      },
      getElementById() { return null; },
      createElement: element,
      createElementNS: (ns, tag) => element(tag),
      documentElement: element('html'),
      body: element('body'),
    },
    location: { origin: options.origin || 'https://site.example', href: (options.origin || 'https://site.example') + '/' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch(url, init) {
      const method = (init && init.method) || 'GET';
      calls.push({ url: String(url), method });
      return options.fetch(String(url), method);
    },
  };
  context.window = context;
  context.globalThis = context;

  const code = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'status.js'), 'utf8');
  vm.createContext(context);
  // The status page resolves the API through the site's resolver, so the
  // resolver is loaded first, exactly as the page loads it.
  if (options.apiMeta) {
    const resolver = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'public-api.js'), 'utf8');
    vm.runInContext(resolver, context, { filename: 'public-api.js' });
  }
  vm.runInContext(code, context, { filename: 'status.js' });
  return { calls, cells: page.cells };
}

function json(body, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test('the API is asked about its own health, at the API\'s address', async () => {
  const { calls, cells } = runStatus({
    origin: 'https://site.example',
    fetch: (url, method) => {
      if (method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
      }
      if (url.endsWith('/api/health')) {
        return json({ ok: true, db: 'ok', client: true });
      }
      if (url.endsWith('/health')) return json({ ok: true });
      return json({}, false);
    },
  });
  await settle();

  const asked = calls.map((c) => c.url);
  assert.ok(asked.includes('https://site.example/health'), 'the API health was not asked for: ' + asked);
  assert.ok(asked.includes('https://site.example/api/health'), 'the instance health was not asked for: ' + asked);
  // The website is a separate question, asked of the website's own origin.
  assert.ok(asked.some((u) => u === 'https://site.example/' && calls.find((c) => c.url === u).method === 'HEAD'),
    'the website was not checked: ' + asked);

  assert.equal(cells.api.textContent, 'Operational');
  assert.equal(cells.db.textContent, 'Operational');
  assert.equal(cells.app.textContent, 'Operational');
  assert.equal(cells.site.textContent, 'Operational');
});

test('a split deployment asks the API on its own origin', async () => {
  const { calls } = runStatus({
    origin: 'https://static.example',
    apiMeta: 'https://api.example.test',
    fetch: (url, method) => {
      if (method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
      }
      if (url === 'https://api.example.test/health') return json({ ok: true });
      if (url === 'https://api.example.test/api/health') return json({ ok: true, db: 'ok', client: true });
      return json({}, false);
    },
  });
  await settle();

  const asked = calls.map((c) => c.url);
  assert.ok(asked.includes('https://api.example.test/health'),
    'the API was asked on the wrong origin: ' + asked);
  assert.ok(asked.includes('https://api.example.test/api/health'),
    'the API was asked on the wrong origin: ' + asked);
  assert.ok(asked.includes('https://static.example/'),
    'the website was not checked on its own origin: ' + asked);
});

test('an API that does not answer is reported as unavailable, not as unknown', async () => {
  const { calls, cells } = runStatus({
    fetch: (url, method) => {
      if (method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
      }
      return json({ ok: false }, false);
    },
  });
  await settle();
  assert.ok(calls.length > 0);
  assert.equal(cells.api.textContent, 'Unavailable');
});
