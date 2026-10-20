// The workspace shell.
//
// A command-first workbench: one persistent command bar across the top, then a
// rail of communities, the open place's column, and the stage - and nothing
// else competing for attention. The inspector and the dock float; the column is
// the only navigation beside the rail, and it only ever speaks for one scope.
//
// A page fills regions; it never builds chrome. The region API is this module's
// public surface, and it is the same one it has always been, minus the parts
// that were about the old spine: setStage, setStageHead, setComposer,
// setContextPage, setInspector, setDock, setConnection, setTitle.
//
// This is the Desktop composition. A phone is a different module, served its
// own document under /mobile.

import { el, clear } from '../packages/dom.js';
import { icon } from '../packages/icons.js';
import { avatar, countBadge, serverMark } from './ui/primitives.js';
import { State, nameOf, on as onStore } from '../packages/store.js';
import { path, currentRoute, navigate, BASE } from '../packages/nav.js';
import { openMenu, attachContextMenu, isOverlayOpen, isMenuOpen, closeTopOverlay } from './ui/overlays.js';
import { buildContext, serverMenuItems } from './shell/context.js';
import {
  buildFrame, attachColumnResize, brandMark,
  narrowWindow, NARROW_WIDTH as FRAME_NARROW_WIDTH,
} from './shell/frame.js';
import { createInspector } from './shell/inspector.js';
import { openPalette, shortcutLabel } from './shell/palette.js';
import {
  applyDensity, applyLayoutWidths, applyRegions, rememberContextWidth, rememberStageWidth,
  onPrefsChange, regionEnabled, CONTEXT_MIN, CONTEXT_MAX, STAGE_MIN, STAGE_MAX,
} from './prefs.js';
import { setOverride, viewportWantsMobile, siblingMount } from '../packages/chooser.js';

const refs = { frame: null, inspector: null };
let contextSource = null;
let signOutHandler = null;

export function shellRoot() {
  return refs.frame ? refs.frame.root : null;
}

// ---- mount -----------------------------------------------------------------

export function mountShell() {
  const frame = buildFrame();
  refs.frame = frame;
  refs.inspector = createInspector(frame);

  applyDensity();
  applyLayoutWidths(frame.root);
  applyRegions(frame.root);

  refs.frame.kbd.textContent = shortcutLabel();
  refs.frame.omnibox.addEventListener('click', () => openPalette());

  attachColumnResize(frame.columnGrip, {
    root: frame.root,
    variable: '--context-w',
    min: CONTEXT_MIN,
    max: CONTEXT_MAX,
    sign: 1,
    remember: rememberContextWidth,
    fallback: 276,
  });

  attachColumnResize(frame.stageGrip, {
    root: frame.root,
    variable: '--stage-w',
    min: STAGE_MIN,
    max: STAGE_MAX,
    sign: -1,
    remember: rememberStageWidth,
    fallback: 1180,
  });

  // The panel control belongs to the chrome, so it is the chrome that answers
  // for it: it is offered only when the page on screen has a panel to show.
  frame.inspectorToggle.addEventListener('click', () => {
    if (refs.inspector) refs.inspector.toggle();
  });

  frame.scrim.addEventListener('click', () => {
    if (frame.root.dataset.nav === 'overlay') collapseNav();
    else refs.inspector.close();
  });

  // Escape unwinds one layer at a time: overlays first (they own it while they
  // are up), then the inspector, then an overlaid column.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (isOverlayOpen() || isMenuOpen()) return;
      if (refs.inspector && refs.inspector.isOpen()) { refs.inspector.close(); return; }
      if (frame.root.dataset.nav === 'overlay') collapseNav();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      if (document.querySelector('.dialog--palette')) closeTopOverlay();
      else openPalette();
    }
  });

  syncNavMode();
  window.addEventListener('resize', syncNavMode);

  // The arrangement is a reader's choice made in the settings screen, so the
  // shell follows it the moment it changes rather than at the next reload.
  onPrefsChange(() => {
    applyLayoutWidths(frame.root);
    applyRegions(frame.root);
    // A panel that is no longer part of the arrangement is taken away, but the
    // reader's taste is remembered: it comes back when they put it back.
    if (refs.inspector && refs.inspector.isOpen() && !regionEnabled('inspector')) {
      refs.inspector.dismiss();
    }
  });

  // The column speaks for the community's tree, so a tree that changes - a
  // channel made, moved or reordered - repaints the column where the reader
  // is looking at it.
  onStore('tree', () => paintContext());
  onStore('mutes', () => paintContext());
  onStore('presence', () => paintContext());

  return frame.root;
}

