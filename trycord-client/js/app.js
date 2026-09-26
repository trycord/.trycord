// Trycord client entrypoint (ES module).
// Boot order: theme -> runtime config -> presentation -> shell wiring -> realtime -> router.

import { TrycordConfig } from './config.js';
import { applyTheme } from './theme.js';
import { updateFromViewport, closeMobileDrawer, openMobileDrawer, onPresentationChange, setPresentation, initMobileGestures } from './presentation.js';
import { hydrate, clearSession, isAuthed, refreshServers, setOnline, setPresence, refreshNotifications, refreshDms, refreshFriends, setServerRoomHooks } from './state.js';
import Realtime from './realtime.js';
import Router from './router.js';
import { renderAllChrome } from './shell.js';
import { qs } from './ui.js';
import TrycordPresentation from './presentation.js';

let startup = Promise.resolve(null);

window.TrycordPresentation = TrycordPresentation;

async function boot() {
  // 0) Theme (persisted, single source in theme.js; idempotent with the
  //    inline bootstrap in index.html).
  applyTheme();

  // 1) Backend configuration: static backend.json first (operator pin),
  // then the server-provided runtime config. Both best-effort. Everything
  // below (session restore, realtime, routes) resolves BACKEND_URL live.
  try { await TrycordConfig.loadStaticConfig(); } catch { /* ignore */ }
  try { await TrycordConfig.loadRuntimeConfig(); } catch { /* ignore */ }

  // 2) Presentation depends on geometry only.
  updateFromViewport();
  window.addEventListener('resize', updateFromViewport);
  onPresentationChange(() => {
    Router.run && Router.run();
    renderAllChrome();
  });

  // 3) Mobile drawer controls.
  const navToggle = qs('#mobile-nav-toggle');
  if (navToggle) {
    navToggle.addEventListener('click', () => {
      if (document.getElementById('mobile-navigation').classList.contains('open')) closeMobileDrawer();
      else openMobileDrawer();
    });
  }
  const actionsBtn = qs('#mobile-actions');
  if (actionsBtn) actionsBtn.addEventListener('click', (e) => {
    // placeholder: same as opening the drawer from the right edge
    openMobileDrawer();
  });

  // Drawer gestures (edge swipe, drag-to-close, back/backdrop/Escape close).
  initMobileGestures();

  // 4) Session restore. Wire community room hooks first (state must not
  // import realtime directly — realtime imports state).
  setServerRoomHooks({
    join: (serverId) => Realtime.joinServer(serverId),
    leave: () => Realtime.leaveServer(),
  });
  const restored = await hydrate(); // token->me
  if (restored) {
    // 5) Online gateway (WS) when authenticated.
    Realtime.on('open', () => renderAllChrome());
    Realtime.on('close', () => renderAllChrome());
    // Presence flips are cheap state but expensive paint: a busy server
    // can emit many per second, and every one repainted the whole chrome
    // (F4). Apply state immediately, debounce the repaint; the trailing
    // call always converges to the latest presence map.
    let presencePaint = null;
    Realtime.on('presence', (p) => {
      setPresence(p.userId, p.presence);
      clearTimeout(presencePaint);
      presencePaint = setTimeout(() => renderAllChrome(), 750);
    });
    Realtime.connect();
    refreshServers().catch(() => {});
    refreshNotifications().catch(() => {});
    refreshDms().catch(() => {});
    refreshFriends().catch(() => {});
  } else if (!isAuthed()) {
    // No session: show the public/auth flow on the active shell.
    renderAllChrome();
  }

  // Offline/online banner (connection status).
  const statusEl = qs('#connection-status');
  function paintStatus(on) {
    if (!statusEl) return;
    if (!on) {
      statusEl.classList.add('show');
      statusEl.textContent = 'Offline — reconnecting…';
    } else {
      statusEl.classList.remove('show');
    }
  }
  setOnline(true); paintStatus(true);
  window.addEventListener('online', () => { setOnline(true); paintStatus(true); });
  window.addEventListener('offline', () => { setOnline(false); paintStatus(false); });

  // 6) Router: binds hash navigation and renders the active view.
  Router.init();

  // 7) Keep shell chrome in sync on every realtime notification.
  Realtime.on('notification', () => {
    refreshNotifications().catch(() => {});
    renderAllChrome();
  });
}

boot().then(() => { startup = Promise.resolve(true); });

export default { boot };
