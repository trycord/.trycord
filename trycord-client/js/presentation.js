// Presentation. Chooses and applies the active shell (mobile vs desktop)
// based on real geometry, not platform sniffing. Both shells live in the
// supplied index.html; only one is visible at a time.

const BREAKPOINT = 900;
let modeCache = null; // 'mobile' | 'desktop'
let onChange = null;

export function presentationMode() {
  return modeCache || 'desktop';
}

export function setPresentation(mode) {
  if (mode !== 'mobile' && mode !== 'desktop') mode = 'desktop';
  if (modeCache === mode && modeCache) {
    // Still need the DOM correct on first call.
    return mode;
  }
  modeCache = mode;
  apply(mode);
  if (onChange) try { onChange(mode); } catch { /* ignore */ }
  return mode;
}

function apply(mode) {
  const mobile = document.getElementById('mobile-shell');
  const desktop = document.getElementById('desktop-shell');
  if (!mobile || !desktop) return;
  mobile.hidden = mode !== 'mobile';
  desktop.hidden = mode !== 'desktop';
  document.documentElement.dataset.presentation = mode;
  // Keep focus/scroll sane across presentation switches.
  if (mode === 'mobile') {
    const main = document.getElementById('mobile-main');
    if (main) main.scrollTop = 0;
  } else {
    const view = document.getElementById('view-root');
    if (view) view.scrollTop = 0;
  }
  closeMobileDrawer();
}

export function updateFromViewport() {
  const want = window.innerWidth < BREAKPOINT ? 'mobile' : 'desktop';
  setPresentation(want);
  return want;
}

// ---- mobile drawer --------------------------------------------------------

export function isMobileDrawerOpen() {
  const drawer = document.getElementById('mobile-navigation');
  return !!drawer && drawer.classList.contains('open');
}

export function openMobileDrawer() {
  const drawer = document.getElementById('mobile-navigation');
  const toggle = document.getElementById('mobile-nav-toggle');
  if (!drawer) return;
  drawer.hidden = false;
  drawer.classList.add('open');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

export function closeMobileDrawer() {
  const drawer = document.getElementById('mobile-navigation');
  const toggle = document.getElementById('mobile-nav-toggle');
  if (!drawer) return;
  drawer.classList.remove('open');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

export function onPresentationChange(fn) {
  onChange = fn;
}

const TrycordPresentation = {
  mode: presentationMode,
  set: setPresentation,
  viewport: updateFromViewport,
  openDrawer: openMobileDrawer,
  closeDrawer: closeMobileDrawer,
  isDrawerOpen: isMobileDrawerOpen,
  onChange: onPresentationChange,
};

export { TrycordPresentation };
export default TrycordPresentation;