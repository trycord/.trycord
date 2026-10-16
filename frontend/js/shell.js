// The workspace shell.
//
// A community client, not a dashboard: a rail of your communities down the far
// left, the open community's column beside it, the conversation taking the rest,
// and the member list on demand. The stage holds a single .screen (app bar, body,
// composer). A page fills regions; it never builds chrome.
//
// This is the Desktop composition. A phone is a different module, served its own
// document under /mobile, so there is one leading control here: the spine
// collapse, because the spine is a column and nowhere to slide.

import { el, clear } from '../packages/dom.js';
import { icon } from '../packages/icons.js';
import { brandSymbolUrl } from '../packages/brand.js';
import { avatar, countBadge, serverMark } from './components.js';
import { State, nameOf } from '../packages/store.js';
import { path, currentRoute, navigate, BASE } from '../packages/nav.js';
import { globalPages } from '../packages/registry.js';
import { openMenu, attachContextMenu } from './ui.js';
import { serverMenuItems } from './sidebars.js';
import { currentTheme, setTheme } from '../packages/theme.js';
import { setOverride, viewportWantsMobile, siblingMount } from '../packages/chooser.js';

const refs = {};

export function shellRoot() {
  return refs.root || null;
}

export function mountShell() {
  const rail = el('nav', {
    class: 'community-rail', id: 'community-rail', 'aria-label': 'Communities',
  });
  const spineHead = el('header', { class: 'spine-head', id: 'spine-head' });
  const globalNav = el('nav', {
    id: 'global-navigation', class: 'spine-global', 'aria-label': 'Global navigation',
  });
  const placeNav = el('div', {
    id: 'place-navigation', class: 'spine-place', 'aria-label': 'Current place navigation',
  });
  const spineFoot = el('footer', { id: 'spine-foot', class: 'spine-foot', 'aria-label': 'Account' });
  const spine = el('aside', { id: 'spine', class: 'spine', 'aria-label': 'Navigation' },
    spineHead, globalNav, placeNav, spineFoot);

  // Screen rows: app bar, scroll body, composer.
  const stageHead = el('header', { class: 'stage-head', id: 'context-header' });
  const stageBody = el('div', { class: 'stage-body', id: 'view-root', tabindex: '-1' });
  const composerSlot = el('div', { class: 'composer-slot', hidden: true });
  const screen = el('div', { class: 'screen', id: 'screen' },
    stageHead, stageBody, composerSlot);
  const stage = el('main', { class: 'stage', id: 'trycord-main' }, screen);

  const contextPanel = el('aside', {
    class: 'context-panel', id: 'context-panel', 'aria-label': 'Context', hidden: true,
  });
  const scrim = el('div', { class: 'scrim', id: 'desktop-backdrop', 'aria-hidden': 'true' });
  const connection = el('div', { class: 'connection', id: 'connection-status', role: 'status' });

  const root = el('div', {
    class: 'ws', id: 'shell', 'aria-label': 'Trycord',
    dataset: { spine: 'expanded', context: 'closed' },
  },
    el('a', { class: 'skip-link', href: '#view-root' }, 'Skip to content'),
    rail, spine, stage, contextPanel, scrim, connection);

  // One backdrop, for the context panel when it overlays on a narrower desk. The
  // spine is a column here and never overlays, so it has no drawer state.
  scrim.addEventListener('click', () => {
    if (contextPanelOpen()) closeContextPanel();
  });

  // Escape closes the context panel only as an overlay; when it has a column the
  // place bar's own control is the way it closes.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (contextPanelOpen() && !contextPanelHasColumn()) closeContextPanel();
  });

  // A column that becomes an overlay on resize would jump in front of the stage,
  // so close it; the place bar reopens it.
  window.addEventListener('resize', () => {
    if (refs.root && refs.root.dataset.context === 'open' && !contextPanelHasColumn()) {
      closeContextPanel();
    }
  });

  Object.assign(refs, {
    root, rail, spine, spineHead, globalNav, placeNav, spineFoot,
    stage, stageHead, stageBody, composerSlot, contextPanel, scrim, connection,
  });
  return root;
}

