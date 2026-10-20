// A DOM small enough to import the client in Node.
//
// The client is built for a browser, but the parts of it that decide what a
// page is - the registry, the renderer tables, the gates, the content model -
// are plain JavaScript that only touch the document when a view is drawn. This
// is enough of a document to draw one: elements that hold children and
// attributes, a selector engine for the few queries the client makes, and
// events that can be dispatched.
//
// It is deliberately not a browser: nothing here lays out, and nothing here
// fetches. What it does is let a check ask a form a question and hear the
// answer.

const REFLECTED = ['value', 'checked', 'disabled', 'hidden', 'selected', 'type', 'name', 'id'];

// One simple selector: a tag, some classes, an id, some attributes, and the
// things it must NOT be.
function parseSimple(piece) {
  const simple = { tag: null, id: null, classes: [], attrs: [], not: [] };
  const re = /:not\(([^)]*)\)|([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let match;
  while ((match = re.exec(piece))) {
    if (match[1]) {
      // :not(...) - the simple selectors inside it are the ones the node must
      // NOT match. The client uses this to find the items a reader may act
      // on, so a stub that cannot parse it cannot test the keyboard path.
      for (const inner of match[1].split(',')) {
        const trimmed = inner.trim();
        if (trimmed) simple.not.push(parseSimple(trimmed));
      }
    } else if (match[2]) simple.tag = match[2].toUpperCase();
    else if (match[3]) simple.classes.push(match[3]);
    else if (match[4]) simple.id = match[4];
    else if (match[5]) simple.attrs.push([match[5], match[6] === undefined ? null : match[6]]);
  }
  return simple;
}

function parseSelector(selector) {
  return String(selector).split(',').map((part) => part.trim()).filter(Boolean)
    .map((part) => part.split(/\s+/).map(parseSimple));
}

function attrOf(node, name) {
  const value = node.getAttribute(name);
  if (value !== null) return value;
  const property = node[name];
  return property === undefined || property === null ? null : String(property);
}

function matchesSimple(node, simple) {
  if (simple.tag && node.tagName !== simple.tag) return false;
  if (simple.id && node.getAttribute('id') !== simple.id) return false;
  for (const name of simple.classes) {
    if (!node.classList.contains(name)) return false;
  }
  for (const [name, value] of simple.attrs) {
    const actual = attrOf(node, name);
    if (actual === null) return false;
    if (value !== null && actual !== value) return false;
  }
  for (const excluded of simple.not || []) {
    if (matchesSimple(node, excluded)) return false;
  }
  return true;
}

function matchesChain(node, chain) {
  if (!matchesSimple(node, chain[chain.length - 1])) return false;
  let index = chain.length - 2;
  let current = node.parentNode;
  while (index >= 0) {
    if (!current) return false;
    if (matchesSimple(current, chain[index])) index -= 1;
    current = current.parentNode;
  }
  return true;
}

// The client asks whether a value is a node before it appends it, so the
// elements here have to be instances of the same base the document is.
class DomNode {}

function makeElement(doc, tagName) {
  const node = Object.assign(Object.create(DomNode.prototype), {
    tagName: String(tagName).toUpperCase(),
    nodeType: 1,
    attributes: {},
    children: [],
    parentNode: null,
    style: {
      setProperty(name, value) { this[name] = value; },
      getPropertyValue(name) { return this[name] === undefined ? '' : this[name]; },
      removeProperty(name) { delete this[name]; },
    },
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    files: [],
    listeners: new Map(),
  });

  node.classList = {
    contains(name) { return String(node.getAttribute('class') || '').split(/\s+/).includes(name); },
    add(...names) {
      const current = String(node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      for (const name of names) if (!current.includes(name)) current.push(name);
      node.setAttribute('class', current.join(' '));
    },
    remove(...names) {
      const current = String(node.getAttribute('class') || '').split(/\s+/).filter(Boolean)
        .filter((name) => !names.includes(name));
      node.setAttribute('class', current.join(' '));
    },
    toggle(name, on) {
      const has = node.classList.contains(name);
      const next = on === undefined ? !has : !!on;
      if (next) node.classList.add(name);
      else node.classList.remove(name);
      return next;
    },
  };

  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.getAttribute = (name) => (name in node.attributes ? node.attributes[name] : null);
  node.removeAttribute = (name) => { delete node.attributes[name]; };
  node.hasAttribute = (name) => name in node.attributes;
  // dataset is the DOM's view of the data-* attributes, so writing to it has to
  // be seen as an attribute: a stylesheet and a check both read it that way.
  const datasetValues = {};
  node.dataset = new Proxy(datasetValues, {
    get(target, prop) { return target[prop]; },
    set(target, prop, value) {
      target[prop] = value;
      node.setAttribute('data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), value);
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      node.removeAttribute('data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
      return true;
    },
  });
  // The DOM name for the class attribute, which the client reads and writes.
  Object.defineProperty(node, 'className', {
    get() { return node.getAttribute('class') || ''; },
    set(value) { node.setAttribute('class', value); },
    configurable: true,
  });
  // The text of a node is the text of what it holds, and setting it replaces
  // what it held.
  let ownText = '';
  Object.defineProperty(node, 'textContent', {
    get() {
      if (!node.children.length) return ownText;
      return node.children.map((child) => (child && child.textContent) || '').join('');
    },
    set(value) {
      ownText = value === null || value === undefined ? '' : String(value);
      for (const child of node.children) if (child) child.parentNode = null;
      node.children = [];
    },
    configurable: true,
  });

  node.appendChild = (child) => {
    if (child && child.parentNode) child.parentNode.removeChild(child);
    node.children.push(child);
    if (child) child.parentNode = node;
    return child;
  };
  node.insertBefore = (child, before) => {
    const index = node.children.indexOf(before);
    node.children.splice(index === -1 ? node.children.length : index, 0, child);
    if (child) child.parentNode = node;
    return child;
  };
  node.removeChild = (child) => {
    node.children = node.children.filter((one) => one !== child);
    if (child) child.parentNode = null;
    return child;
  };
  node.replaceChildren = (...children) => {
    for (const child of node.children) if (child) child.parentNode = null;
    node.children = [];
    for (const child of children) node.appendChild(child);
  };
  // The DOM's own names for the same thing: childNodes is children, and
  // append() is appendChild() over several children at once.
  Object.defineProperty(node, 'childNodes', {
    get() { return node.children; },
    configurable: true,
  });
  // firstChild and lastChild. The stub answers to the names the DOM uses, and
  // a helper that empties a node by removing its first child until there is
  // none emptied nothing at all - so the node kept what it had and the new
  // content was added to it rather than replacing it.
  Object.defineProperty(node, 'firstChild', {
    get() { return node.children[0] || null; },
    configurable: true,
  });
  Object.defineProperty(node, 'lastChild', {
    get() { return node.children[node.children.length - 1] || null; },
    configurable: true,
  });
  node.append = (...children) => {
    for (const child of children) node.appendChild(child);
  };
  // The DOM's way of putting something next to an element. The client uses it
  // to put a note under a button, and the double did not have it - so a
  // screen that put a note under a button could not be drawn in a check at
  // all.
  node.insertAdjacentElement = (position, element) => {
    if (!element || !node.parentNode) return null;
    const parent = node.parentNode;
    const index = parent.children.indexOf(node);
    const at = position === 'beforebegin' || position === 'afterbegin' ? index
      : position === 'afterend' ? index + 1 : index;
    parent.children.splice(at, 0, element);
    element.parentNode = parent;
    return element;
  };
  // The nearest ancestor that matches, the element itself included.
  node.closest = (selector) => {
    const chains = parseSelector(selector);
    let current = node;
    while (current) {
      for (const chain of chains) if (matchesChain(current, chain)) return current;
      current = current.parentNode;
    }
    return null;
  };
  // The element's own box. The double has no layout, so this is the size
  // every element reports: enough for a check that asks whether something
  // fits, and honest about not knowing.
  node.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    x: 0, y: 0,
  });
  node.scrollIntoView = () => {};
  node.prepend = (...children) => {
    for (const child of children.reverse()) node.insertBefore(child, node.children[0] || null);
  };
  node.remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
  node.contains = (other) => {
    if (other === node) return true;
    return node.children.some((child) => child && child.contains && child.contains(other));
  };

  node.addEventListener = (type, handler) => {
    if (!node.listeners.has(type)) node.listeners.set(type, new Set());
    node.listeners.get(type).add(handler);
  };
  node.removeEventListener = (type, handler) => {
    const set = node.listeners.get(type);
    if (set) set.delete(handler);
  };
  node.dispatch = (type, event) => {
    const payload = Object.assign({ type, target: node, preventDefault() {}, stopPropagation() {} }, event || {});
    for (const handler of Array.from(node.listeners.get(type) || [])) handler(payload);
    return payload;
  };
  node.click = () => node.dispatch('click');
  node.submit = () => node.dispatch('submit');
  node.focus = () => { doc.activeElement = node; };
  node.blur = () => { if (doc.activeElement === node) doc.activeElement = null; };
  node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  node.scrollIntoView = () => {};

  node.querySelectorAll = (selector) => {
    const chains = parseSelector(selector);
    const found = [];
    const walk = (current) => {
      for (const child of current.children) {
        if (!child || !child.tagName) continue;
        for (const chain of chains) if (matchesChain(child, chain)) found.push(child);
        walk(child);
      }
    };
    walk(node);
    return found;
  };
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;

  return node;
}

export function installDomStub() {
  const doc = {};
  doc.activeElement = null;
  doc.createElement = (tag) => makeElement(doc, tag);
  doc.createElementNS = (ns, tag) => makeElement(doc, tag);
  doc.createTextNode = (text) => Object.assign(Object.create(DomNode.prototype), {
    nodeType: 3, textContent: String(text), parentNode: null,
  });
  doc.createDocumentFragment = () => makeElement(doc, 'fragment');
  doc.documentElement = makeElement(doc, 'html');
  doc.body = makeElement(doc, 'body');
  doc.head = makeElement(doc, 'head');
  doc.getElementById = () => null;
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);
  doc.contains = (node) => doc.body.contains(node);
  doc.title = '';

  // The document and the window are real event targets.
  //
  // They used to swallow every listener, which meant that anything the client
  // does in response to a key, a click outside, a resize or a scroll could not
  // be tested at all: a menu that closes on Escape, a dialog that closes on a
  // click outside it, a menu that stays open when it is scrolled - all
  // untestable, and therefore all unverified.
  //
  // The listeners are stored and called in the order they were added, and a
  // capture-phase listener is called for an event on any descendant, which is
  // how the window really behaves.
  function makeEventTarget() {
    const handlers = new Map();
    return {
      addEventListener(type, handler, options) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push({ handler, capture: !!(options && options.capture) });
      },
      removeEventListener(type, handler) {
        const list = handlers.get(type);
        if (!list) return;
        const index = list.findIndex((entry) => entry.handler === handler);
        if (index !== -1) list.splice(index, 1);
      },
      // The DOM's own way: hand it an event that already exists.
      dispatchEvent(event) {
        const type = event && event.type;
        for (const list of Array.from(handlers.get(type) || [])) {
          list.handler(event);
        }
        return true;
      },
      // The event's own target, so a listener can ask where it came from.
      dispatch(type, payload) {
        const event = Object.assign({
          type,
          target: null,
          preventDefault() {},
          stopPropagation() {},
        }, payload || {});
        for (const list of Array.from(handlers.values())) {
          for (const entry of list.slice()) {
            if (entry.capture && event.target && event.target !== this
              && !(event.target && event.target.contains
                && event.target.contains(this))) {
              // A capture listener on the window sees an event aimed at any
              // element in the document.
            }
            entry.handler(event);
          }
        }
        return event;
      },
    };
  }
  const documentTarget = makeEventTarget();
  doc.addEventListener = documentTarget.addEventListener;
  doc.removeEventListener = documentTarget.removeEventListener;
  doc.dispatch = documentTarget.dispatch;
  doc.dispatchEvent = documentTarget.dispatchEvent;

  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
    clear: () => { storage.clear(); },
    // The DOM's own way of asking what is stored, so a check can look without
    // reaching into the stub's innards.
    get length() { return storage.size; },
    key: (index) => Array.from(storage.keys())[index] || null,
  };

  const media = { matches: false, addEventListener() {}, removeEventListener() {} };

  const windowTarget = makeEventTarget();
  globalThis.window = {
    document: doc,
    localStorage,
    matchMedia: () => media,
    addEventListener: windowTarget.addEventListener,
    removeEventListener: windowTarget.removeEventListener,
    dispatch: windowTarget.dispatch,
    dispatchEvent: windowTarget.dispatchEvent,
    location: {
      href: 'http://localhost/', pathname: '/', origin: 'http://localhost',
      protocol: 'http:', search: '', host: 'localhost',
    },
    history: { state: null, pushState() {}, replaceState() {} },
    innerWidth: 1280,
    innerHeight: 800,
    scrollTo() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    // The event's own methods. A client that calls preventDefault on an
    // event must not be told it is not a function.
    Event: class Event {
      constructor(type) {
        this.type = type;
        this.defaultPrevented = false;
        this.propagationStopped = false;
      }
      preventDefault() { this.defaultPrevented = true; }
      stopPropagation() { this.propagationStopped = true; }
    },
  };
  globalThis.document = doc;
  globalThis.Node = DomNode;
  globalThis.localStorage = localStorage;
  globalThis.matchMedia = () => media;
  // Node has a navigator of its own, and it is not writable: the clipboard is
  // the only part of it the client touches, so it is added rather than
  // replaced.
  try {
    if (!globalThis.navigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: async () => {} } },
        configurable: true,
        writable: true,
      });
    }
  } catch { /* the platform's navigator is enough */ }
  globalThis.DOMParser = class DOMParser {
    parseFromString() {
      return { body: { firstElementChild: null, querySelectorAll: () => [] } };
    }
  };

  return { window: globalThis.window, document: doc, localStorage };
}

// A fetch that answers from a table, and records what it was asked. The
// client's own request() is the only thing that calls it, so what it receives
// is what the client would have sent.
export function installFetchStub(routes) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body, options: options || {} });
    const route = routes[String(url)];
    const answer = route ? (typeof route === 'function' ? route(body, calls) : route) : { ok: true, json: {} };
    return {
      ok: answer.ok !== false,
      status: answer.status || 200,
      statusText: answer.statusText || 'OK',
      headers: { get: () => null },
      json: async () => answer.json || {},
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return calls;
}

// Wait for a condition to hold, rather than for a fixed time.
//
// A test that sleeps for a fixed number of milliseconds passes on an idle
// machine and fails on a busy one, which is a test that reports on the
// machine rather than on the client.
export async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    let value = null;
    try { value = predicate(); } catch { /* the condition is not true yet */ }
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export default { installDomStub, installFetchStub, waitFor };
