// The Mobile application.
//
// The module's own entry point. It claims its mount, applies the theme, mounts the
// mobile shell, loads what the instance and the session say, connects the realtime
// gateway, binds the mobile renderers, and then hands the first address to the
// mobile router. It shares the platform packages under ../packages and nothing
// else: there is no desktop module anywhere in this graph.

import { mountShell, refreshChrome, setConnection } from './shell.js';
import { applyTheme } from '../../packages/theme.js';
import { TrycordConfig } from '../../packages/config.js';
import {
  State, on as onStore, loadInstance, loadLegal, loadSession, logout,
  refreshServers, refreshFederated, refreshDms, refreshFriends, refreshNotifications,
  markConversationRead,
} from '../../packages/store.js';
import { installLinkHandler, installPopStateHandler, BASE, setBase, mountFromModuleUrl } from '../../packages/nav.js';
import { loadLocale } from '../../packages/locale.js';
import realtime, { on as onRealtime, EVENTS, SESSION_EVENTS } from '../../packages/realtime.js';
import * as encrypted from './encrypted.js';
import { bind } from '../../packages/registry.js';
import { readOverride, siblingMount } from '../../packages/chooser.js';
import { RENDERERS } from './views/index.js';
import { run } from './router.js';

// The mount is this module's own address, not the shared package's. nav.js lives at
// the client root, so its own URL describes the desktop mount; the mobile entry is
// what knows it sits one directory deeper (/app/mobile on the hosted instance).
setBase(mountFromModuleUrl(import.meta.url));

// The reader is at the front door and has previously chosen the desktop module.
// The two entries are separate documents, so this is a handoff rather than a mode
// switch: nothing is mounted first and hidden. Only the front door decides - a
// deep link is already module-addressed, so following one never bounces the reader
// into the other module.
function handoff() {
  const base = BASE || '';
  const here = String(window.location.pathname || '').replace(/\/index\.html$/, '/');
  if (here !== base + '/' && here !== base) return false;
  if (readOverride() !== 'desktop') return false;
  window.location.replace(siblingMount('mobile', BASE) + '/');
  return true;
}

function mount() {
  const root = mountShell();
  const host = document.getElementById('app');
  if (host) host.appendChild(root);
  else document.body.appendChild(root);
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
    refreshNotifications().catch(() => { /* the badge catches up on the next open */ });
    refreshChrome();
  });
  onRealtime(SESSION_EVENTS.PROFILE, () => {
    loadSession().catch(() => { /* the profile refreshes on the next load */ });
  });
  onRealtime(SESSION_EVENTS.SESSION_REVOKED, () => {
    logout().catch(() => { /* the token is already gone */ });
  });
  // A conversation read elsewhere. The event says who read it: when that is
  // this account, the badge here is stale and is cleared; when it is somebody
  // else, the unread count is still this account's own.
  onRealtime(EVENTS.DM_READ, (event) => {
    const reader = event.userId || event.user_id;
    const me = State.user && State.user.id;
    if (reader && me && String(reader) !== String(me)) return;
    markConversationRead(event.conversationId || event.conversation_id || event.id);
  });
}

function wireSignOut() {
  // Signing out is triggered from the account sheet, which calls logout() itself.
  // This only keeps the document and the gateway consistent with the new state.
  onStore('signed-out', () => {
    realtime.disconnect();
    // The encryption client is dropped with the session. The device's keys stay
    // on the device - a device is an identity and does not change because
    // somebody signed out - but the open client belongs to the account that
    // is no longer here.
    encrypted.reset();
    setSession('out');
  });
  onStore('user', () => { setSession('in'); });
}

async function boot() {
  if (handoff()) return;
  applyTheme();
  // The shell paints before anything is fetched: a slow or unreachable backend must
  // never leave a blank phone screen while a request is outstanding.
  mount();
  bind(RENDERERS);
  wireNavigation();
  wireChrome();
  wireSignOut();

  try { await TrycordConfig.loadStaticConfig(); } catch { /* the backend resolves from the origin */ }
  await Promise.allSettled([loadInstance(), loadLegal()]);

  try {
    await loadSession();
    // The device is registered as soon as the reader is signed in: a device
    // that has never registered cannot hold a conversation key.
    encrypted.ready().catch(() => { /* the encryption page reports it */ });
  } catch {
    // A network failure is not a signed-out reader, but sign-in is the only honest
    // screen to show until the instance answers again.
    State.user = null;
  }
  setSession(State.user ? 'in' : 'out');

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
