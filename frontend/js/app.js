// The entry point. Boots the application, in order, once.
//
// The order is the whole content of this file, and it is not arbitrary:
//
//   1. the tree    - every region renderer addresses an element by id, so the tree has
//                    to exist before anything that paints. This is why the shell cannot
//                    be built by the page that happens to render first.
//   2. the theme   - before anything is read, so the first paint is already the reader's
//                    theme rather than a flash of the default.
//   3. the config  - which backend this instance talks to. Nothing below reaches the
//                    server until this has been asked.
//   4. the shell   - viewport, drawer wiring, and the listener that repaints when the
//                    window changes shape between phone and desktop.
//   5. the session - who this is, or that they are nobody. Everything after this point
//                    may show signed-in surfaces.
//   6. realtime    - the gateway, which needs a session to get a ticket for.
//   7. the router  - last, because a route is rendered against a shell that already
//                    exists and a session that is already known.
//
// Steps 3 and 5 are the only two that are allowed to fail on their own, because each has
// a fallback a reader can see: a backend that cannot be asked falls back to the origin
// that served the page, and a session that cannot be restored is a signed-out session
// the login surface already handles. Everything else is left to throw, so a failure
// reaches crash.js and paints the crash screen rather than leaving a blank document.

import { buildTree, renderAllChrome, loadAnnouncements } from './shell.js';
import { applyTheme, watchSystemTheme } from './theme.js';
import { TrycordConfig } from './config.js';
import TrycordPresentation, { updateFromViewport, onPresentationChange } from './presentation.js';
import {
  hydrate, isAuthed, setOnline, setPresence, setServerRoomHooks,
  refreshServers, refreshNotifications, refreshDms, refreshFriends,
  refreshMutes, refreshBlocks,
} from './state.js';
import { loadWellbeing } from './privacy-ui.js';
import Realtime from './realtime.js';
import Router from './router.js';
import { route } from './nav.js';
import { onFailover } from './api.js';
import { initConnectionStatus, setConnectionOnline } from './connection-status.js';

// Read by the desktop smoke test (trycord-desktop/main.js) to report which shell is
// active.
//
// defineProperty rather than assignment: under Electron with contextIsolation, properties
// the isolated preload world defines on `window` are non-configurable accessors on the
// renderer's window. A plain assignment to a colliding name throws, and because this runs
// at module top level it aborts evaluation of app.js itself - the app then dies before
// the router starts, which surfaces as the router's "Unable to load this view" screen
// with no further detail.
try {
  Object.defineProperty(window, 'TrycordPresentation', {
    value: TrycordPresentation,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch (e) {
  // Nothing reads this outside the desktop smoke test, so a renderer that refuses the
  // property is still a working client.
  console.warn('[trycord] could not expose TrycordPresentation to the page:', e && e.message);
}

/** Which backend this instance talks to, before anything asks the server a question. */
async function loadConfig() {
  try { await TrycordConfig.loadStaticConfig(); } catch { /* the serving origin is the fallback */ }
  try { await TrycordConfig.loadRuntimeConfig(); } catch { /* an operator's pin is an optimisation */ }
}

/** Warm the caches the shell and the first page both need. */
function warmCaches() {
  // None of these gate the boot. The surface a reader lands on fetches what it needs
  // itself, and reports it if that fails - making the boot wait would mean an unreachable
  // server keeps the app from starting, and the connection indicator is already how being
  // offline gets said out loud.
  const warm = (p) => { p.catch(() => {}); };
  warm(refreshServers());
  warm(refreshNotifications());
  warm(refreshDms());
  warm(refreshFriends());
  warm(refreshMutes());
  warm(refreshBlocks());
  warm(loadAnnouncements());
  warm(loadWellbeing());
}

/** The gateway, once there is a session to get a ticket for. */
function connectRealtime() {
  Realtime.on('open', () => renderAllChrome());
  Realtime.on('close', () => renderAllChrome());
  // Coalesced: a busy room emits a burst of presence changes, and repainting the chrome
  // for each one is how a rail came to flicker while a dozen people came online.
  let presencePaint = null;
  Realtime.on('presence', (p) => {
    setPresence(p.userId, p.presence);
    clearTimeout(presencePaint);
    presencePaint = setTimeout(() => renderAllChrome(), 750);
  });
  Realtime.connect();
}

async function boot() {
  // 1) The tree, first. Every renderer below addresses a region by id.
  buildTree();

  // 2) The theme, before anything is read.
  applyTheme();
  watchSystemTheme();

  // 3) The backend this instance talks to.
  await loadConfig();

  // 4) The shell: viewport, drawer, gestures, and the shape-change listener.
  updateFromViewport();
  TrycordPresentation.wire();
  TrycordPresentation.gestures();
  window.addEventListener('resize', updateFromViewport);
  // A rotation or a window resize crosses the phone breakpoint, and the shell is shaped
  // differently on each side of it. The route is re-run so the page under it gets the
  // composition it declared rather than the one it inherited.
  onPresentationChange(() => {
    if (Router.run) Router.run();
    renderAllChrome();
  });

  // 5) The session. Community room hooks are wired first, because state must not import
  //    realtime and realtime imports state - this is the seam between them.
  const restored = await hydrate();

  if (restored) {
    // 6) The gateway, and the caches it and the first page share.
    connectRealtime();
    warmCaches();
  } else if (!isAuthed()) {
    // No session: paint the signed-out shell so the sign-in surface has somewhere to be.
    renderAllChrome();
  }

  // The connection indicator, which has to exist before the first request can fail.
  initConnectionStatus(setOnline);
  // A failover usually happens on the first request that finds the primary down - a click,
  // not page load - so it is announced from here rather than only during boot.
  onFailover(() => { setConnectionOnline(true); });

  // 7) The router, last. A route is rendered against a shell that already exists and a
  //    session that is already known.
  Router.init();

  // Once the socket is up, a notification is a count that changed. In that order:
  // refreshNotifications() writes to state and returns; it does not repaint. Repainting
  // straight after it painted the badge with the count from before the request went out,
  // and nothing repainted once the new count landed - so the badge stayed on the old
  // number until the next notification arrived, the only thing that could correct it.
  Realtime.on('notification', async () => {
    await refreshNotifications().catch(() => {});
    renderAllChrome();
  });
}

// Exported so a caller that wants to wait for the boot waits for this one rather than
// starting a second. The render harness does exactly that.
export const ready = boot();

export default { boot, ready };
