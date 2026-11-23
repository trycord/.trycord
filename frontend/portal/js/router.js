// The developer portal router.
//
// One place turns an address into a page. It uses the shared route registry and
// the developer console's own renderers, so the portal and the desk console
// draw the same screens from the same code: a fix to one is a fix to both, and
// the portal cannot drift into a second, subtly different developer surface.

import { matchRoute, bind, renderPage } from '../../packages/registry.js';
import { renderApplicationsPortal, renderDeveloper } from '../../js/features/developer.js';
import {
  State, signedIn, loadSession, refreshServers,
} from '../../packages/store.js';
import {
  currentRoute, currentQuery, navigate, publicPath,
  installLinkHandler, installPopStateHandler,
} from '../../packages/nav.js';
import { loadLocale } from '../../packages/locale.js';
import { applyTheme } from '../../packages/theme.js';
import { TrycordConfig } from '../../packages/config.js';
import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';

// The pages the portal answers. The ids are the shared registry's own, so the
// addresses a developer links to and the sections the console shows are the
// same table the rest of the client reads.
bind({
  applications: renderApplicationsPortal,
  'applications.keys': renderDeveloper,
  'applications.applications': renderDeveloper,
  'applications.dashboard': renderDeveloper,
  'applications.documentation': renderDeveloper,
});

let activeCleanup = null;

function host() {
  return document.getElementById('app');
}

// A session page reached without a session leaves for the public site's door,
// with the address remembered. Off disk there is no origin root to leave to, so
// the in-app gate answers.
function leaveForSignIn(route) {
  const next = route && route !== '/' ? '/login?next=' + encodeURIComponent(route) : '/login';
  const protocol = window.location && window.location.protocol;
  if (protocol === 'http:' || protocol === 'https:') {
    window.location.assign(publicPath(next));
    return;
  }
  navigate('/login');
}

function notFoundNode(note) {
  return el('div', { class: 'm-empty' },
    el('div', { class: 'm-empty__icon' }, icon('compass', { size: 24 })),
    el('div', { class: 'm-empty__title' }, 'Nothing lives here'),
    el('p', { class: 'm-empty__text' }, note || 'The address points at no screen.'));
}

async function paint() {
  const root = host();
  if (!root) return;

  if (activeCleanup) {
    try { activeCleanup(); } catch { /* a cleanup that throws must not stop the route */ }
    activeCleanup = null;
  }

  const route = currentRoute();
  const match = matchRoute(route);
  const page = match ? match.page : null;
  if (!page) {
    root.replaceChildren(notFoundNode());
    return;
  }

  // The gates: a reader with no session sees nothing but the door, and a reader
  // with one never sees the door.
  if (page.access === 'guest' && signedIn()) {
    navigate('/applications');
    return;
  }
  if (page.access !== 'public' && !signedIn()) {
    leaveForSignIn(route);
    return;
  }

  const ctx = {
    page,
    params: match.params || {},
    rest: match.rest || [],
    route,
    query: currentQuery(),
    serverId: null,
    channel: null,
    conversationId: null,
  };

  let result;
  try {
    result = await renderPage(page, ctx);
  } catch (error) {
    root.replaceChildren(notFoundNode(
      (error && error.message) || 'That screen could not be drawn.'));
    return;
  }

  const mountable = result && result.node ? result : { node: result };
  root.replaceChildren(mountable.node);
  if (typeof mountable.onMount === 'function') {
    try { await mountable.onMount(); } catch { /* the screen says so itself */ }
  }
  if (result && typeof result.cleanup === 'function') activeCleanup = result.cleanup;
  window.scrollTo(0, 0);
}

async function boot() {
  applyTheme();
  installLinkHandler();
  installPopStateHandler();
  window.addEventListener('trycord:navigate', () => { paint().catch(() => {}); });

  // The build's own backend.json sits at the origin root, not beside the portal
  // document, so ask for it there before falling back to the serving origin.
  try { await TrycordConfig.loadStaticConfig(); } catch { /* the origin answers */ }
  try { await loadSession(); } catch { /* the gate answers */ }
  try { await loadLocale(); } catch { /* the built-in language stands */ }

  if (signedIn()) {
    try { await refreshServers(); } catch { /* the screens say what is missing */ }
  }

  await paint();
}

export function init() {
  boot().catch((error) => {
    const root = host();
    if (root) {
      root.replaceChildren(notFoundNode(
        (error && error.message) || 'The portal could not start.'));
    }
  });
}

export default { init };