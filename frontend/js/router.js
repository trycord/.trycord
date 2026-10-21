// The router.
//
// One place turns an address into a page. It reads the registry for what a URL
// means, resolves whatever that page needs from the store before rendering,
// fills the shell regions from the renderer's answer, and runs the mount
// lifecycle. It owns exactly one cleanup, so a page that subscribes to anything
// has somewhere to unsubscribe.

import { matchRoute, renderPage } from '../packages/registry.js';
import { currentRoute, currentQuery, navigate } from '../packages/nav.js';
import {
  State, serverById, channelById, refreshServer, refreshServers, refreshServerTree,
  signedIn,
} from '../packages/store.js';
import {
  shellRoot, setStage, setStageHead, setComposer, setInspector, setContextPage,
  setTitle, refreshChrome,
} from './shell.js';
import { fault } from './ui/page.js';
import { renderNotFound } from './features/documents.js';

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
  // An unknown address is still inside the reader's own scope: the spine stays
  // live and says so, instead of leaving an empty column next to the message.
  setContextPage('home', null, null);
  const result = renderNotFound();
  setStageHead();
  setStage(result.node);
  setComposer(null);
  setInspector(null);
  setTitle('Not found');
  setRoute(route);
  refreshChrome();
}

// A fault is never allowed to blank the place column: the reader is still
// somewhere, and the spine still has to say where. The column is repainted from
// the page that was being opened, falling back to the reader's own scope.
function paintError(route, error, ctx, page) {
  clearRaw();
  setContextPage(page && page.sidebar ? page.sidebar : 'home', ctx, page);
  const box = fault(error, () => run());
  box.setAttribute('data-fault-origin', 'router');
  setStageHead();
  setStage(box);
  setComposer(null);
  setInspector(null);
  setTitle('This page did not open');
  setRoute(route);
}

function paint(result, page, route) {
  if (result && result.raw) {
    setStageHead();
    setStage(null);
    setComposer(null);
    setInspector(null);
    setContextPage(null, null, null);
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
  setInspector(result && result.inspector);
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
  // Voice and stage channels have no feed to land on, so the default is the first
  // channel that does. A community of nothing but voice channels still opens one.
  const text = channels.filter((channel) => {
    const type = String(channel.type || 'text');
    return type !== 'voice' && type !== 'stage';
  });
  const ordered = (text.length ? text : channels).slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  return ordered[0] || null;
}

// --- the dispatch -----------------------------------------------------------

export async function run() {
  const seq = ++generation;
  const route = currentRoute();
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
    if (!serverId) { paintError(route, new Error('That community does not exist.'), ctx, page); return; }
    ctx.serverId = serverId;
    if (!serverById(serverId)) {
      try { await refreshServer(serverId); } catch { /* the view reports a missing community */ }
      if (seq !== generation) return;
    }

    // Only the bare community root lands on its first channel. The rest of the
    // id-form URLs - /members, /settings/... - are pages of their own, and a
    // redirect here would swallow them.
    if ((page.id === 'community' || page.id === 'community.legacy') && match.rest.length === 0) {
      try { await refreshServerTree(serverId); } catch { /* handled below */ }
      if (seq !== generation) return;
      const channel = firstChannel(serverId);
      if (channel) {
        navigate('/server/' + serverId + '/channel/' + channel.id, { replace: true });
        return;
      }
      if (seq !== generation) return;
    } else if (page.id === 'community.channel' || page.id === 'community.channelPins') {
      try { await refreshServerTree(serverId); } catch { /* the view reports it */ }
      if (seq !== generation) return;
      ctx.channel = channelById(serverId, params.channel) || null;
    }
  }

  // Every page in the shell has the place column.
  //
  // The column is the reader's own spine - the places they can go - and a
  // page without one has a command bar whose navigation button opens
  // nothing. So the pages that do not name a column of their own get the
  // reader's own places, and the button is honest on every page.
  setContextPage(page.sidebar || 'home', ctx, page);

  let result;
  try {
    result = renderPage(page, ctx);
  } catch (error) {
    if (seq === generation) paintError(route, error, ctx, page);
    return;
  }
  if (seq !== generation) return;

  let mounted;
  try {
    mounted = paint(result, page, route);
  } catch (error) {
    if (seq === generation) paintError(route, error, ctx, page);
    return;
  }
  refreshChrome();

  if (result && typeof result.cleanup === 'function') activeCleanup = result.cleanup;

  if (mounted && result && typeof result.onMount === 'function') {
    try {
      await result.onMount();
    } catch (error) {
      if (seq === generation) {
        const box = fault(error, () => run());
        box.setAttribute('data-fault-origin', 'mount');
        setStage(box);
      }
    }
  }
}

export default { run };
