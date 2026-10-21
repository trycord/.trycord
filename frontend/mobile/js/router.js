// The Mobile router.
//
// One place turns an address into a mobile screen. It reads the same registry the
// desktop router reads - the addresses of the product are the platform's, not a
// module's - resolves whatever the screen needs from the store, and paints the
// mobile shell from the renderer's answer.

import { matchRoute, renderPage } from '../../packages/registry.js';
import { currentRoute, currentQuery, navigate } from '../../packages/nav.js';
import {
  State, serverById, channelById, refreshServer, refreshServers, refreshServerTree, signedIn,
} from '../../packages/store.js';
import { setAppBar, setView, setComposer, setLayout, refreshChrome, shellRoot } from './shell.js';
import { failure } from './components.js';
import { renderNotFound } from './views/plain.js';

let activeCleanup = null;
let rawNode = null;
let generation = 0;

// The sign-in and public documents are the whole page rather than a screen inside
// the shell, so the shell is hidden and the node is placed beside it.
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

function setRoute(route) {
  try { document.documentElement.dataset.route = route; } catch { /* no document */ }
}

function paint(result, page, route) {
  if (result && result.raw) {
    setView(null);
    setComposer(null);
    setLayout('plain');
    setAppBar({ lead: null, title: result.title || page.label || '' });
    showRaw(result.node);
    setRoute(route);
    return false;
  }

  clearRaw();
  setAppBar(result.head || { title: result.title || page.label || '' });
  setView(result.node);
  setComposer(result.composer || null);
  setLayout(result.composer ? 'conversation' : 'default');
  setRoute(route);
  return true;
}

function paintNotFound(route) {
  clearRaw();
  const { node } = renderNotFound();
  setAppBar({ lead: 'back', title: 'Not found' });
  setView(node);
  setComposer(null);
  setLayout('default');
  setRoute(route);
}

function paintError(route, error) {
  clearRaw();
  const box = failure(error, () => run());
  box.setAttribute('data-fault-origin', 'router');
  setAppBar({ lead: 'back', title: 'This page did not open' });
  setView(box);
  setComposer(null);
  setLayout('default');
  setRoute(route);
}

async function resolveServerId(page, params) {
  if (params.id) return params.id;
  if (!params.slug) return null;
  const local = State.servers.find((server) => server.slug === params.slug);
  if (local) return local.id;
  try { await refreshServers(); } catch { /* reported below */ }
  const again = State.servers.find((server) => server.slug === params.slug);
  return again ? again.id : null;
}

function firstChannel(serverId) {
  const channels = (State.serverTree.get(serverId) || {}).channels || [];
  const text = channels.filter((channel) => {
    const type = String(channel.type || 'text');
    return type !== 'voice' && type !== 'stage';
  });
  return (text.length ? text : channels).slice().sort((a, b) => (a.position || 0) - (b.position || 0))[0] || null;
}

export async function run() {
  const seq = ++generation;
  const route = currentRoute();
  const match = matchRoute(route);

  if (activeCleanup) {
    try { activeCleanup(); } catch { /* a cleanup that throws must not stop the route */ }
    activeCleanup = null;
  }

  if (!match) { paintNotFound(route); refreshChrome(); return; }

  const page = match.page;
  const params = match.params;
  const rest = match.rest;

  if (State.mfaRequired && page.access !== 'public') {
    navigate('/two-step', { replace: true });
    return;
  }
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
    page, params, rest, route,
    query: currentQuery(),
    serverId: null,
    channel: null,
    conversationId: params.id || null,
  };

  if (page.sidebar === 'community') {
    const serverId = await resolveServerId(page, params);
    if (seq !== generation) return;
    if (!serverId) { paintError(route, new Error('That community does not exist.')); refreshChrome(); return; }
    ctx.serverId = serverId;
    if (!serverById(serverId)) {
      try { await refreshServer(serverId); } catch { /* the view reports a missing community */ }
      if (seq !== generation) return;
    }
    if (page.id === 'community' || page.id === 'community.legacy') {
      try { await refreshServerTree(serverId); } catch { /* handled below */ }
      if (seq !== generation) return;
      const channel = firstChannel(serverId);
      if (channel) { navigate('/server/' + serverId + '/channel/' + channel.id, { replace: true }); return; }
    } else if (page.id === 'community.channel' || page.id === 'community.channelPins') {
      try { await refreshServerTree(serverId); } catch { /* the view reports it */ }
      if (seq !== generation) return;
      ctx.channel = channelById(serverId, params.channel) || null;
    }
  }

  let result;
  try {
    result = renderPage(page, ctx);
  } catch (error) {
    if (seq === generation) { paintError(route, error); refreshChrome(); }
    return;
  }
  if (seq !== generation) return;

  let mounted;
  try {
    mounted = paint(result, page, route);
  } catch (error) {
    if (seq === generation) { paintError(route, error); refreshChrome(); }
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
        setView(box);
      }
    }
  }
}

export default { run };
