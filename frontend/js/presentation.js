// Presentation.
//
// One question - is this a phone or a wide screen - answered once and written to
// <html data-presentation>, so the stylesheet arranges one tree rather than three.
// The same module owns the drawer on a narrow screen: open, close, focus, Escape
// and the edge swipe, because all of those are the drawer being a drawer rather
// than the shell's business. The shell owns the one backdrop, because it is the
// backdrop for the context panel too.

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
  // A drawer left open across a rotation would sit over a column that is back.
  if (next === 'desktop') closeNav();
  const scroller = document.getElementById('view-root');
  if (scroller) scroller.scrollTop = 0;
  if (onChange) {
    try { onChange(next); } catch { /* a listener is not the layout's problem */ }
  }
  return next;
}

export function updateFromViewport() {
  const width = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024;
  return setPresentation(width < BREAKPOINT ? 'mobile' : 'desktop');
}

export function onPresentationChange(fn) {
  onChange = fn;
}

// ---- the drawer ------------------------------------------------------------
//
// The spine (#spine) is a column on a wide screen and a drawer on a phone. "Is
// navigation open" is one attribute on #shell - the same one the stylesheet draws the
// drawer and its scrim from - so the state, the scrim and the focus trap cannot
// disagree about whether it is open. It is asked of the spine rather than of the rail
// the shell no longer has: the spine is the one navigation column at every breakpoint.

export function isNavOpen() {
  const shell = document.getElementById('shell');
  return !!shell && shell.dataset.drawer === 'spine';
}

export function openNav() {
  const shell = document.getElementById('shell');
  if (!shell || shell.dataset.drawer === 'spine') return;
  returnFocus = document.activeElement;
  shell.dataset.drawer = 'spine';
  document.documentElement.classList.add('is-nav-open');
  const toggle = document.querySelector('.nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  const spine = document.getElementById('spine');
  const first = spine && spine.querySelector('a[href], button:not([disabled]), input');
  if (first && first.focus) first.focus();
}

export function closeNav() {
  const shell = document.getElementById('shell');
  if (shell && shell.dataset.drawer === 'spine') shell.dataset.drawer = 'closed';
  document.documentElement.classList.remove('is-nav-open');
  const toggle = document.querySelector('.nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (returnFocus && typeof returnFocus.focus === 'function') {
    try { returnFocus.focus(); } catch { /* the element may be gone */ }
  }
  returnFocus = null;
}

export function toggleNav() {
  if (isNavOpen()) closeNav();
  else openNav();
}

// The drawer is modal, so it behaves like one: Escape closes it and Tab stays
// inside it for as long as it is open.
function drawerKeys(event) {
  if (!isNavOpen()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeNav();
    return;
  }
  if (event.key !== 'Tab') return;
  const spine = document.getElementById('spine');
  if (!spine) return;
  const focusable = [...spine.querySelectorAll('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => node.offsetParent !== null || node === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const at = document.activeElement;
  if (event.shiftKey && (at === first || !spine.contains(at))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && at === last) {
    event.preventDefault();
    first.focus();
  }
}

// ---- edge swipe ------------------------------------------------------------
//
// A drawer that cannot be swiped is half a drawer. Three things it must not do:
// hijack a vertical scroll, hijack a horizontal scroller (the community strip
// scrolls sideways inside), or leave the drawer parked when the gesture stops.

const EDGE_ZONE = 24;
const COMMIT_DIST = 56;
const AXIS_LOCK = 1.5;

function horizontallyScrollable(node) {
  let n = node && node.nodeType === 1 ? node : (node && node.parentElement);
  for (; n && n !== document.body; n = n.parentElement) {
    const overflowX = getComputedStyle(n).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') return true;
  }
  return false;
}

export function wireDrawerGestures() {
  let id = null;
  let x0 = 0;
  let y0 = 0;
  let axis = null;
  let width = 0;
  let wasOpen = false;
  let offset = 0;

  const drawerEl = () => document.getElementById('spine');

  function begin(event) {
    if (presentationMode() !== 'mobile') return;
    if (event.touches.length !== 1) return;
    const hit = event.target;
    if (hit && typeof hit.closest === 'function'
      && hit.closest('button, a[href], input, textarea, select')) return;
    wasOpen = isNavOpen();
    const x = event.touches[0].clientX;
    if (!wasOpen && x > EDGE_ZONE) return;
    if (horizontallyScrollable(event.target)) return;
    id = event.touches[0].identifier;
    x0 = x;
    y0 = event.touches[0].clientY;
    axis = null;
    offset = 0;
    const drawer = drawerEl();
    if (!drawer) return;
    width = drawer.getBoundingClientRect().width || 1;
    drawer.style.transition = 'none';
    if (wasOpen) drawer.style.transform = 'translateX(0)';
  }

  function release() {
    const drawer = drawerEl();
    if (!drawer) return;
    drawer.style.transition = '';
    drawer.style.transform = '';
  }

  function move(event) {
    if (id === null) return;
    const touch = [...event.touches].find((t) => t.identifier === id);
    if (!touch) return;
    const dx = touch.clientX - x0;
    const dy = touch.clientY - y0;
    if (axis === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis = Math.abs(dx) > Math.abs(dy) * AXIS_LOCK ? 'x' : 'y';
      if (axis === 'y') { id = null; release(); return; }
    }
    if (event.cancelable) event.preventDefault();
    offset = Math.max(-width, Math.min(width, dx));
    const drawer = drawerEl();
    if (drawer) drawer.style.transform = `translateX(${offset}px)`;
  }

  function end() {
    if (id === null) return;
    id = null;
    release();
    if (wasOpen ? offset < -COMMIT_DIST : offset > COMMIT_DIST) {
      if (wasOpen) closeNav();
      else openNav();
    } else if (wasOpen !== isNavOpen()) {
      if (wasOpen) openNav();
      else closeNav();
    }
  }

  document.addEventListener('touchstart', begin, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}

export function wireNav() {
  document.addEventListener('keydown', drawerKeys);
  window.addEventListener('resize', () => { updateFromViewport(); });
}

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
