// The application.
//
// The single entry point. It applies the theme, mounts the shell, loads what the
// instance and the session say, connects the realtime gateway, binds the
// renderers the router dispatches to, and then hands the first address to the
// router. Everything a reader sees is built from here.

import { mountShell, refreshChrome, setConnection, setDock, onSignOut } from './shell.js';
import { applyTheme } from '../packages/theme.js';
import { preferredEntry, siblingMount } from '../packages/chooser.js';
import { TrycordConfig } from '../packages/config.js';
import {
  State, on as onStore, loadInstance, loadLegal, loadSession, logout,
  refreshServers, refreshFederated, refreshDms, refreshFriends, refreshNotifications,
  markConversationRead,
} from '../packages/store.js';
import { installLinkHandler, installPopStateHandler, navigate, BASE } from '../packages/nav.js';
import { loadLocale } from '../packages/locale.js';
import realtime, { on as onRealtime, EVENTS, SESSION_EVENTS } from '../packages/realtime.js';
import { bind } from '../packages/registry.js';
import { RENDERERS } from './features/index.js';
import { mountVoiceDock } from './voice/dock.js';
import * as encrypted from './ui/encrypted.js';
import { setLocalUserId, leave as voiceLeave } from '../packages/voiceSession.js';
import { run } from './router.js';

function mount() {
  const root = mountShell();
  const host = document.getElementById('app');
  if (host) host.appendChild(root);
  else document.body.appendChild(root);
  refreshChrome();
}

// A phone belongs to the Mobile module. The choice is made once, here, from the
// viewport and the reader's remembered decision, and it is one document load: the
// desktop tree is never initialized only to be hidden, and no responsive layer
// reshapes it into a phone. Equal answers stay put, so the two entries cannot
// bounce a reader between them.
//
// Only the front door decides. A deep link is already module-addressed, so
// following one never bounces the reader into the other module - the same rule the
// Mobile entry applies to its own deep links.
function handoffToMobile() {
  if (preferredEntry('desktop') !== 'mobile') return false;
  const base = BASE || '';
  const here = String(window.location.pathname || '').replace(/\/index\.html$/, '/');
  if (here !== base + '/' && here !== base) return false;
  window.location.replace(siblingMount('desktop', BASE) + '/');
  return true;
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
  // The communities on other instances arrived, or changed. The rail has a
  // section of its own for them.
  onStore('federated', () => { refreshChrome(); });
  // The reader's own account changed - a new picture, a new name. The
  // account button in the corner shows it, so it is redrawn rather than
  // waiting for the reader to go somewhere else and come back.
  onStore('user', () => { refreshChrome(); });
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
  // A conversation read elsewhere. The event says who read it: when that is
  // this account - on another device - the badge here is stale and is
  // cleared. When it is somebody else, the unread count is still this
  // account's own, so nothing about it changes.
  onRealtime(EVENTS.DM_READ, (event) => {
    const reader = event.userId || event.user_id;
    const me = State.user && State.user.id;
    if (reader && me && String(reader) !== String(me)) return;
    const id = event.conversationId || event.conversation_id || event.id;
    if (markConversationRead(id)) refreshChrome();
  });
}

function wireSignOut() {
  onSignOut(async () => {
    try { await voiceLeave(); } catch { /* the seat clears with the socket */ }
    try { await logout(); } catch { /* signing out is local either way */ }
    realtime.disconnect();
    setSession('out');
    navigate('/login', { replace: true });
  });
  onStore('signed-out', () => {
    voiceLeave().catch(() => { /* there was nothing to leave */ });
    realtime.disconnect();
    // The encryption client is dropped with the session. The device's keys stay
    // on the device - a device is an identity and does not change because
    // somebody signed out - but the open client belongs to the account that
    // is no longer here.
    encrypted.reset();
    setSession('out');
  });
  // The attribute is how a document says whether it is signed in - the checks and
  // the crash screen read it. Signing in in place has to move it too, not only a
  // reload, or a signed-in document keeps claiming it is signed out.
  onStore('user', () => { setSession('in'); });
}

async function boot() {
  // Before any chrome is built: a reader the chooser sends to Mobile must never see
  // the desktop shell flash first.
  if (handoffToMobile()) return;

  applyTheme();

  // The chrome is mounted before anything is fetched. A slow or unreachable
  // backend must never leave the page blank while a request is outstanding, so
  // the shell paints first and the data fills in behind it.
  mount();
  bind(RENDERERS);
  wireNavigation();
  wireChrome();
  wireSignOut();
  setLocalUserId(() => (State.user && State.user.id) || '');
  mountVoiceDock((node) => setDock(node));

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
    // The device is registered as soon as the reader is signed in. A device
    // that has never registered cannot hold a conversation key, so a
    // conversation would sit in `mixed` rather than `encrypted` and every
    // message in it would stay in the clear. A failure here is not fatal: the
    // reader can still talk, and the encryption page says what went wrong.
    encrypted.ready().catch(() => { /* the encryption page reports it */ });
  } catch {
    // A network failure is not a signed-out reader, but the login screen is the
    // only honest page to show until the instance answers again.
    State.user = null;
  }
  setSession(State.user ? 'in' : 'out');
  setLocalUserId(() => (State.user && State.user.id) || '');

  // The locale the instance answers in, and the strings it answers with. A
  // reader who is signed in gets their own preference here. An instance that
  // cannot answer leaves the interface in its built-in language.
  try { await loadLocale(); } catch { /* the built-in language stands */ }

  if (State.user) {
    // The communities that live on another instance are asked for with the
    // rest, and are kept apart from the ones that live here.
    await Promise.allSettled([
      refreshServers(), refreshFederated(), refreshDms(), refreshFriends(), refreshNotifications(),
    ]);
    realtime.connect();
  }

  await run();
}

export const ready = boot();

export default { ready };
