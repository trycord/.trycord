
import { TrycordConfig } from './config.js';
import { applyTheme, watchSystemTheme } from './theme.js';
import { updateFromViewport, onPresentationChange } from './presentation.js';
import { hydrate, clearSession, isAuthed, refreshServers, setOnline, setPresence, refreshNotifications, refreshDms, refreshFriends, refreshMutes, setServerRoomHooks } from './state.js';
import Realtime from './realtime.js';
import Router from './router.js';
import { renderAllChrome, loadAnnouncements } from './shell.js';
import { qs } from './ui.js';
import TrycordPresentation from './presentation.js';

let startup = Promise.resolve(null);

window.TrycordPresentation = TrycordPresentation;

async function boot() {
  applyTheme();
  watchSystemTheme();

  // below (session restore, realtime, routes) resolves BACKEND_URL live.
  try { await TrycordConfig.loadStaticConfig(); } catch { /* ignore */ }
  try { await TrycordConfig.loadRuntimeConfig(); } catch { /* ignore */ }

  updateFromViewport();
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
      statusEl.textContent = 'Offline â€” reconnectingâ€¦';
    } else {
      statusEl.classList.remove('show');
    }
  }
  setOnline(true); paintStatus(true);
  window.addEventListener('online', () => { setOnline(true); paintStatus(true); });
  window.addEventListener('offline', () => { setOnline(false); paintStatus(false); });

  // 5) Router: binds hash navigation and renders the active view.
  Router.init();

  Realtime.on('notification', () => {
    refreshNotifications().catch(() => {});
    renderAllChrome();
  });
}

boot().then(() => { startup = Promise.resolve(true); });

export default { boot };
