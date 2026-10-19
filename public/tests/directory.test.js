// The community directory, run.
//
// The defect this file exists to catch: the API returns a community's icon
// as a path, and the page used that path as the image's address. A path
// resolves against the page's own origin, so on a deployment where the site
// and the API are different places the icon 404s, and the community is shown
// with a broken image.
//
// The directory is therefore run against a stub API that returns an icon
// path, and the image is looked for in the rendered tree.

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
    handlers: {},
    textContent: '',
    className: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); },
    // Dispatching a click is how a test asks the page to do something.
    click() { (this.handlers.click || []).forEach((fn) => fn({ target: this })); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    get firstChild() { return this.children[0] || null; },
  };
}

function findAll(node, tagName, out) {
  out = out || [];
  if (!node) return out;
  if (node.tagName === tagName) out.push(node);
  (node.children || []).forEach((c) => findAll(c, tagName, out));
  return out;
}

function runDirectory(options) {
  const calls = [];
  const parts = {};
  const host = element('section');
  ['[data-dir-search]', '[data-dir-sort]', '[data-dir-results]', '[data-dir-pager]', '[data-dir-preview]']
    .forEach((selector) => { parts[selector] = element('div'); });
  host.querySelector = (selector) => parts[selector] || null;

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
        if (selector === '[data-directory]') return host;
        if (selector === 'meta[name="trycord-api"]') {
          return options.apiMeta ? { content: options.apiMeta, getAttribute: () => options.apiMeta } : null;
        }
        return null;
      },
      getElementById() { return null; },
      createElement: element,
      createElementNS: (ns, tag) => element(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
      documentElement: element('html'),
      body: element('body'),
    },
    location: { origin: options.origin || 'https://site.example', href: (options.origin || 'https://site.example') + '/' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch(url, init) {
      calls.push({ url: String(url), method: (init && init.method) || 'GET' });
      return options.fetch(String(url), (init && init.method) || 'GET');
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  for (const file of ['js/public-api.js', 'js/communities.js']) {
    const code = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return { calls, parts };
}

function json(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

const LISTING = {
  items: [{
    id: 'one',
    name: 'A community',
    description: 'A description.',
    icon_url: '/uploads/icon.png',
    member_count: 3,
    channel_count: 1,
  }],
  total: 1,
  pages: 1,
};

test('a community icon is fetched from the API, not from the site', async () => {
  const { parts, calls } = runDirectory({
    origin: 'https://site.example',
    apiMeta: 'https://api.example.test',
    fetch: (url) => {
      if (url.includes('/api/discover/servers')) return json(LISTING);
      return json({});
    },
  });
  await settle();

  const images = findAll(parts['[data-dir-results]'], 'IMG');
  assert.equal(images.length, 1, 'the community icon was not rendered');
  assert.equal(images[0].getAttribute('src'), 'https://api.example.test/uploads/icon.png',
    'the icon was addressed against the site rather than the API');
  assert.ok(calls.every((c) => c.url.startsWith('https://api.example.test')),
    'the directory asked the site for something: ' + JSON.stringify(calls));
});

test('the link into the application is addressed by the instance', async () => {
  const { parts } = runDirectory({
    origin: 'https://site.example',
    apiMeta: 'https://api.example.test',
    fetch: (url) => {
      if (url.includes('/api/discover/servers')) return json(LISTING);
      if (url.includes('/api/discover/servers/one')) {
        return json({ id: 'one', name: 'A community', description: 'A description.', channels: [] });
      }
      return json({});
    },
  });
  await settle();

  // Selecting a community is what renders the preview and its links.
  const card = findAll(parts['[data-dir-results]'], 'BUTTON')[0];
  assert.ok(card, 'the directory did not render a community');
  card.click();
  await settle();

  const links = findAll(parts['[data-dir-preview]'], 'A');
  assert.ok(links.length, 'the preview has no links');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href === null) continue;
    assert.ok(String(href).startsWith('https://site.example/app'),
      'a link into the application was addressed by hand: ' + href);
  }
});
