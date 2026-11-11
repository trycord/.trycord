// The router.
//
// One place turns an address into a phone screen. It reads the same registry
// the desktop reads — the product's addresses are the platform's, not a
// module's — resolves what the route names from the store, and paints the
// shell. A signed-out reader is answered with the front door whatever they
// asked for.

import { matchRoute, renderPage } from '../../packages/registry.js';
import { currentRoute, currentQuery, navigate, path } from '../../packages/nav.js';
import { State, signedIn, serverById, refreshServer, refreshServerTree, channelById, channelsOf } from '../../packages/store.js';
import { paintScreen, paintComposer, refreshChrome, shellRoot } from './shell.js';
import { renderAuth } from './views/auth.js';
import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';

let activeCleanup = null;
let generation = 0;

function resolveServerId(page, params) {
  if (page.id === 'community.legacy' || page.id.indexOf('community.') === 0) return params.id || null;
  if (page.id === 'community') {
    const slug = params.slug;
    const found = (State.servers || []).find((s) => s.slug === slug);
    return found ? found.id : null;
  }
  return null;
}

function firstChannel(serverId) {
  const channels = channelsOf(serverId);
  for (const ch of channels) if (ch.type === 'text') return ch;
  return channels[0] || null;
}

export async function run() {
  const seq = ++generation;
  try {
    await paintRoute(seq);
  } catch (error) {
    // The last resort: nothing a route does may escape as an unhandled
    // rejection, because the reader sees a toast about a "background
    // request" instead of the screen that failed.
    if (seq === generation) paintScreen({ head: { title: 'Something broke' }, node: faultNode(error) });
  }
}

async function paintRoute(seq) {
  const route = currentRoute();
  const match = matchRoute(route);

  if (activeCleanup) {
    try { activeCleanup(); } catch { /* a cleanup that throws must not stop the route */ }
    activeCleanup = null;
  }
  paintComposer(null);
  const root = shellRoot();
  if (root) {
    const chrome = root.querySelector('.m-chrome');
    if (chrome) chrome.classList.remove('m-chrome--raw');
  }

  const page = match ? match.page : null;
  if (!page) {
    paintScreen({ head: { title: 'Nothing here' }, node: notFoundNode() });
    return;
  }

  // The front door and its siblings. A reader with a session never sees them;
  // a reader without one sees nothing else. The gates answer raw themselves;
  // the shell decides from what they said.
  if (page.access === 'guest' || (page.access !== 'public' && !signedIn())) {
    if (page.access === 'guest' && signedIn()) { navigate('/dms', { replace: true }); return; }
    const gate = await Promise.resolve(renderAuth({ screen: page.id, params: match.params, query: currentQuery() }));
    if (seq !== generation) return;
    paintScreen({ raw: !!gate.raw, node: gate.node || gate });
    return;
  }
  if (State.mfaRequired && page.access !== 'public' && page.id !== 'twoStep') {
    const gate = await Promise.resolve(renderAuth({ screen: 'twoStep' }));
    paintScreen({ raw: !!gate.raw, node: gate.node || gate });
    return;
  }
  if (page.id === 'twoStep' && !signedIn()) {
    navigate('/login', { replace: true });
    return;
  }

  const params = match.params || {};
  const ctx = {
    page,
    params,
    rest: match.rest || [],
    route,
    query: currentQuery() || {},
    serverId: null,
    channel: null,
    conversationId: params.id || null,
  };

  // Community addresses name a community; the channel ones also name a
  // channel, and the tree must be in the store before a screen asks for it.
  if (page.id === 'community' || page.id.indexOf('community.') === 0) {
    const serverId = resolveServerId(page, params);
    if (!serverId) {
      paintScreen({ head: { title: 'Communities' }, door: '/communities', node: notFoundNode('That community is not on this instance.') });
      return;
    }
    ctx.serverId = serverId;
    if (!serverById(serverId)) {
      try { await refreshServer(serverId); } catch { /* the view reports a missing community */ }
      if (seq !== generation) return;
    }
    if (page.id === 'community.legacy' && (match.rest || []).length === 0) {
      try { await refreshServerTree(serverId); } catch { /* the next line answers an empty tree */ }
      if (seq !== generation) return;
      const channel = firstChannel(serverId);
      if (channel) { navigate('/server/' + serverId + '/channel/' + channel.id, { replace: true }); return; }
    } else if (page.id === 'community.channel') {
      try { await refreshServerTree(serverId); } catch { /* the view reports it */ }
      if (seq !== generation) return;
      ctx.channel = channelById(serverId, params.channel) || null;
    }
  }

  let answer;
  try {
    answer = await Promise.resolve(renderPage(page, ctx));
  } catch (error) {
    if (seq === generation) paintScreen({ head: { title: 'Something broke' }, node: faultNode(error) });
    return;
  }
  if (seq !== generation) return;

  const screen = answer && answer.node ? answer : { node: answer };
  activeCleanup = answer && typeof answer.cleanup === 'function' ? answer.cleanup : null;
  paintScreen({
    head: screen.head !== undefined ? screen.head : { title: (page.nav && page.nav.label) || 'Trycord' },
    door: screen.door !== undefined ? screen.door : defaultDoor(page.id),
    bare: !!screen.bare,
    raw: !!screen.raw,
    node: screen.node,
  });
  if (screen.composer) paintComposer(screen.composer);
  if (typeof screen.onMount === 'function') {
    // A view's own reading of its data is the view's business, and it can
    // fail: a private profile, a deleted room, a network that dropped. The
    // screen says so where the screen is, rather than throwing past the
    // router into the boot that nobody can answer for.
    try { await Promise.resolve(screen.onMount()); }
    catch (error) {
      if (seq === generation) paintScreen({ head: { title: 'Something broke' }, node: faultNode(error) });
      return;
    }
  }
  refreshChrome();
}

function defaultDoor(pageId) {
  if (pageId === 'dms' || pageId === 'dms.conversation' || pageId === 'friends') return '/dms';
  if (pageId === 'profile') return '/you';
  if (pageId === 'notifications') return '';
  if (pageId.indexOf('community') === 0) return '/communities';
  if (pageId === 'you' || pageId === 'settings') return '/you';
  return '';
}

function notFoundNode(note) {
  return el('div', { class: 'm-empty' },
    el('div', { class: 'm-empty__icon' }, icon('compass', { size: 24 })),
    el('div', { class: 'm-empty__title' }, 'Nothing lives here'),
    el('p', { class: 'm-empty__text' }, note || 'The address points at no screen.'),
    el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => navigate(path('/dms')) }, 'To the chats'));
}

function faultNode(error) {
  return el('div', { class: 'm-fault' },
    el('p', { class: 'm-fault__text' }, (error && error.message) || 'That screen could not be drawn.'));
}
