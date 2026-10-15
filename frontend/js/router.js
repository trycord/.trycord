// The router.
//
// One place turns an address into a page. It reads the registry for what a URL
// means, resolves whatever that page needs from the store before rendering,
// fills the shell regions from the renderer's answer, and runs the mount
// lifecycle. It owns exactly one cleanup, so a page that subscribes to anything
// has somewhere to unsubscribe.

import { matchRoute, renderPage } from './pages/registry.js';
import { currentRoute, currentQuery, navigate, navigationDirection } from './nav.js';
import {
  State, serverById, channelById, refreshServer, refreshServers, refreshServerTree,
  signedIn,
} from './store.js';
import {
  shellRoot, setStage, setStageHead, setComposer, setContextPanel, setPlaceNav,
  setTitle, refreshChrome, closeDrawer, beginNavigation,
} from './shell.js';
import { buildSidebar } from './sidebars.js';
import { failure } from './views/util.js';
import { renderNotFound } from './views/plain.js';

let activeCleanup = null;
let rawNode = null;
let generation = 0;

function host() {
  return document.getElementById('app');
}

// --- raw surfaces -----------------------------------------------------------
//
// The sign-in screens and the public documents are not part of the workspace:
// they are the whole page, so the shell is hidden rather than filled. The page
// itself is a direct child of <body>, beside the app host - and the root carries
// data-raw so the stylesheet can let the now-empty app host stop holding the
// first viewport, which would otherwise push the whole page below the fold.

function showRaw(node) {
  const root = shellRoot();
  if (root) root.hidden = true;
  if (rawNode) rawNode.remove();
  rawNode = node || null;
  if (rawNode) document.body.appendChild(rawNode);
  try { document.documentElement.dataset.raw = 'true'; } catch { /* no document */ }
}

function clearRaw() {
  if (rawNode) { rawNode.remove(); rawNode = null; }
  const root = shellRoot();
  if (root) root.hidden = false;
  try { delete document.documentElement.dataset.raw; } catch { /* no document */ }
}

// --- region painting --------------------------------------------------------

function headChildren(head) {
  if (!head) return [];
  return Array.isArray(head) ? head.filter(Boolean) : [head];
}

function setRoute(route) {
  try { document.documentElement.dataset.route = route; } catch { /* no document */ }
}

function paintNotFound(route) {
  clearRaw();
  setPlaceNav(null);
  const result = renderNotFound();
  setStageHead();
  setStage(result.node);
  setComposer(null);
  setContextPanel(null);
  setTitle('Not found');
  setRoute(route);
  refreshChrome();
}

function paintError(route, error) {
  clearRaw();
  setPlaceNav(null);
  const box = failure(error, () => run());
  box.setAttribute('data-fault-origin', 'router');
  setStageHead();
  setStage(box);
  setComposer(null);
  setContextPanel(null);
  setTitle('Something went wrong');
  setRoute(route);
}

function paint(result, page, route) {
  if (result && result.raw) {
    setStageHead();
    setStage(null);
    setComposer(null);
    setContextPanel(null);
    setPlaceNav(null);
    setTitle(result.title || page.label || '');
    showRaw(result.node);
    setRoute(route);
    return false;
  }

  clearRaw();
  if (result && typeof result.head !== 'undefined') setStageHead(...headChildren(result.head));
  else setStageHead();
  setStage(result && result.node);
  setComposer(result && result.composer);
  setContextPanel(result && result.members);
  setTitle(page.label || page.nav && page.nav.label || '');
  setRoute(route);
  return true;
}

// --- community resolution ---------------------------------------------------

async function resolveServerId(page, params) {
  if (params.id) return params.id;
  if (!params.slug) return null;
  const local = State.servers.find((server) => server.slug === params.slug);
  if (local) return local.id;
  try { await refreshServers(); } catch { /* the failure is reported below */ }
  const again = State.servers.find((server) => server.slug === params.slug);
  return again ? again.id : null;
}