export function setTitle(text) {
  document.title = text ? text + ' - Trycord' : 'Trycord';
}

// ---- the app bar -----------------------------------------------------------
//
// One leading control on a desk: the spine collapse, because the spine is a
// column and nothing here overlays or slides.

export function setStageHead(...children) {
  if (!refs.stageHead) return;
  clear(refs.stageHead);
  refs.stageHead.appendChild(spineToggle());
  const inner = el('div', { class: 'stage-head-inner' });
  for (const child of children) if (child) inner.appendChild(child);
  refs.stageHead.appendChild(inner);
}

// Collapse control (desk), where the spine is a column.
function spineToggle() {
  const button = el('button', {
    class: 'spine-toggle icon-btn', type: 'button',
    title: 'Collapse navigation', 'aria-label': 'Collapse navigation',
    'aria-pressed': refs.root && refs.root.dataset.spine === 'collapsed' ? 'true' : 'false',
  }, icon('sidebar', { size: 17 }));
  button.addEventListener('click', () => {
    if (!refs.root) return;
    const collapsed = refs.root.dataset.spine === 'collapsed';
    refs.root.dataset.spine = collapsed ? 'expanded' : 'collapsed';
    button.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
  });
  return button;
}

export function setStage(node) {
  if (!refs.stageBody) return;
  clear(refs.stageBody);
  if (node) refs.stageBody.appendChild(node);
  refs.stageBody.scrollTop = 0;
}

// The part of the spine a page supplies; the rest of the spine is always there.
export function setPlaceNav(node) {
  if (!refs.placeNav) return;
  clear(refs.placeNav);
  const parts = node === null || node === undefined
    ? []
    : (Array.isArray(node) ? node : [node]);
  for (const part of parts) if (part) refs.placeNav.appendChild(part);
}

// ---- the context panel -----------------------------------------------------
//
// A column above 1280px (see shell.css), an overlay below; starts closed.

const CONTEXT_COLUMN_MIN = 1280;

function contextPanelHasColumn() {
  return typeof window !== 'undefined' && window.innerWidth > CONTEXT_COLUMN_MIN;
}

function setContextOpen(open) {
  if (!refs.root) return;
  refs.root.dataset.context = open ? 'open' : 'closed';
  if (refs.contextPanel) refs.contextPanel.hidden = !open;
  syncContextChrome();
}

