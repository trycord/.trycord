// The Trycord Mobile application.
//
// The new concept: one hand, three doors. This entry claims its mount, applies
// the theme, mounts the shell, loads the session and what the reader keeps,
// connects the realtime gateway, binds the screens the phone answers, and runs
// the address. It shares the platform packages and the desktop's ui logic
// modules, and nothing of the desktop's chrome.

import { mountShell, paintScreen, paintComposer, refreshChrome, setConnection } from './shell.js';
import { applyTheme } from '../../packages/theme.js';
import { TrycordConfig } from '../../packages/config.js';
import {
  State, on as onStore, loadInstance, loadLegal, loadSession,
  refreshServers, refreshFederated, refreshDms, refreshFriends, refreshNotifications,
  markConversationRead,
} from '../../packages/store.js';
import { installLinkHandler, installPopStateHandler, setBase, mountFromModuleUrl } from '../../packages/nav.js';
import { loadLocale } from '../../packages/locale.js';
import realtime, { on as onRealtime, EVENTS, E2EE_EVENTS } from '../../packages/realtime.js';
import { setLocalUserId } from '../../packages/voiceSession.js';
import * as encrypted from '../../js/ui/encrypted.js';
import { bind, renderPage, matchRoute } from '../../packages/registry.js';
import { RENDERERS } from './views/index.js';
import { run } from './router.js';

setBase(mountFromModuleUrl(import.meta.url));
bind(RENDERERS);

function mount() {
  const root = mountShell();
  const host = document.getElementById('app');
  if (host) host.appendChild(root);
  else document.body.appendChild(root);
  refreshChrome();

  // The gateway's state is the banner's state: offline says the words wait.
  onRealtime('status', (status) => {
    if (status === 'online') setConnection('', '');
    else if (status === 'connecting') setConnection('connecting', 'Connecting');
    else setConnection('offline', 'Offline - reconnecting');
  });
}

function setSession(state) {
  try { document.documentElement.dataset.session = state; } catch { /* no document */ }
}

function wireNavigation() {
  installLinkHandler();
  installPopStateHandler();
  window.addEventListener('trycord:navigate', () => { run().catch(() => { /* the next address answers */ }); });
}

function wireRealtime() {
  onRealtime('status', (status) => { /* the shell keeps its own offline note */ void status; });
  let openedBefore = false;
  onRealtime('open', () => {
    if (!openedBefore) { openedBefore = true; return; }
    if (!State.user) return;
    Promise.allSettled([refreshDms(), refreshFriends(), refreshNotifications()])
      .then(() => { refreshChrome(); run().catch(() => {}); });
  });
  onRealtime('notification', () => { refreshNotifications().catch(() => {}); });
  // A conversation read on this account's other device clears its pip here.
  // A read by somebody else is their reading, not this account's.
  onRealtime(EVENTS.DM_READ, (event) => {
    const reader = event.userId || event.user_id;
    const me = State.user && State.user.id;
    if (reader && me && String(reader) !== String(me)) return;
    const id = event.conversationId || event.conversation_id || event.id;
    if (markConversationRead(id)) refreshChrome();
  });
  // A conversation key moved: the encryption surface drops its cached answer.
  onRealtime(E2EE_EVENTS.KEY_CHANGE, (event) => {
    encrypted.keyChanged(event);
  });
  onStore('user', () => { refreshChrome(); });
  onStore('notifications', () => { refreshChrome(); });
  onStore('dms', () => { refreshChrome(); });
}

async function boot() {
  applyTheme();
  mount();
  wireNavigation();
  setLocalUserId(() => (State.user && State.user.id) || '');

  try { await TrycordConfig.loadStaticConfig(); } catch { /* the backend resolves from the origin */ }
  await Promise.allSettled([loadInstance(), loadLegal()]);

  try {
    await loadSession();
    encrypted.ready().catch(() => { /* the You screen reports it */ });
  } catch {
    State.user = null;
  }
  setSession(State.user ? 'in' : 'out');
  setLocalUserId(() => (State.user && State.user.id) || '');

  try { await loadLocale(); } catch { /* the built-in language stands */ }

  if (State.user) {
    await Promise.allSettled([
      refreshServers(), refreshFederated(), refreshDms(), refreshFriends(), refreshNotifications(),
    ]);
    realtime.connect();
  }

  wireRealtime();
  await run();
}

export const ready = boot();
export default { ready };
