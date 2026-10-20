// The checks of the community settings console.
//
// The helpers here are shared by the checks beside this file: a fetch that
// answers from a table of routes, and a way to find a control in a drawn
// page.

import { installDomStub } from '../helpers/dom-stub.js';

installDomStub();

// A fetch that answers from a table of routes, matched by the beginning of
// the address.
//
// The client's own request() is the only thing that calls it, so what it
// receives is what the client would have sent. The calls are recorded, so a
// check can ask what was written and not only what was drawn.
export function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const opts = options || {};
    const body = opts.body ? JSON.parse(opts.body) : null;
    const call = { url: String(url), body, method: opts.method || 'GET' };
    calls.push(call);
    const key = Object.keys(routes).find((route) => String(url).indexOf(route) !== -1);
    const answer = key
      ? (typeof routes[key] === 'function' ? routes[key](body, calls) : routes[key])
      : { ok: true, json: {} };
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

// The calls that were made to one address.
export function callsTo(calls, fragment) {
  return calls.filter((call) => call.url.indexOf(fragment) !== -1);
}

// Every node in a tree that a predicate accepts.
export function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

// The first node with the text it carries.
export function byText(node, text) {
  return find(node, (candidate) => (candidate.textContent || '').indexOf(text) !== -1)[0] || null;
}

// The buttons of a tree, in the order they were drawn.
export function buttons(node) {
  return find(node, (candidate) => candidate.tagName === 'BUTTON');
}

// The text inputs of a tree.
export function inputs(node) {
  return find(node, (candidate) => candidate.tagName === 'INPUT' || candidate.tagName === 'TEXTAREA');
}

// Type into a field: what a reader does, and what the section listens for.
export function type(field, value) {
  field.value = value;
  field.dispatch('input', {});
}

// The community the console is showing.
export function communityContext() {
  return {
    serverId: 's1',
    params: { id: 's1' },
    rest: [],
    page: { id: 'community.settings' },
  };
}

export default { installFetch, callsTo, find, byText, buttons, inputs, type, communityContext };
