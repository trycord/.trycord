// Workspace preferences.
//
// How dense the interface is, how wide the two resizable columns are, and which
// inspector tab the reader left open per screen kind. One key, one shape, one
// reader - the shell and the settings screen both go through here, so there is
// never a second copy of "how wide is the context column".
//
// Storage being unavailable (private windows, a locked-down webview) degrades
// to in-memory preferences for the session rather than an exception on boot.

const KEY = 'trycord.workspace';

export const DENSITIES = ['compact', 'cozy', 'comfortable'];

export const CONTEXT_MIN = 232;
export const CONTEXT_MAX = 400;
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 520;

const DEFAULTS = {
  density: 'cozy',
  contextWidth: 276,
  inspectorWidth: 336,
  // Which inspector tab the reader left open, per screen kind ('channel',
  // 'home', 'profile'). A kind that is absent has never been opened.
  inspectorTabs: {},
  // Screen kinds whose inspector was left open when the reader navigated away.
  inspectorOpen: [],
};

let cache = null;
const listeners = new Set();

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readStorage() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalise(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    density: DENSITIES.indexOf(source.density) !== -1 ? source.density : DEFAULTS.density,
    contextWidth: clamp(source.contextWidth, CONTEXT_MIN, CONTEXT_MAX, DEFAULTS.contextWidth),
    inspectorWidth: clamp(source.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX, DEFAULTS.inspectorWidth),
    inspectorTabs: source.inspectorTabs && typeof source.inspectorTabs === 'object'
      ? Object.assign({}, source.inspectorTabs)
      : {},
    inspectorOpen: Array.isArray(source.inspectorOpen) ? source.inspectorOpen.slice(0, 12) : [],
  };
}

export function readPrefs() {
  if (!cache) cache = normalise(readStorage());
  return cache;
}

export function patchPrefs(patch) {
  const next = normalise(Object.assign({}, readPrefs(), patch));
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* session-only */ }
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

export function applyDensity() {
  const { density } = readPrefs();
  try {
    if (density === DEFAULTS.density) delete document.documentElement.dataset.density;
    else document.documentElement.dataset.density = density;
  } catch { /* no document */ }
  return density;
}

// The two measurable column widths, as CSS custom properties on the shell root.
export function applyLayoutWidths(root) {
  if (!root) return;
  const prefs = readPrefs();
  root.style.setProperty('--context-w', prefs.contextWidth + 'px');
  root.style.setProperty('--inspector-w', prefs.inspectorWidth + 'px');
}

export default {
  readPrefs, patchPrefs, onPrefsChange, rememberContextWidth, rememberInspectorWidth,
  rememberInspectorTab, rememberInspectorOpen, applyDensity, applyLayoutWidths,
  DENSITIES, CONTEXT_MIN, CONTEXT_MAX, INSPECTOR_MIN, INSPECTOR_MAX,
};
