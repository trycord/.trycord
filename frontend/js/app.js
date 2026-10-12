// The entry point. Boots the application in order.
//
// 1. Build the shell (tree + chrome)
// 2. Load theme
// 3. Load config
// 4. Load session
// 5. Connect realtime
// 6. Start router

import { buildShell } from './app-shell.js';
import { applyTheme, watchSystemTheme } from './theme.js';
import { TrycordConfig } from './config.js';
import Realtime from './realtime.js';
import Router from './router.js';
import { route } from './nav.js';
import { initConnectionStatus, setConnectionOnline } from './connection-status.js';
import { hydrate, isAuthed, setOnline, refreshServers, refreshNotifications, refreshDms, refreshFriends, refreshMutes, refreshBlocks } from './state.js';
import { loadWellbeing } from './privacy-ui.js';
import { onFailover } from './api.js';
import { loadAnnouncements, renderAnnouncementBanner, renderVerifyBanner } from './shell/banners.js';

// Read by the desktop smoke test
try {
  Object.defineProperty(window, 'TrycordShell', {
    value: { buildShell },
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch (e) {
  console.warn('[trycord] could not expose TrycordShell:', e?.message);
}

/** Which backend this instance talks to, before anything asks the server. */
async function loadConfig() {
  try { await TrycordConfig.loadStaticConfig(); } catch { /* fallback to origin */ }
  try { await TrycordConfig.loadRuntimeConfig(); } catch { /* pin is optional */ }
}

/** Warm the caches the shell and first page need. */
function warmCaches() {
  const warm = (p) => p.catch(() => {});
  warm(refreshServers());
  warm(refreshNotifications());
  warm(refreshDms());
  warm(refreshFriends());
  warm(refreshMutes());
  warm(refreshBlocks());
}

/** Boot sequence. */
async function boot() {
  // 1. Theme first - before any paint
  applyTheme();
  watchSystemTheme();

  // 2. Config
  await loadConfig();

  // 3. Shell
  const shell = buildShell({
    // These will be populated after session loads
    onNavigate: route,
    onProfileClick: () => route('/settings'),
    onSettingsClick: () => route('/settings'),
    onLogout: () => { /* handled by auth */ },
    onChannelClick: (ch) => route(`/server/${ch.server_id}/channel/${ch.id}`),
    onCategoryToggle: (catId) => { /* shell handles */ },
    onChannelContextMenu: (ch, e) => { /* context menu */ },
    onDmClick: (dm) => route(`/dms/${dm.id}`),
    onSearch: () => { /* open search modal */ },
    onPinClick: () => { /* open pins */ },
    onMemberListClick: () => { /* open member list */ },
    onChannelSettingsClick: () => { /* channel settings */ },
    onMemberClick: (m) => route(`/users/${m.user_id}`),
    onMemberAction: (m, el) => { /* member actions menu */ },
  });

  // 4. Session
  await hydrate();

  // 5. Realtime. connect() is what asks the server for a gateway ticket, so it has to
  // be called rather than waited for: the listeners alone observe a socket that nothing
  // opened. It is called after the session exists because it needs one to authenticate.
  Realtime.on('open', () => { setConnectionOnline(true); setOnline(true); });
  Realtime.on('close', () => { setConnectionOnline(false); setOnline(false); });
  Realtime.connect();

  // 6. Router - last, after shell and session exist. Both the router and the
  // gateway are singletons rather than classes: one each per document.
  Router.init();

  // Warm the caches the rail badges and the first page both read from. These are
  // fired, not awaited: a slow one must not hold the first paint.
  warmCaches();

  // Wellbeing
  loadWellbeing();

  // Announcements
  loadAnnouncements();
  renderAnnouncementBanner();
  renderVerifyBanner();

  // Connection status
  initConnectionStatus();

  // Expose for debugging
  window.Trycord = { shell, router: Router, realtime: Realtime };
}

// The boot promise. Everything that renders after this is settled. The render harness
// awaits it, and so should anything else that needs a fully-started application rather
// than one that has been asked to start.
export const ready = boot();

// Reached only if a step outside the two recoverable ones threw, because the two that
// can fail handle themselves. Left to reject rather than swallowed: a caller awaiting
// `ready` has to be able to see it.
ready.catch((err) => {
  console.error('[trycord] boot failed:', err);
});

export { boot };
export default { boot, ready };