
import { TrycordConfig } from './config.js';
import { applyTheme, watchSystemTheme } from './theme.js';
import { updateFromViewport, onPresentationChange } from './presentation.js';
import { hydrate, clearSession, isAuthed, refreshServers, setOnline, setPresence, refreshNotifications, refreshDms, refreshFriends, refreshMutes, setServerRoomHooks } from './state.js';
import Realtime from './realtime.js';
import Router from './router.js';
import { route } from './nav.js';
import { renderAllChrome, loadAnnouncements } from './shell.js';
import { qs } from './ui.js';
import { onFailover, resetFailoverAnnouncement } from './api.js';
import TrycordPresentation from './presentation.js';

let startup = Promise.resolve(null);

// Read by the desktop smoke test (main.js) to report which shell is active.
//
// Under Electron with contextIsolation, properties the isolated preload world
// defines on `window` are non-configurable accessors on the renderer's window.
// A plain assignment to a colliding name throws "Attempted to assign to readonly
// property", and because this runs at module top level it aborts evaluation of
// app.js itself - the app then dies before the router starts, which surfaces as
// the router's "Unable to load this view" screen with no further detail.
//
// defineProperty is used rather than a try/catch: it either installs the
// property with the intended attributes or reports why it could not, and it
// does not leave a half-initialised module behind.
try {
  Object.defineProperty(window, 'TrycordPresentation', {
    value: TrycordPresentation,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch (e) {
  // Nothing reads this outside the desktop smoke test, so a renderer that
  // refuses the property is still a working client.
  console.warn('[trycord] could not expose TrycordPresentation to the page:', e && e.message);
}

async function boot() {
  applyTheme();
  watchSystemTheme();

  // below (session restore, realtime, routes) resolves BACKEND_URL live.
  try { await TrycordConfig.loadStaticConfig(); } catch { /* ignore */ }
  try { await TrycordConfig.loadRuntimeConfig(); } catch { /* ignore */ }

  updateFromViewport();
  TrycordPresentation.wire();
  TrycordPresentation.gestures();
  window.addEventListener('resize', updateFromViewport);
  onPresentationChange(() => {
    Router.run && Router.run();
    renderAllChrome();
  });

  // 3) Session restore. Wire community room hooks first (state must not
  setServerRoomHooks({
    join: (serverId) => Realtime.joinServer(serverId),
    leave: () => Realtime.leaveServer(),
  });
  const restored = await hydrate(); // token->me
  if (restored) {
    // 4) Online gateway (WS) when authenticated.
    Realtime.on('open', () => renderAllChrome());
    Realtime.on('close', () => renderAllChrome());
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
    refreshMutes().catch(() => {});
    loadAnnouncements().catch(() => {});
  } else if (!isAuthed()) {
    // No session: show the public/auth flow on the active shell.
    renderAllChrome();
  }

  const statusEl = qs('#connection-status');
  function paintStatus(on) {
    if (!statusEl) return;
    if (!on) {
      statusEl.classList.add('show');
      statusEl.textContent = 'Offline — reconnecting…';
      return;
    }
    // A failover outlives the connection blip that triggered it: the socket
    // reconnects fine to the backup, so the offline path would hide the fact
    // that this session is now talking to a different instance entirely.
    const moved = TrycordConfig.failover();
    if (moved) paintFailover(statusEl, moved);
    else statusEl.classList.remove('show');
  }

  // Said plainly, with the way back. Accounts live on one instance's database,
  // so someone who lands on the backup without being told sees an empty
  // community list and concludes their account is gone.
  function paintFailover(el, moved) {
    el.classList.add('show');
    el.classList.add('connection-status--notice');
    el.textContent = '';
    const text = document.createElement('span');
    text.textContent = 'Switched to backup instance ' + (moved.name || moved.to)
      + ' — ' + moved.from + ' is unreachable. Your account may not exist there.';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'connection-status__action';
    back.textContent = 'Use original';
    back.addEventListener('click', () => {
      const url = TrycordConfig.clearFailover();
      resetFailoverAnnouncement();
      el.classList.remove('show');
      el.classList.remove('connection-status--notice');
      // The backend URL is resolved per request, so a reload is what makes the
      // original take effect everywhere, including the WebSocket ticket.
      if (url) el.setAttribute('data-restored', url);
      // A real reload is the point - it is what re-resolves every request
      // against the original backend, including the WebSocket ticket.
      //
      // It asks for the app root rather than the current path on purpose: a
      // reload is a request to the server, and a deep path only comes back as
      // the app if the instance has the SPA fallback mounted. Asking for the
      // root cannot fail that way, and the session is restored from the token
      // regardless of which route the reader lands on.
      //
      // route() so that root is the app's root. A bare '/' is the origin's, and
      // on a deployment mounted under /app/ that is the public website.
      location.assign(route('/'));
    });
    el.appendChild(text);
    el.appendChild(back);
  }

  setOnline(true); paintStatus(true);
  window.addEventListener('online', () => { setOnline(true); paintStatus(true); });
  window.addEventListener('offline', () => { setOnline(false); paintStatus(false); });

  // A failover usually happens on the first request that finds the primary
  // down - a click, not page load - so it is announced from here rather than
  // only during boot.
  onFailover(() => { setOnline(true); paintStatus(true); });

  // 5) Router: binds hash navigation and renders the active view.
  Router.init();

  Realtime.on('notification', () => {
    refreshNotifications().catch(() => {});
    renderAllChrome();
  });
}

boot().then(() => { startup = Promise.resolve(true); });

export default { boot };
