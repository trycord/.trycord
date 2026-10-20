// The Mobile module's preferences.
//
// The phone has its own composition and its own choices: how dense the lists
// are, and which destinations the bottom bar carries. They are the phone's
// business, so they live here and not in the desktop module's preferences -
// the two modules never share a store, and a reader who uses both gets an
// arrangement for each.
//
// The key is the phone's own, scoped by the account, so signing in as somebody
// else brings their phone arrangement with them.

import { State } from '../../packages/store.js';

const KEY_PREFIX = 'trycord.mobile';

export const DENSITIES = ['compact', 'cozy', 'comfortable'];

// The destinations the bottom bar may carry. The list is the registry's; this
// is the order they are shown in and which of them the reader keeps.
export const TABS = ['home', 'dms', 'friends', 'notifications', 'menu'];

const DEFAULTS = {
  density: 'cozy',
  tabs: TABS.slice(),
};

let cache = null;
let cacheScope = null;
const listeners = new Set();

function scopeId() {
  const user = State.user;
  return user && user.id ? String(user.id) : 'guest';
}

function storageKey() {
  return KEY_PREFIX + '.' + scopeId();
}

function readStorage() {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalise(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const wanted = Array.isArray(source.tabs) ? source.tabs : DEFAULTS.tabs;
  const tabs = TABS.filter((id) => wanted.indexOf(id) !== -1);
  return {
    density: DENSITIES.indexOf(source.density) !== -1 ? source.density : DEFAULTS.density,
    // A bar with no destination on it is not a bar; the first one is always
    // there.
    tabs: tabs.length ? tabs : DEFAULTS.tabs.slice(),
  };
}

export function readPrefs() {
  const scope = scopeId();
  if (!cache || cacheScope !== scope) {
    cache = normalise(readStorage());
    cacheScope = scope;
  }
  return cache;
}

export function patchPrefs(patch) {
  const next = normalise(Object.assign({}, readPrefs(), patch));
  cache = next;
  cacheScope = scopeId();
  try { localStorage.setItem(storageKey(), JSON.stringify(next)); } catch { /* session-only */ }
  for (const handler of Array.from(listeners)) {
    try { handler(next); } catch { /* a listener must not break the writer */ }
  }
  return next;
}

export function onPrefsChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function rememberDensity(density) {
  return patchPrefs({ density });
}

// Which destinations the bottom bar carries, and in what order.
export function rememberTabs(tabs) {
  return patchPrefs({ tabs });
}

export function applyDensity() {
  const { density } = readPrefs();
  try {
    if (density === DEFAULTS.density) delete document.documentElement.dataset.density;
    else document.documentElement.dataset.density = density;
  } catch { /* no document */ }
  return density;
}

export default {
  readPrefs, patchPrefs, onPrefsChange, rememberDensity, rememberTabs, applyDensity,
  DENSITIES, TABS,
};
