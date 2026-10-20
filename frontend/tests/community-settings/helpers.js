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
    // The longest matching route wins, so a table can hold both a collection
    // and one of the things inside it.
    const key = Object.keys(routes)
      .filter((route) => String(url).indexOf(route) !== -1)
      .sort((a, b) => b.length - a.length)[0];
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

// The community the console is showing, and the answers the server gives.
export function communityRoutes(overrides) {
  const base = {
    'http://localhost/api/servers/s1/settings': {
      json: {
        welcomeContent: 'Welcome to the community.',
        welcomeEnabled: true,
        guidelines: 'Be kind. No spam.',
        notificationDefaults: '{"messages":true}',
        interactionSettings: '{}',
      },
    },
    'http://localhost/api/servers/s1/bans': { json: [] },
    'http://localhost/api/servers/s1/members': {
      json: {
        items: [
          { id: 'u2', username: 'ada', display_name: 'Ada', nickname: null, roles: [], timeout_expires_at: null },
        ],
        total: 1, hasMore: false,
      },
    },
    'http://localhost/api/servers/s1/channels': {
      json: {
        channels: [{ id: 'ch1', name: 'general', type: 'text', category_id: 'cat1', position: 0 }],
        categories: [{ id: 'cat1', name: 'Text Channels', position: 0 }],
      },
    },
    'http://localhost/api/servers/s1/categories': {
      json: [{ id: 'cat1', name: 'Text Channels', position: 0 }],
    },
    'http://localhost/api/servers/s1/roles': {
      json: [{ id: 'r1', name: 'Moderator', position: 1, permissions: ['KICK_MEMBERS'], is_default: false }],
    },
    'http://localhost/api/servers/s1/roles/permissions': {
      json: {
        all: ['MANAGE_SERVER', 'KICK_MEMBERS'],
        descriptions: { MANAGE_SERVER: 'Full server control.', KICK_MEMBERS: 'Remove members.' },
        permissions: ['*'],
        is_owner: true,
      },
    },
    'http://localhost/api/servers/s1/invites': { json: [] },
    'http://localhost/api/servers/s1/webhooks': {
      json: { webhooks: [{ id: 'w1', name: 'Reports', url: 'https://example.org/hook', channelId: null }] },
    },
    'http://localhost/api/servers/s1/apps': { json: { apps: [] } },
    'http://localhost/api/servers/s1/analytics': { json: { totals: { messages: 10, members: 2 } } },
    'http://localhost/api/voice/capabilities': {
      json: { voiceVideo: { available: true, provider: 'mesh', detail: '' } },
    },
    'http://localhost/api/servers/s1': {
      json: {
        id: 's1',
        name: 'The Community',
        description: 'A place to talk.',
        is_public: true,
        is_discoverable: true,
        federated: true,
        join_code: 'join-me',
        permissions: ['*'],
        is_owner: true,
      },
    },
  };
  return Object.assign(base, overrides || {});
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
//
// The deepest one: a card that holds a button holds the button's text too,
// and the button is what a reader would press.
export function byText(node, text) {
  const holding = find(node, (candidate) => (candidate.textContent || '').indexOf(text) !== -1);
  let deepest = holding[0] || null;
  for (const candidate of holding) {
    if (!deepest) { deepest = candidate; continue; }
    if ((candidate.textContent || '').length < (deepest.textContent || '').length) deepest = candidate;
  }
  return deepest;
}

// The button with the text it carries.
export function buttonByText(node, text) {
  const found = find(node, (candidate) =>
    candidate.tagName === 'BUTTON' && (candidate.textContent || '').indexOf(text) !== -1);
  return found[0] || null;
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

// The overlays that are open.
//
// The document is cleared first, so a dialog left open by an earlier check
// is not mistaken for one this check raised.
export function openOverlays() {
  document.body.replaceChildren();
  return [];
}

export default {
  installFetch, communityRoutes, callsTo, find, byText, buttonByText, buttons, inputs, type,
  communityContext, openOverlays,
};
