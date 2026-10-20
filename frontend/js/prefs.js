// Workspace preferences.
//
// How dense the interface is, how wide the three resizable columns are, which
// regions of the workspace are shown and which inspector tab the reader left
// open per screen kind. One key, one shape, one reader - the shell and the
// settings screen both go through here, so there is never a second copy of
// "how wide is the context column".
//
// The preferences belong to the account, not to the browser: two people who
// share a machine each get their own arrangement, and signing in as somebody
// else brings their arrangement with them. The key is therefore scoped by the
// reader's id.
//
// Storage being unavailable (private windows, a locked-down webview) degrades
// to in-memory preferences for the session rather than an exception on boot.

import { State } from '../packages/store.js';

const KEY_PREFIX = 'trycord.workspace';

export const DENSITIES = ['compact', 'cozy', 'comfortable'];

export const CONTEXT_MIN = 232;
export const CONTEXT_MAX = 400;
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 520;
export const STAGE_MIN = 480;
export const STAGE_MAX = 1920;

// The three regions of the workspace the reader may arrange. The rail holds the
// communities, the column holds the current place's navigation, and the
// inspector holds the panel beside the stage.
export const REGIONS = ['rail', 'column', 'inspector'];

const DEFAULTS = {
  density: 'cozy',
  contextWidth: 276,
  inspectorWidth: 336,
  // The reading measure of the stage. Wider than a comfortable column, because
  // a conversation is a column of messages and not a page of prose.
  stageWidth: 1180,
  // Which regions of the workspace are shown. All three by default.
  regions: { rail: true, column: true, inspector: true },
  // Which inspector tab the reader left open, per screen kind ('channel',
  // 'home', 'profile'). A kind that is absent has never been opened.
  inspectorTabs: {},
  // Screen kinds whose inspector was left open when the reader navigated away.
  inspectorOpen: [],
};

let cache = null;
let cacheScope = null;
const listeners = new Set();

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

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

function normaliseRegions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const region of REGIONS) out[region] = source[region] !== false;
  return out;
}

function normalise(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    density: DENSITIES.indexOf(source.density) !== -1 ? source.density : DEFAULTS.density,
    contextWidth: clamp(source.contextWidth, CONTEXT_MIN, CONTEXT_MAX, DEFAULTS.contextWidth),
    inspectorWidth: clamp(source.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX, DEFAULTS.inspectorWidth),
    stageWidth: clamp(source.stageWidth, STAGE_MIN, STAGE_MAX, DEFAULTS.stageWidth),
    regions: normaliseRegions(source.regions),
    inspectorTabs: source.inspectorTabs && typeof source.inspectorTabs === 'object'
      ? Object.assign({}, source.inspectorTabs)
      : {},
    inspectorOpen: Array.isArray(source.inspectorOpen) ? source.inspectorOpen.slice(0, 12) : [],
  };
}

export function readPrefs() {
  const scope = scopeId();
  // The reader changed: the cached arrangement belongs to somebody else.
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

// Remember where a panel drag ended, without writing on every pointermove: the
// caller passes the live width while dragging and calls commit once at the end.
export function rememberContextWidth(width) {
  return patchPrefs({ contextWidth: clamp(width, CONTEXT_MIN, CONTEXT_MAX, DEFAULTS.contextWidth) });
}

export function rememberInspectorWidth(width) {
  return patchPrefs({ inspectorWidth: clamp(width, INSPECTOR_MIN, INSPECTOR_MAX, DEFAULTS.inspectorWidth) });
}

export function rememberStageWidth(width) {
  return patchPrefs({ stageWidth: clamp(width, STAGE_MIN, STAGE_MAX, DEFAULTS.stageWidth) });
}

export function rememberInspectorTab(kind, tab) {
  if (!kind || !tab) return readPrefs();
  const tabs = Object.assign({}, readPrefs().inspectorTabs, { [kind]: tab });
  return patchPrefs({ inspectorTabs: tabs });
}

export function rememberInspectorOpen(kind, open) {
  if (!kind) return readPrefs();
  const current = readPrefs().inspectorOpen.filter((entry) => entry !== kind);
  if (open) current.push(kind);
  return patchPrefs({ inspectorOpen: current });
}

// Which regions are shown. The reader chooses; the choice is remembered.
export function rememberRegions(regions) {
  const next = normaliseRegions(regions);
  return patchPrefs({ regions: next });
}

export function regionEnabled(region) {
  return readPrefs().regions[region] !== false;
}

// The regions are a word list on the shell root, so the stylesheet can answer
// "is this region shown" with one attribute selector and the shell does not have
// to hide and show anything itself.
export function applyRegions(root) {
  if (!root) return;
  const regions = readPrefs().regions;
  const shown = REGIONS.filter((region) => regions[region] !== false);
  root.setAttribute('data-regions', shown.join(' '));
  return shown;
}

export function applyDensity() {
  const { density } = readPrefs();
  try {
    if (density === DEFAULTS.density) delete document.documentElement.dataset.density;
    else document.documentElement.dataset.density = density;
  } catch { /* no document */ }
  return density;
}

// The three measurable widths, as CSS custom properties on the shell root.
export function applyLayoutWidths(root) {
  if (!root) return;
  const prefs = readPrefs();
  root.style.setProperty('--context-w', prefs.contextWidth + 'px');
  root.style.setProperty('--inspector-w', prefs.inspectorWidth + 'px');
  root.style.setProperty('--stage-w', prefs.stageWidth + 'px');
}

export default {
  readPrefs, patchPrefs, onPrefsChange, rememberContextWidth, rememberInspectorWidth,
  rememberStageWidth, rememberInspectorTab, rememberInspectorOpen, rememberRegions,
  regionEnabled, applyDensity, applyLayoutWidths, applyRegions,
  DENSITIES, REGIONS,
  CONTEXT_MIN, CONTEXT_MAX, INSPECTOR_MIN, INSPECTOR_MAX, STAGE_MIN, STAGE_MAX,
};