// The column is a column on a desk and an overlay on a narrow window. The mode
// is a viewport fact, and the expanded/collapsed choice survives it.
// The width below which the place column draws over the stage.
//
// It is a layout constraint, not a device label: the communities rail, the
// column and a stage a conversation can be read in need about 860 pixels
// between them. Above that the column is a column; below it, it is a panel
// that opens over the stage.
//
// It was 1080, which is a laptop screen and not a phone screen - and a
// browser at 125% or 150% zoom turns an ordinary 1366-pixel laptop into
// something narrower than that, so the sidebar disappeared for a reader who
// had done nothing except make the text bigger.
//
// The stylesheet has the same number, in the media query that hides the
// column. They are checked against each other, because a threshold in one
// place and not the other is a sidebar that is visible in one half of the
// application and not the other.
// The width below which the place column is a panel over the stage rather
// than a column beside it. It is one number, and the frame owns it, because
// the frame's button and the stylesheet's media query both depend on it.
export const NARROW_WIDTH = FRAME_NARROW_WIDTH;

function narrow() {
  // The same question the stylesheet asks, in one place, so the button and
  // the media query cannot disagree about it.
  return narrowWindow();
}

function syncNavMode() {
  const frame = refs.frame;
  if (!frame) return;
  const wasOverlay = frame.root.dataset.nav === 'overlay';
  if (narrow()) {
    if (wasOverlay) return;
    frame.root.dataset.nav = frame.root.dataset.nav === 'hidden' ? 'hidden' : 'expanded';
    // On a narrow window the expanded column draws over the stage, so it needs
    // the backdrop and the toggle has to say so.
    if (frame.root.dataset.nav === 'expanded') frame.root.dataset.nav = 'overlay';
  } else {
    frame.root.dataset.nav = wasOverlay ? 'expanded' : frame.root.dataset.nav;
  }
  frame.navToggle.setAttribute('aria-expanded', String(frame.root.dataset.nav !== 'hidden'));
}

function collapseNav() {
  const frame = refs.frame;
  if (!frame) return;
  frame.root.dataset.nav = 'hidden';
  frame.navToggle.setAttribute('aria-expanded', 'false');
}

// ---- the document title ----------------------------------------------------

export function setTitle(text) {
  document.title = text ? text + ' - Trycord' : 'Trycord';
}

// ---- the stage -------------------------------------------------------------

export function setStageHead(...children) {
  const frame = refs.frame;
  if (!frame) return;
  clear(frame.stageHead);
  const inner = el('div', { class: 'stage-head-inner' });
  for (const child of children) if (child) inner.appendChild(child);
  frame.stageHead.appendChild(inner);
}

export function setStage(node) {
  const frame = refs.frame;
  if (!frame) return;
  clear(frame.stageBody);
  if (node) frame.stageBody.appendChild(node);
  frame.stageBody.scrollTop = 0;
}

export function setComposer(node) {
  const frame = refs.frame;
  if (!frame) return;
  clear(frame.composerSlot);
  if (node) {
    frame.composerSlot.appendChild(node);
    frame.composerSlot.hidden = false;
  } else {
    frame.composerSlot.hidden = true;
  }
}

// ---- the place column ------------------------------------------------------

// The router hands over what the page says its column is (the registry's
// `sidebar` kind), and the shell paints it - now and again on every chrome
// refresh, so a mute, a new channel or a nickname lands without a re-route.
export function setContextPage(kind, ctx, page) {
  contextSource = kind ? { kind, ctx, page } : null;
  paintContext();
}

function paintContext() {
  const frame = refs.frame;
  if (!frame) return;

  let parts = null;
  if (contextSource) {
    try { parts = buildContext(contextSource.kind, contextSource.ctx, contextSource.page); }
    catch { parts = null; }
  }

  if (!parts) {
    frame.root.dataset.column = 'off';
    clear(frame.columnHead);
    clear(frame.columnBody);
    return;
  }
  frame.root.dataset.column = 'on';
  clear(frame.columnHead);
  clear(frame.columnBody);
  append(frame.columnHead, parts.head);
  append(frame.columnBody, parts.body);
}

function append(host, content) {
  if (content === null || content === undefined) return;
  const parts = Array.isArray(content) ? content : [content];
  for (const part of parts) if (part) host.appendChild(part);
}

// ---- the inspector ---------------------------------------------------------

export function setInspector(spec) {
  if (!refs.inspector) return;
  refs.inspector.setSpec(spec || null);
  const frame = refs.frame;
  if (!frame) return;
  // The control is offered only when there is a panel behind it.
  frame.inspectorToggle.hidden = !spec;
  frame.inspectorToggle.setAttribute('aria-expanded', String(!!(spec && refs.inspector.isOpen())));
}

export function toggleInspector() {
  if (refs.inspector) refs.inspector.toggle();
}

export function closeInspector() {
  if (refs.inspector) refs.inspector.close();
}

// ---- the dock --------------------------------------------------------------

