const BREAKPOINT = 600;
let onChange = null;
let returnFocus = null;


export function presentationMode() {
  return document.documentElement.dataset.presentation === 'mobile' ? 'mobile' : 'desktop';
}

export function setPresentation(mode) {
  const next = mode === 'mobile' ? 'mobile' : 'desktop';
  const prev = presentationMode();
  document.documentElement.dataset.presentation = next;
  if (next === prev) return next;
  // Leaving the drawer open across a rotation would leave an overlay with no
  // column behind it, so the layout change closes it.
  if (next === 'desktop') closeNav();
  const scroller = document.getElementById('view-root');
  if (scroller) scroller.scrollTop = 0;
  if (onChange) try { onChange(next); } catch { /* ignore */ }
  return next;
}

export function updateFromViewport() {
  return setPresentation(window.innerWidth < BREAKPOINT ? 'mobile' : 'desktop');
}


// The rail is permanent on desktop and an overlay on mobile, but it is the same
// element, so "is navigation showing" is one question with one answer.
export function isNavOpen() {
  const rail = document.getElementById('app-rail');
  return !!rail && rail.dataset.open === 'true';
}

export function openNav() {
  const rail = document.getElementById('app-rail');
  if (!rail || rail.dataset.open === 'true') return;
  // Captured before the first control is focused, or the drawer would hand
  // focus straight back to itself on close.
  returnFocus = document.activeElement;
  rail.dataset.open = 'true';
  const backdrop = document.getElementById('desktop-backdrop');
  if (backdrop) backdrop.hidden = false;
  const toggle = rail.ownerDocument.querySelector('.nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  const first = rail.querySelector('a[href], button:not([disabled]), input');
  if (first && first.focus) first.focus();
}

export function closeNav() {
  const rail = document.getElementById('app-rail');
  if (!rail || rail.dataset.open !== 'true') return;
  rail.dataset.open = 'false';
  const backdrop = document.getElementById('desktop-backdrop');
  if (backdrop) backdrop.hidden = true;
  const toggle = rail.ownerDocument.querySelector('.nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (returnFocus && typeof returnFocus.focus === 'function') {
    try { returnFocus.focus(); } catch { /* ignore */ }
  }
  returnFocus = null;
}

export function toggleNav() {
  if (isNavOpen()) closeNav();
  else openNav();
}

export function onPresentationChange(fn) {
  onChange = fn;
}


// The drawer is modal, so it has to behave like one: Escape closes it, and Tab
// cycles inside it rather than walking out into the view it is covering. On a
// wide viewport the same rail is an ordinary column rather than an overlay, so
// there is nothing to trap and both branches stand down.
function drawerKeys(e) {
  if (presentationMode() !== 'mobile' || !isNavOpen()) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeNav();
    return;
  }
  if (e.key !== 'Tab') return;

  const rail = document.getElementById('app-rail');
  const f = [...rail.querySelectorAll('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !rail.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

export function wireNav() {
  document.addEventListener('keydown', drawerKeys);
  // Tapping the dimmed area beside the drawer is how a drawer gets closed on a
  // phone - more often than the gesture, and the only way for anyone using a
  // pointer with a keyboard-free setup. Escape and the swipe are alternatives to
  // this, not replacements for it: without it the scrim is a picture of a door.
  const backdrop = document.getElementById('desktop-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      if (isNavOpen()) closeNav();
    });
  }
}


// --- swipe ----------------------------------------------------------------
//
// A drawer you cannot swipe is half a drawer: on a phone the edge swipe is the
// fastest way in and the flick is the fastest way out.
//
// Three things it must not do, or it makes the app worse than no gesture:
// hijack a vertical scroll, hijack a horizontal scroller (the community strip
// scrolls sideways inside the drawer), or leave the drawer parked mid-way when
// the gesture is abandoned.

// px from the left edge that begins an open gesture.
const EDGE_ZONE = 24;
// px of travel that commits the open or close.
const COMMIT_DIST = 56;
// horizontal travel must beat vertical by this much to win the gesture.
const AXIS_LOCK = 1.5;

function horizontallyScrollable(node) {
  // The target can be the document or a text node, neither of which has a
  // style or a parentElement.
  let n = node && node.nodeType === 1 ? node : (node && node.parentElement);
  for (; n && n !== document.body; n = n.parentElement) {
    const ox = getComputedStyle(n).overflowX;
    if (ox === 'auto' || ox === 'scroll') return true;
  }
  return false;
}

export function wireDrawerGestures() {
  let id = null;
  let x0 = 0, y0 = 0;
  let axis = null;          // 'x' once the gesture is known horizontal
  let width = 0;
  let wasOpen = false;
  let offset = 0;           // live travel, negative = closed

  const railEl = () => document.getElementById('app-rail');

  function begin(e) {
    if (presentationMode() !== 'mobile') return;
    if (e.touches.length !== 1) return;
    // A control press is a tap, not a drag. closest() only exists on elements,
    // and a touch can legitimately land on the document or a text node.
    const hit = e.target;
    if (hit && typeof hit.closest === 'function'
      && hit.closest('button, a[href], input, textarea, select')) return;

    wasOpen = isNavOpen();
    const x = e.touches[0].clientX;
    if (!wasOpen && x > EDGE_ZONE) return;          // closed: edge only
    if (horizontallyScrollable(e.target)) return;    // let the strip scroll

    id = e.touches[0].identifier;
    x0 = x; y0 = e.touches[0].clientY;
    axis = null;
    offset = 0;
    const rail = railEl();
    if (!rail) return;
    width = rail.getBoundingClientRect().width || 1;
    // Detach from the open/closed transform so the finger can drive it directly.
    rail.style.transition = 'none';
    if (wasOpen) rail.style.transform = 'translateX(0)';
  }

  // Hand the drawer back to the stylesheet. Called on every exit path: a gesture
  // that turns out to be a vertical scroll must not leave `transition: none`
  // inline, or the drawer never animates again.
  function release() {
    const rail = railEl();
    if (!rail) return;
    rail.style.transition = '';
    rail.style.transform = '';
  }

  function move(e) {
    if (id === null) return;
    const t = [...e.touches].find((x) => x.identifier === id);
    if (!t) return;
    const dx = t.clientX - x0;
    const dy = t.clientY - y0;

    if (axis === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;   // not decided yet
      // Decided on the larger axis, with a bias toward vertical so a sideways
      // drift while scrolling does not capture the gesture.
      axis = Math.abs(dx) > Math.abs(dy) * AXIS_LOCK ? 'x' : 'y';
      if (axis === 'y') { id = null; release(); return; }
    }
    if (e.cancelable) e.preventDefault();

    // Opening travels positive, closing negative; past either end it stops.
    offset = Math.max(-width, Math.min(width, dx));
    const rail = railEl();
    if (rail) rail.style.transform = `translateX(${offset}px)`;
  }

  function end() {
    if (id === null) return;
    id = null;
    const rail = railEl();
    release();
    if (!rail) return;
    if (wasOpen ? offset < -COMMIT_DIST : offset > COMMIT_DIST) {
      if (wasOpen) closeNav(); else openNav();
    } else if (wasOpen !== isNavOpen()) {
      // Came back short: snap to whichever end it started from.
      if (wasOpen) openNav(); else closeNav();
    }
  }

  document.addEventListener('touchstart', begin, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}

// Retained names from the two-shell era. They are called by the router and the
// shell, and the behaviour they named is now the drawer's.
export const isDesktopNavOpen = isNavOpen;
export const openDesktopNav = openNav;
export const closeDesktopNav = closeNav;
export const toggleDesktopNav = toggleNav;

const TrycordPresentation = {
  mode: presentationMode,
  gestures: wireDrawerGestures,
  set: setPresentation,
  viewport: updateFromViewport,
  openNav,
  closeNav,
  toggleNav,
  isNavOpen,
  wire: wireNav,
  onChange: onPresentationChange,
};

export { TrycordPresentation };
export default TrycordPresentation;