function firstChannel(serverId) {
  const channels = (State.serverTree.get(serverId) || {}).channels || [];
  const text = channels.filter((channel) => String(channel.type || 'text') !== 'voice');
  const ordered = (text.length ? text : channels).slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  return ordered[0] || null;
}

// --- the dispatch -----------------------------------------------------------

export async function run() {
  const seq = ++generation;
  const route = currentRoute();
  // Read now: the awaits below can let another navigation land.
  const direction = navigationDirection();
  const match = matchRoute(route);

  if (activeCleanup) {
    try { activeCleanup(); } catch { /* a cleanup that throws must not stop the route */ }
    activeCleanup = null;
  }

  if (!match) {
    paintNotFound(route);
    return;
  }

  const page = match.page;
  const params = match.params;
  const rest = match.rest;

  // The instance requires a second factor this account has not enrolled. Every
  // workspace screen would be refused with the same answer, so send the reader
  // straight to the one screen that can fix it. Public documents (legal, support)
  // still open, and the enrolment screen itself is public so this cannot loop.
  if (State.mfaRequired && page.access !== 'public') {
    navigate('/two-step', { replace: true });
    return;
  }

  // The enrolment screen is only meaningful with a token to enrol against.
  if (page.id === 'twoStep' && !signedIn()) {
    navigate('/login', { replace: true });
    return;
  }

  if (page.access === 'guest' && signedIn()) {
    navigate(page.guestTo || '/home', { replace: true });
    return;
  }
  if (page.access === 'session' && !signedIn()) {
    navigate('/login?next=' + encodeURIComponent(route), { replace: true });
    return;
  }

  const ctx = {
    page,
    params,
    rest,
    route,
    query: currentQuery(),
    serverId: null,
    channel: null,
    conversationId: params.id || null,
  };

  if (page.sidebar === 'community') {
    const serverId = await resolveServerId(page, params);
    if (seq !== generation) return;
    if (!serverId) { paintError(route, new Error('That community does not exist.')); return; }
    ctx.serverId = serverId;
    if (!serverById(serverId)) {
      try { await refreshServer(serverId); } catch { /* the view reports a missing community */ }
      if (seq !== generation) return;
    }

    if (page.id === 'community' || page.id === 'community.legacy') {
      try { await refreshServerTree(serverId); } catch { /* handled below */ }
      if (seq !== generation) return;
      const channel = firstChannel(serverId);
      if (channel) {
        navigate('/server/' + serverId + '/channel/' + channel.id, { replace: true });
        return;
      }
    } else if (page.id === 'community.channel' || page.id === 'community.channelPins') {
      try { await refreshServerTree(serverId); } catch { /* the view reports it */ }
      if (seq !== generation) return;
      ctx.channel = channelById(serverId, params.channel) || null;
    }
  }

  closeDrawer();

  let sidebar = null;
  try { sidebar = buildSidebar(page.sidebar, ctx, page); }
  catch { sidebar = null; }
  setPlaceNav(sidebar);

  let result;
  try {
    result = renderPage(page, ctx);
  } catch (error) {
    if (seq === generation) paintError(route, error);
    return;
  }
  if (seq !== generation) return;

  // Slide before the new screen lands; raw surfaces replace the whole document.
  if (!(result && result.raw)) beginNavigation(direction);

  let mounted;
  try {
    mounted = paint(result, page, route);
  } catch (error) {
    if (seq === generation) paintError(route, error);
    return;
  }
  refreshChrome();

  if (result && typeof result.cleanup === 'function') activeCleanup = result.cleanup;

  if (mounted && result && typeof result.onMount === 'function') {
    try {
      await result.onMount();
    } catch (error) {
      if (seq === generation) {
        const box = failure(error, () => run());
        box.setAttribute('data-fault-origin', 'mount');
        setStage(box);
      }
    }
  }
}

export default { run };
