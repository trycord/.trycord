#!/usr/bin/env node
'use strict';

// Imports every web-client module and asserts it loads.
//
// The six source checks all read files. None of them executes a line of client code,
// which is why `export { esc, el, clear } from './ui/dom.js'` shipped: every importer
// resolved, the module parsed, every name was "exported" - and the application died on
// the first line with "Can't find variable: esc", because a re-export does not bind a
// name in the file that writes it.
//
// A browser is the honest place to do this and cannot be used here - Chromium cannot
// fetch http:// and ES modules are CORS-blocked over file://. So the modules are
// imported into Node instead, against a stub DOM. That is not the same as running the
// client, and this does not claim to be: it catches a module that cannot be evaluated,
// which is the failure that matters here, and it catches it before a browser is needed.
//
// What it does not cover: anything that only goes wrong when a function is called with
// a real element, a real event, or a real response. check-flows.js covers the server
// side of that, and nothing covers the browser.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_JS = path.join(__dirname, '..', '..', 'frontend', 'js');

// Enough DOM for module evaluation. Nothing here is meant to be a working browser:
// the elements record what was asked of them and return themselves, which is enough
// for a module that builds a node at import time and nothing more.
function makeElement(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => this._set.add(n)); },
      remove(...names) { names.forEach((n) => this._set.delete(n)); },
      toggle(n, on) { if (on === undefined) { this._set.has(n) ? this._set.delete(n) : this._set.add(n); } else if (on) this._set.add(n); else this._set.delete(n); },
      contains(n) { return this._set.has(n); },
    },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.children.push(c)); },
    prepend(c) { this.children.unshift(c); },
    insertBefore(c) { this.children.unshift(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    replaceChildren() { this.children = []; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    matches() { return false; },
    focus() {},
    blur() {},
    click() {},
    setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    scrollIntoView() {},
    get textContent() { return ''; },
    set textContent(v) { this._text = v; },
    get innerHTML() { return ''; },
    set innerHTML(v) { this._html = v; },
    get value() { return this._value || ''; },
    set value(v) { this._value = v; },
    get offsetParent() { return null; },
    isConnected: true,
    hidden: false,
    disabled: false,
  };
  return node;
}

function installDom() {
  const doc = {
    documentElement: makeElement('html'),
    body: makeElement('body'),
    head: makeElement('head'),
    activeElement: null,
    createElement: (t) => makeElement(t),
    createElementNS: (_ns, t) => makeElement(t),
    createTextNode: (t) => ({ nodeValue: t }),
    createDocumentFragment: () => ({ children: [], appendChild(c) { this.children.push(c); return c; }, append(...c) { c.forEach((x) => this.children.push(x)); } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    execCommand: () => true,
  };
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const win = {
    document: doc,
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '', assign() {}, replace() {}, reload() {} },
    history: { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    localStorage: storage,
    sessionStorage: storage,
    navigator: { userAgent: 'node', language: 'en', languages: ['en'], clipboard: { writeText: async () => {}, readText: async () => '' }, sendBeacon: () => true, share: async () => {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    scrollTo() {}, scrollBy() {}, alert() {}, confirm: () => false, prompt: () => null,
    innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800, devicePixelRatio: 1,
    screen: { width: 1280, height: 800 },
    performance: { now: () => Date.now() },
    crypto: globalThis.crypto,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Event: class { constructor(t) { this.type = t; } preventDefault() {} stopPropagation() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    HTMLElement: class {},
    Node: class {},
    Element: class {},
    Image: class { set src(v) {} },
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.globalThis = win;

  // Node exposes some of these as getter-only globals - navigator, crypto,
  // performance - so plain assignment throws on them.
  const assign = (target, names, value) => {
    for (const n of names) {
      try {
        Object.defineProperty(target, n, { value, writable: true, configurable: true });
      } catch { /* genuinely locked down; the module will report what it misses */ }
    }
  };
  assign(globalThis, ['document'], doc);
  assign(globalThis, ['window', 'self', 'top'], win);
  assign(globalThis, ['localStorage', 'sessionStorage'], storage);
  assign(globalThis, ['navigator'], win.navigator);
  assign(globalThis, ['location'], win.location);
  assign(globalThis, ['history'], win.history);
  assign(globalThis, ['matchMedia', 'getComputedStyle'], win.matchMedia);
  assign(globalThis, ['requestAnimationFrame', 'cancelAnimationFrame'], win.requestAnimationFrame);
  assign(globalThis, ['fetch'], win.fetch);
  assign(globalThis, ['ResizeObserver', 'MutationObserver', 'IntersectionObserver'], win.ResizeObserver);
  assign(globalThis, ['CustomEvent', 'Event'], win.CustomEvent);
  assign(globalThis, ['HTMLElement', 'Node', 'Element'], win.HTMLElement);
  assign(globalThis, ['Image'], win.Image);
  assign(globalThis, ['alert', 'confirm', 'prompt'], win.alert);
  assign(globalThis, ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio'], 1280);
  assign(globalThis, ['scrollTo', 'scrollBy'], () => {});
  return { doc, win };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

(async () => {
  // The client has no package.json of its own, so Node reparses every module as ESM on
  // the way in and warns about the missing type field. That is Node describing its own
  // import path, not anything about the client.
  process.removeAllListeners('warning');
  process.on('warning', () => {});

  const { doc, win } = installDom();

  const files = walk(CLIENT_JS).sort();
  const failures = [];
  let loaded = 0;

  // Importing app.js runs boot(), which paints the chrome against a stub that answers
  // no selectors - so the client's own guarded regions log that they could not find the
  // elements they wanted. That is the harness working, not the client failing, and it
  // would otherwise bury a real error in noise.
  const realConsole = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  for (const file of files) {
    // Node treats a .js file as CommonJS unless the nearest package.json says
    // otherwise, and these are ES modules. Import them by URL so the extension does
    // not decide, which is also how a browser sees them.
    const url = 'file://' + file;
    try {
      const mod = await import(url);
      loaded++;
      // A module whose default export is an object of functions is asserting those
      // exist. Destructuring it is what found `esc`.
      if (mod.default && typeof mod.default === 'object') {
        for (const [k, v] of Object.entries(mod.default)) {
          if (v === undefined) {
            failures.push({ file, why: `default export has "${k}" undefined` });
            break;
          }
        }
      }
    } catch (e) {
      failures.push({ file, why: e && e.message ? e.message.split('\n')[0] : String(e) });
    }
  }

  console.log = realConsole.log;
  console.warn = realConsole.warn;
  console.error = realConsole.error;

  const rel = (f) => path.relative(path.join(__dirname, '..', '..'), f);

  if (failures.length) {
    console.error(`client load check FAILED - ${failures.length} of ${files.length} modules could not be loaded:`);
    for (const f of failures) {
      console.error(`  ${rel(f.file)}`);
      console.error(`    ${f.why}`);
    }
    process.exit(1);
  }

  console.log(`client load check passed (${loaded} modules evaluated against a stub DOM)`);
  void doc; void win;
})();