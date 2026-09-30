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
}

// Retained names from the two-shell era. They are called by the router and the
// shell, and the behaviour they named is now the drawer's.
export const isDesktopNavOpen = isNavOpen;
export const openDesktopNav = openNav;
export const closeDesktopNav = closeNav;
export const toggleDesktopNav = toggleNav;

const TrycordPresentation = {
  mode: presentationMode,
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