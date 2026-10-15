// The application.
//
// The single entry point. It applies the theme, mounts the shell, loads what the
// instance and the session say, connects the realtime gateway, binds the
// renderers the router dispatches to, and then hands the first address to the
// router. Everything a reader sees is built from here.

import { mountShell, refreshChrome, setConnection, onSignOut } from './shell.js';
import { applyTheme } from './theme.js';
import { updateFromViewport, wireNav, wireDrawerGestures } from './presentation.js';
import { TrycordConfig } from './config.js';
import {
  State, on as onStore, loadInstance, loadLegal, loadSession, logout,
  refreshServers, refreshDms, refreshFriends, refreshNotifications,
} from './store.js';
import { installLinkHandler, installPopStateHandler, navigate } from './nav.js';
import realtime, { on as onRealtime, EVENTS, SESSION_EVENTS } from './realtime.js';
import { bind } from './pages/registry.js';
import { RENDERERS } from './views/index.js';
import { run } from './router.js';

function mount() {
  const root = mountShell();
  const host = document.getElementById('app');
  if (host) host.appendChild(root);
  else document.body.appendChild(root);
  updateFromViewport();
  wireNav();
  wireDrawerGestures();
  refreshChrome();
}

function setSession(state) {
  try { document.documentElement.dataset.session = state; } catch { /* no document */ }
}

function wireNavigation() {
  installLinkHandler();
  installPopStateHandler();
  window.addEventListener('trycord:navigate', () => { run().catch(() => {}); });
}

function wireChrome() {
  onRealtime('status', (status) => {
    if (status === 'online') setConnection('', '');
    else if (status === 'connecting') setConnection('connecting', 'Connecting');
    else setConnection('offline', 'Offline - reconnecting');
  });
  onRealtime('presence-changed', () => { refreshChrome(); });
  onRealtime(EVENTS.NOTIFICATION, () => {
    refreshNotifications().catch(() => { /* the bell catches up on the next open */ });
    refreshChrome();
  });
  onRealtime(SESSION_EVENTS.PROFILE, () => {
    loadSession().catch(() => { /* the profile is refreshed on the next load */ });
  });
  onRealtime(SESSION_EVENTS.SESSION_REVOKED, () => {
    logout().catch(() => { /* the token is already gone */ });
  });
}

function wireSignOut() {
  onSignOut(async () => {
    try { await logout(); } catch { /* signing out is local either way */ }
    realtime.disconnect();
    setSession('out');
    navigate('/login', { replace: true });
  });
  onStore('signed-out', () => {
    realtime.disconnect();
    setSession('out');
  });
  // The attribute is how a document says whether it is signed in - the checks and
  // the crash screen read it. Signing in in place has to move it too, not only a
  // reload, or a signed-in document keeps claiming it is signed out.
  onStore('user', () => { setSession('in'); });
}

async function boot() {
  applyTheme();

  // The chrome is mounted before anything is fetched. A slow or unreachable
  // backend must never leave the page blank while a request is outstanding, so
  // the shell paints first and the data fills in behind it.
  mount();
  bind(RENDERERS);
  wireNavigation();
  wireChrome();
  wireSignOut();

  try { await TrycordConfig.loadStaticConfig(); } catch { /* the backend resolves from the origin */ }

  // A ?api= link is offered, never taken silently: the reader confirms, and the
  // parameter is removed either way. Paired with the server no longer reflecting
  // request input into the Content-Security-Policy, a repointing link can neither
  // be persisted nor receive the reader's bearer requests.
  const hintedBackend = TrycordConfig.pendingQueryBackend();
  if (hintedBackend) {
    const useIt = typeof window.confirm === 'function'
      && window.confirm('This link wants this app to use ' + hintedBackend + ' as its server. Use it?');
    if (useIt) TrycordConfig.setApiUrl(hintedBackend);
    TrycordConfig.clearQueryBackend();
  }

  await Promise.allSettled([loadInstance(), loadLegal()]);

  try {
    await loadSession();
  } catch {
    // A network failure is not a signed-out reader, but the login screen is the
    // only honest page to show until the instance answers again.
    State.user = null;
  }
  setSession(State.user ? 'in' : 'out');

  if (State.user) {
    await Promise.allSettled([refreshServers(), refreshDms(), refreshFriends(), refreshNotifications()]);
    realtime.connect();
  }

  await run();
}

export const ready = boot();

export default { ready };
