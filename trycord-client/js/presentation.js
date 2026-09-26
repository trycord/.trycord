// Presentation. Chooses and applies the active shell (mobile vs desktop)
// based on real geometry, not platform sniffing. Both shells live in the
// supplied index.html; only one is visible at a time.

const BREAKPOINT = 900;
let modeCache = null; // 'mobile' | 'desktop'
let onChange = null;
let gestureInit = false;
let backMark = false;

// Drawer gesture thresholds (spec §52). Single source — no magic numbers
// scattered through the gesture handlers.
const GESTURE = {
  EDGE_WIDTH: 24,            // px: left-edge region that starts an open drag
  OPEN_THRESHOLD: 44,        // px: rightward drag that opens the drawer
  CLOSE_THRESHOLD: 72,       // px: leftward drag that closes the drawer
  VELOCITY_THRESHOLD: 0.4,   // px/ms: momentum that completes a gesture
  MAX_DRAG_DISTANCE: 320,    // px: cap for live-drag translation
};

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

// ---- desktop pop-out rail -------------------------------------------------
// The presence spine is off-canvas on desktop (see CSS). These helpers
// own the open state. Null-safe: with no spine element they no-op.

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
  // Back action closes the drawer without changing the route.
  if (!backMark) {
    backMark = true;
    try { history.pushState({ trycordDrawer: true }, ''); } catch { /* ignore */ }
  }
}

export function closeMobileDrawer() {
  const drawer = document.getElementById('mobile-navigation');
  const toggle = document.getElementById('mobile-nav-toggle');
  if (!drawer) return;
  drawer.classList.remove('open');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  // Focus restoration: if focus was inside the drawer, send it back to the
  // control that opened it.
  if (drawer.contains(document.activeElement) && toggle && typeof toggle.focus === 'function') {
    try { toggle.focus(); } catch { /* ignore */ }
  }
}

// ---- drawer gestures (spec §51/§52/§53) ----------------------------------

let activeGesture = null;

function drawerWidth() {
  const d = document.getElementById('mobile-navigation');
  return d ? d.getBoundingClientRect().width : GESTURE.MAX_DRAG_DISTANCE;
}

function endGesture() {
  const g = activeGesture;
  activeGesture = null;
  const d = document.getElementById('mobile-navigation');
  if (!g || !d) return;
  const dx = Math.max(-GESTURE.MAX_DRAG_DISTANCE, Math.min(GESTURE.MAX_DRAG_DISTANCE, g.lastX - g.startX));
  const dt = g.lastT - g.startT;
  const vx = dt > 0 ? (g.lastX - g.startX) / dt : 0;
  d.classList.remove('dragging');
  d.style.transform = '';
  if (g.mode === 'open') {
    // Incomplete below the threshold: drawer stays closed (already restored).
    return;
  }
  if (g.axis !== 'v') {
    if (dx <= -GESTURE.CLOSE_THRESHOLD || vx <= -GESTURE.VELOCITY_THRESHOLD) closeMobileDrawer();
    // else the cleared transform lets the CSS transition restore the drawing.
  }
}

function initMobileGestures() {
  if (gestureInit) return;
  gestureInit = true;

  const onPointerDown = (e) => {
    if (presentationMode() !== 'mobile') return;
    const drawer = document.getElementById('mobile-navigation');
    if (!drawer) return;
    if (isMobileDrawerOpen()) {
      activeGesture = { mode: 'close', startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, startT: e.timeStamp, lastT: e.timeStamp, axis: null };
    } else if (e.clientX <= GESTURE.EDGE_WIDTH) {
      // Left-edge swipe toward the panel opens the drawer.
      activeGesture = { mode: 'open', startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, startT: e.timeStamp, lastT: e.timeStamp, axis: null };
    } else {
      return;
    }
    try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e) => {
    const g = activeGesture;
    if (!g) return;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    g.lastT = e.timeStamp;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.axis === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }
    if (g.axis === 'v') return; // leave vertical scrolling to the browser
    const d = document.getElementById('mobile-navigation');
    if (!d) return;
    const width = drawerWidth();
    d.classList.add('dragging');
    if (g.mode === 'open') {
      if (dx >= GESTURE.OPEN_THRESHOLD) {
        d.classList.remove('dragging');
        d.style.transform = '';
        openMobileDrawer();
        activeGesture = null;
        return;
      }
      d.style.transform = 'translateX(' + (Math.min(Math.max(0, dx), GESTURE.MAX_DRAG_DISTANCE) - width) + 'px)';
    } else {
      d.style.transform = 'translateX(' + Math.max(-GESTURE.MAX_DRAG_DISTANCE, Math.min(0, dx)) + 'px)';
    }
  };

  const onPointerEnd = (e) => {
    if (!activeGesture) return;
    if (activeGesture.mode === 'open' && (e.clientX - activeGesture.startX) >= GESTURE.OPEN_THRESHOLD) {
      openMobileDrawer();
      const d = document.getElementById('mobile-navigation');
      if (d) { d.classList.remove('dragging'); d.style.transform = ''; }
      activeGesture = null;
      return;
    }
    endGesture();
  };

  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerEnd);
  document.addEventListener('pointercancel', onPointerEnd);

  // Back action closes the drawer before it ever reaches the router.
  window.addEventListener('popstate', () => {
    if (isMobileDrawerOpen()) closeMobileDrawer();
  });

  // Escape closes the drawer (accessible close).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMobileDrawerOpen()) closeMobileDrawer();
  });
  // Escape closes the desktop pop-out rail; backdrop click too.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDesktopNavOpen()) closeDesktopNav();
  });
  const drop = document.getElementById('desktop-backdrop');
  if (drop) drop.addEventListener('click', () => closeDesktopNav());

  // Tap outside — the backdrop covers everything the drawer does not.
  const backdrop = document.getElementById('mobile-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => closeMobileDrawer());
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
  openNav: openDesktopNav,
  closeNav: closeDesktopNav,
  toggleNav: toggleDesktopNav,
  isNavOpen: isDesktopNavOpen,
  onChange: onPresentationChange,
  initGesture: initMobileGestures,
  GESTURE,
};

export { TrycordPresentation };
export { initMobileGestures, GESTURE };
export default TrycordPresentation;