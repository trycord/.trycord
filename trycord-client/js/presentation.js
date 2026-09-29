
const BREAKPOINT = 600;
let modeCache = null; // 'mobile' | 'desktop'
let onChange = null;


export function presentationMode() {
  return modeCache || 'desktop';
}

export function setPresentation(mode) {
  if (mode !== 'mobile' && mode !== 'desktop') mode = 'desktop';
  if (modeCache === mode && modeCache) {
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
  if (mode === 'mobile') {
    const main = document.getElementById('mobile-main');
    if (main) main.scrollTop = 0;
  } else {
    const view = document.getElementById('view-root');
    if (view) view.scrollTop = 0;
  }
}

export function updateFromViewport() {
  const want = window.innerWidth < BREAKPOINT ? 'mobile' : 'desktop';
  setPresentation(want);
  return want;
}


export function isDesktopNavOpen() {
  const shell = document.getElementById('desktop-shell');
  return !!shell && shell.classList.contains('nav-open');
}

export function openDesktopNav() {
  const shell = document.getElementById('desktop-shell');
  const drop = document.getElementById('desktop-backdrop');
  if (!shell) return;
  shell.classList.add('nav-open');
  if (drop) drop.hidden = false;
  const t = shell.querySelector('.nav-toggle');
  if (t) t.setAttribute('aria-expanded', 'true');
}

export function closeDesktopNav() {
  const shell = document.getElementById('desktop-shell');
  const drop = document.getElementById('desktop-backdrop');
  if (!shell) return;
  shell.classList.remove('nav-open');
  if (drop) drop.hidden = true;
  const t = shell.querySelector('.nav-toggle');
  if (t) t.setAttribute('aria-expanded', 'false');
}

export function toggleDesktopNav() {
  if (isDesktopNavOpen()) closeDesktopNav();
  else openDesktopNav();
}

export function onPresentationChange(fn) {
  onChange = fn;
}

const TrycordPresentation = {
  mode: presentationMode,
  set: setPresentation,
  viewport: updateFromViewport,
  openNav: openDesktopNav,
  closeNav: closeDesktopNav,
  toggleNav: toggleDesktopNav,
  isNavOpen: isDesktopNavOpen,
  onChange: onPresentationChange,
};

export { TrycordPresentation };
export default TrycordPresentation;