function syncContextChrome() {
  if (!refs.root) return;
  const open = refs.root.dataset.context === 'open';
  for (const node of document.querySelectorAll('.context-toggle')) {
    node.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

function contextPanelOpen() {
  return !!refs.root && refs.root.dataset.context === 'open';
}

export function setContextPanel(node) {
  if (!refs.contextPanel || !refs.root) return;
  clear(refs.contextPanel);
  if (node) refs.contextPanel.appendChild(node);
  setContextOpen(false);
}

export function toggleContextPanel() {
  if (!refs.root) return;
  setContextOpen(!contextPanelOpen());
}

export function closeContextPanel() {
  if (refs.root) setContextOpen(false);
}

export function setComposer(node) {
  if (!refs.composerSlot) return;
  clear(refs.composerSlot);
  if (node) {
    refs.composerSlot.appendChild(node);
    refs.composerSlot.hidden = false;
  } else {
    refs.composerSlot.hidden = true;
  }
}

export function setConnection(state, label) {
  if (!refs.connection) return;
  refs.connection.dataset.state = state || '';
  clear(refs.connection);
  if (!state) return;
  refs.connection.appendChild(el('span', { class: 'dot' }));
  refs.connection.appendChild(el('span', {}, label || (state === 'offline' ? 'Offline - reconnecting' : 'Reconnecting')));
}

// ---- the spine -------------------------------------------------------------

function activeFor(here, route) {
  return !!here && !!route && (here === route || here.startsWith(route + '/'));
}

// The community the address is inside, if it is inside one. The switcher names
// it, and the same lookup marks it in the menu.
function currentServer() {
  const here = currentRoute();
  const byId = /^\/server\/([^/]+)/.exec(here);
  if (byId) {
    return State.servers.find((s) => s.id === byId[1])
      || State.serverDetail.get(byId[1])
      || null;
  }
  const bySlug = /^\/c\/([^/]+)/.exec(here);
  if (bySlug) return State.servers.find((s) => (s.slug || s.id) === bySlug[1]) || null;
  return null;
}

function renderSpineHead() {
  const home = el('a', {
    class: 'spine-mark', href: path('/home'), title: 'Trycord home', 'aria-label': 'Trycord home',
  });
  const img = el('img', {
    class: 'spine-mark-img', src: brandSymbolUrl,
    alt: '', loading: 'lazy',
  });
  img.addEventListener('error', () => {
    home.replaceChildren(el('span', { class: 'spine-mark-fallback', 'aria-hidden': 'true' }, 'T'));
  });
  home.appendChild(img);

  const server = currentServer();
  const switcher = el('button', {
    class: 'place-switcher', type: 'button', 'aria-haspopup': 'menu',
    'aria-label': server ? 'Switch community, currently ' + server.name : 'Choose a community',
  },
    server
      ? serverMark(server, { size: 'sm' })
      : el('span', { class: 'place-switcher-icon' }, icon('grid', { size: 16 })),
    el('span', { class: 'place-switcher-title truncate' }, server ? server.name : 'Communities'),
    el('span', { class: 'place-switcher-chevron' }, icon('chevron-down', { size: 15 })));
  switcher.addEventListener('click', () => openPlaceMenu(switcher));

  refs.spineHead.replaceChildren(home, switcher);
}

// The community switcher; current one marked.
function openPlaceMenu(anchor) {
  const here = currentRoute();
  const items = [{ header: 'Communities' }];
  if (State.servers.length) {
    for (const server of State.servers) {
      const isActive = here.startsWith('/server/' + server.id)
        || here === '/c/' + (server.slug || server.id);
      items.push({
        label: server.name,
        icon: 'grid',
        checked: isActive,
        onSelect: () => navigate('/server/' + server.id),
      });
    }
  } else {
    items.push({ label: 'No communities yet', disabled: true });
  }
  items.push({ separator: true });
  items.push({ label: 'Create a community', icon: 'plus', onSelect: () => navigate('/servers/new') });
  items.push({ label: 'Browse communities', icon: 'compass', onSelect: () => navigate('/menu') });
  openMenu({ anchor, align: 'left', items });
}

// Global destinations, always present regardless of the current place.
function renderGlobalNav() {
  if (!refs.globalNav) return;
  clear(refs.globalNav);
  const here = currentRoute();
  for (const page of globalPages()) {
    const isActive = activeFor(here, page.route);
    refs.globalNav.appendChild(el('a', {
      class: 'nav-item' + (isActive ? ' is-active' : ''),
      href: path(page.route),
      title: page.nav.label,
      'aria-label': page.nav.label,
      'aria-current': isActive ? 'page' : null,
    },
      icon(page.nav.icon, { size: 17 }),
      el('span', { class: 'nav-label truncate' }, page.nav.label),
      page.id === 'notifications' ? countBadge(State.notifications.unreadCount) : null,
    ));
  }
}

function renderSpineFoot() {
  if (!refs.spineFoot) return;
  const me = State.user;
  const button = el('button', {
    class: 'spine-account', type: 'button',
    title: 'Your account', 'aria-label': 'Your account and settings', 'aria-haspopup': 'menu',
    onClick: (event) => openAccountMenu(event.currentTarget),
  });
  if (me) {
    button.appendChild(avatar(me, { size: 'sm' }));
    button.appendChild(el('span', { class: 'spine-account-id' },
      el('span', { class: 'spine-account-name truncate' }, nameOf(me)),
      el('span', { class: 'spine-account-sub truncate' }, me.statusText || ('@' + (me.username || '')))));
    button.appendChild(icon('more', { size: 16 }));
  } else {
    button.appendChild(icon('user', { size: 18 }));
    button.appendChild(el('span', { class: 'spine-account-id' },
      el('span', { class: 'spine-account-name truncate' }, 'Sign in')));
  }
  refs.spineFoot.replaceChildren(button);
}

function renderSpine() {
  if (!refs.spine) return;
  renderSpineHead();
  renderGlobalNav();
  renderSpineFoot();
}

// ---- the community rail ----------------------------------------------------
//
// The far-left strip: the way home, one mark per community with the open one lit,
// and the way to start another. It is the communities list, not a second copy of
// the column - the column belongs to whichever community is open.
function renderRail() {
  if (!refs.rail) return;
  const server = currentServer();

  const home = el('a', {
    class: 'rail-item rail-home' + (server ? '' : ' is-active'),
    href: path('/home'), title: 'Home', 'aria-label': 'Home',
    'aria-current': server ? null : 'page',
  });
  const img = el('img', {
    src: brandSymbolUrl, alt: '', loading: 'lazy',
  });
  img.addEventListener('error', () => {
    home.replaceChildren(el('span', { class: 'rail-fallback', 'aria-hidden': 'true' }, 'T'));
  });
  home.appendChild(img);

  const list = el('div', { class: 'rail-list' });
  for (const s of State.servers) {
    const isActive = !!server && server.id === s.id;
    const mark = el('a', {
      class: 'rail-item rail-community' + (isActive ? ' is-active' : ''),
      href: path('/server/' + s.id),
      title: s.name,
      'aria-label': s.name + ' community',
      'aria-current': isActive ? 'page' : null,
    }, serverMark(s, { size: 'sm' }));
    attachContextMenu(mark, () => serverMenuItems(s));
    list.appendChild(mark);
  }
  list.appendChild(el('button', {
    class: 'rail-item rail-add', type: 'button',
    title: 'Create a community', 'aria-label': 'Create a community',
    onClick: () => navigate('/servers/new'),
  }, icon('plus', { size: 20 })));

  refs.rail.replaceChildren(home, el('div', { class: 'rail-divider' }), list);
}

function openAccountMenu(anchor) {
  const me = State.user;
  const theme = currentTheme();
  openMenu({
    anchor,
    align: 'right',
    items: [
      me ? { header: nameOf(me) } : null,
      me ? { label: 'View profile', icon: 'user', onSelect: () => navigate('/users/' + me.id) } : null,
      { label: 'Account settings', icon: 'settings', onSelect: () => navigate('/settings') },
      // A phone-shaped viewport that explicitly chose the desktop composition stays
      // here (the remembered override outranks the viewport), so this is the visible
      // way back to the Mobile module. Off a phone it is noise, and it is absent.
      viewportWantsMobile() ? {
        label: 'Mobile site',
        icon: 'phone',
        onSelect: () => {
          setOverride('mobile');
          window.location.assign(siblingMount('desktop', BASE) + '/');
        },
      } : null,
      { separator: true },
      { header: 'Theme' },
      { label: 'Match system', icon: theme === 'system' ? 'check' : 'monitor', onSelect: () => setTheme('system') },
      { label: 'Dark', icon: theme === 'trycord' || theme === 'dark' ? 'check' : 'moon', onSelect: () => setTheme('trycord') },
      { label: 'Light', icon: theme === 'light' ? 'check' : 'sun', onSelect: () => setTheme('light') },
      { separator: true },
      me && me.isAdmin ? { label: 'Instance admin', icon: 'shield', onSelect: () => navigate('/admin') } : null,
      { label: 'Sign out', icon: 'logout', danger: true, onSelect: () => requestSignOut() },
    ].filter(Boolean),
  });
}

let signOutHandler = null;
export function onSignOut(handler) {
  signOutHandler = handler;
}
function requestSignOut() {
  if (signOutHandler) signOutHandler();
}

// ---- region rebuild on state change ----------------------------------------

export function refreshChrome() {
  renderRail();
  renderSpine();
}


export function renderAllChrome() {
  refreshChrome();
}