export function setDock(node) {
  const frame = refs.frame;
  if (!frame) return;
  clear(frame.dock);
  if (node) {
    frame.dock.appendChild(node);
    frame.dock.hidden = false;
  } else {
    frame.dock.hidden = true;
  }
}

// ---- the connection chip ---------------------------------------------------

export function setConnection(state, label) {
  const frame = refs.frame;
  if (!frame) return;
  frame.connection.dataset.state = state || '';
  clear(frame.connection);
  if (!state) return;
  frame.connection.appendChild(el('span', { class: 'dot' }));
  frame.connection.appendChild(el('span', {}, label || (state === 'offline' ? 'Offline - reconnecting' : 'Reconnecting')));
}

// ---- the rail --------------------------------------------------------------

function renderRail() {
  const frame = refs.frame;
  if (!frame) return;
  const server = currentServer();

  const home = brandMark('rail-item rail-home' + (server ? '' : ' is-active'));
  home.setAttribute('aria-current', server ? 'false' : 'page');
  home.title = 'Home';
  home.setAttribute('aria-label', 'Home');

  const list = el('div', { class: 'rail-list' });
  for (const entry of State.servers) {
    const isActive = !!server && server.id === entry.id;
    const mark = el('a', {
      class: 'rail-item rail-community' + (isActive ? ' is-active' : ''),
      href: path('/server/' + entry.id),
      title: entry.name,
      'aria-label': entry.name + ' community',
      'aria-current': isActive ? 'page' : null,
    }, serverMark(entry, { size: 'md' }));
    attachContextMenu(mark, () => serverMenuItems(entry));
    list.appendChild(mark);
  }
  list.appendChild(el('button', {
    class: 'rail-item rail-add', type: 'button',
    title: 'Create a community', 'aria-label': 'Create a community',
    onClick: () => navigate('/servers/new'),
  }, icon('plus', { size: 20 })));

  frame.rail.replaceChildren(home, el('div', { class: 'rail-divider' }), list);
}

// The community the address is inside, if it is inside one. The rail lights it
// and the same lookup was used to name it.
function currentServer() {
  const here = currentRoute();
  const byId = /^\/server\/([^/]+)/.exec(here);
  if (byId) {
    return State.servers.find((entry) => entry.id === byId[1])
      || State.serverDetail.get(byId[1])
      || null;
  }
  const bySlug = /^\/c\/([^/]+)/.exec(here);
  if (bySlug) return State.servers.find((entry) => (entry.slug || entry.id) === bySlug[1]) || null;
  return null;
}

// ---- the command bar -------------------------------------------------------

function renderCommandBar() {
  const frame = refs.frame;
  if (!frame) return;
  const unread = State.notifications.unreadCount;
  frame.alertsSlot.replaceChildren(el('button', {
    class: 'icon-btn cmdbar-bell', type: 'button',
    'aria-label': unread ? 'Alerts, ' + unread + ' unread' : 'Alerts',
    onClick: () => navigate('/notifications'),
  }, icon('bell', { size: 18 }), countBadge(unread)));
}

// ---- the column foot: the account ------------------------------------------

function renderAccount() {
  const frame = refs.frame;
  if (!frame) return;
  const me = State.user;
  const button = el('button', {
    class: 'account-button', type: 'button',
    title: 'Your account', 'aria-label': 'Your account and settings', 'aria-haspopup': 'menu',
    onClick: (event) => openAccountMenu(event.currentTarget),
  });
  if (me) {
    button.appendChild(avatar(me, { size: 'sm' }));
    button.appendChild(el('span', { class: 'account-id' },
      el('span', { class: 'account-name truncate' }, nameOf(me)),
      el('span', { class: 'account-sub truncate' }, me.statusText || ('@' + (me.username || '')))));
    button.appendChild(icon('more', { size: 16 }));
  } else {
    button.appendChild(icon('user', { size: 18 }));
    button.appendChild(el('span', { class: 'account-id' },
      el('span', { class: 'account-name truncate' }, 'Sign in')));
  }
  frame.columnFoot.replaceChildren(button);
}

function openAccountMenu(anchor) {
  const me = State.user;
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
      me && me.isAdmin ? { separator: true } : null,
      me && me.isAdmin ? { label: 'Instance admin', icon: 'shield', onSelect: () => navigate('/admin') } : null,
      { separator: true },
      { label: 'Sign out', icon: 'logout', danger: true, onSelect: () => requestSignOut() },
    ].filter(Boolean),
  });
}

export function onSignOut(handler) {
  signOutHandler = handler;
}

function requestSignOut() {
  if (signOutHandler) signOutHandler();
}

// ---- repaint on state change -----------------------------------------------

export function refreshChrome() {
  renderRail();
  renderCommandBar();
  renderAccount();
  paintContext();
}

export function renderAllChrome() {
  refreshChrome();
}
