// Which frontend module a reader gets.
//
// Trycord ships two independent presentation modules - the Desktop tree under
// frontend/js and the Mobile tree under frontend/mobile - served from one origin.
// Nothing in either module decides which of them a reader should be looking at:
// this does, once, and both entries read the same answer, so the rule cannot
// drift between them.
//
// The decision is deliberately narrow. It is made from the viewport the reader
// actually has and a remembered explicit choice, never from a User-Agent guess,
// and it only ever picks between two entry documents. It never initializes one
// module in order to hide it, and it never mounts both.

export const PRESENTATION_KEY = 'trycord.presentation';

// The width below which a viewport is phone-shaped. The Mobile module is a
// separate document, not a responsive layer over the desktop one, so this is used
// only to decide which document a reader is sent to.
export const MOBILE_MAX_WIDTH = 600;

export const ENTRY_DESKTOP = 'desktop';
export const ENTRY_MOBILE = 'mobile';

function store() {
  try { return window.localStorage; } catch { return null; }
}

// The reader's explicit choice, if they made one. Only the two known values are
// honoured: anything else is treated as "no choice", so a corrupted or hostile
// value cannot pin somebody to a module that does not exist.
export function readOverride() {
  const ls = store();
  if (!ls) return null;
  let value;
  try { value = ls.getItem(PRESENTATION_KEY); } catch { return null; }
  return value === ENTRY_DESKTOP || value === ENTRY_MOBILE ? value : null;
}

export function setOverride(value) {
  const ls = store();
  if (!ls) return;
  try {
    if (value === ENTRY_DESKTOP || value === ENTRY_MOBILE) ls.setItem(PRESENTATION_KEY, value);
    else ls.removeItem(PRESENTATION_KEY);
  } catch { /* storage disabled: the session default is the fallback */ }
}

export function clearOverride() {
  const ls = store();
  if (!ls) return;
  try { ls.removeItem(PRESENTATION_KEY); } catch { /* nothing to clear */ }
}

// Whether the viewport the reader has right now is phone-shaped. A coarse
// pointer (a finger, no precise hover) makes a wide tablet count as mobile too,
// which is the case a width test alone gets wrong.
export function viewportWantsMobile(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return false;
  let narrow = false;
  try { narrow = w.innerWidth < MOBILE_MAX_WIDTH; } catch { narrow = false; }
  let coarse = false;
  try {
    coarse = !!w.matchMedia && w.matchMedia('(pointer: coarse)').matches
      && !w.matchMedia('(hover: hover)').matches;
  } catch { coarse = false; }
  return narrow || coarse;
}

// The pure decision, so it can be reasoned about and tested without a DOM: an
// explicit choice outranks the viewport, and the viewport is the fallback.
export function resolvePresentation(override, wantsMobile) {
  if (override === ENTRY_DESKTOP || override === ENTRY_MOBILE) return override;
  return wantsMobile ? ENTRY_MOBILE : ENTRY_DESKTOP;
}

// What to do for a reader on `current` (a 'desktop' or 'mobile' entry). Returns
// the entry they should be on. Equal means "stay"; different means the caller
// hands them to the other entry document.
export function preferredEntry(current, opts) {
  const o = opts || {};
  const override = o.override !== undefined ? o.override : readOverride();
  const wantsMobile = o.wantsMobile !== undefined ? o.wantsMobile : viewportWantsMobile(o.window);
  return resolvePresentation(override, wantsMobile);
}

// The mount of the other module, relative to this origin. Both are server
// mounts, not routes: handing a reader across is one document load, not a route
// change inside whichever module is already running.
//
// `entry` is the module the caller is running in and `base` is that module's own
// mount (nav.js BASE). The desktop tree is the client root; the mobile tree lives
// one directory under it, so the two are related by exactly that one segment
// rather than by a pair of hard-coded paths.
export function siblingMount(entry, base) {
  const mount = base === undefined || base === null ? '' : String(base);
  const clean = mount === '/' ? '' : mount.replace(/\/$/, '');
  return entry === ENTRY_MOBILE ? clean.replace(/\/mobile$/, '') : clean + '/mobile';
}

export default {
  PRESENTATION_KEY, MOBILE_MAX_WIDTH, ENTRY_DESKTOP, ENTRY_MOBILE,
  readOverride, setOverride, clearOverride,
  viewportWantsMobile, resolvePresentation, preferredEntry, siblingMount,
};
