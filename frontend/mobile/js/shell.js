// The Mobile shell.
//
// The module's own shell, not the desktop one at a different width: an app bar, a
// scrolling view, an optional composer, and a bottom tab bar. It shares nothing
// with the desktop shell except the platform packages. Views never reach into it;
// they return a description and the router paints it.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { brandMark } from '../../packages/brand.js';
import { path, currentRoute, navigate } from '../../packages/nav.js';
import { mobilePages } from '../../packages/registry.js';
import { attachViewSwipe } from '../js/gestures.js';
import { State } from '../../packages/store.js';
import { readPrefs, applyDensity, onPrefsChange } from './prefs.js';
import { buildRail, buildDrawer, isWide } from './rail.js';

let refs = null;
let tabRecords = [];

export function mountShell() {
  const lead = el('div', { class: 'm-appbar__lead' });
  const title = el('div', { class: 'm-appbar__title' });
  // The bell is the shell's own, not a screen's: alerts follow the reader
  // everywhere, so their door does not live behind a tab that may not be on
  // the bar. The badge is the store's own unread count.
  const bellBadge = el('span', { class: 'm-tab__badge', hidden: true });
  const bell = el('a', {
    class: 'm-iconbtn m-appbar__bell', href: path('/notifications'),
    'aria-label': 'Alerts',
  }, icon('bell', { size: 22 }), bellBadge);
  // The narrow phone's door to the communities rail. On a wide phone the rail
  // is always drawn, so the button is not; on a narrow one this overlay is
  // how a reader switches community from inside a conversation without
  // leaving it.
  const railBtn = el('button', {
    class: 'm-iconbtn m-appbar__railbtn', type: 'button', hidden: true,
    'aria-label': 'Your communities', 'aria-expanded': 'false',
    onClick: () => toggleRailOverlay(),
  }, icon('globe', { size: 22 }));
  const actions = el('div', { class: 'm-appbar__actions' });
  const banner = el('div', { class: 'm-banner', hidden: true, role: 'status' });
  const view = el('main', { class: 'm-view', id: 'm-view', tabindex: '-1' });
  const composer = el('div', { id: 'm-composer', hidden: true });
  const tabs = el('nav', { class: 'm-tabs', id: 'm-tabs', 'aria-label': 'Primary' });

  // The columns a wide phone grows: the communities, and the channels of the
  // community that is open. On a narrow phone they are not drawn at all -
  // the bottom tabs do that job, and they have always done it.
  const rail = el('div', { class: 'm-railwrap', id: 'm-rail', hidden: true });
  const drawer = el('div', { class: 'm-drawerwrap', id: 'm-drawer', hidden: true });

  // The narrow phone's rail, as an overlay. It is the same list the wide
  // phone draws as a column: one rail, two presentations.
  const railPanel = el('div', { class: 'm-railoverlay__panel', role: 'dialog', 'aria-label': 'Your communities', tabindex: '-1' });
  const railOverlay = el('div', { class: 'm-railoverlay', hidden: true },
    el('button', {
      class: 'm-railoverlay__backdrop', type: 'button', tabindex: '-1',
      'aria-label': 'Close communities', onClick: () => toggleRailOverlay(),
    }),
    railPanel);

  const root = el('div', { class: 'm-app', id: 'm-shell' },
    el('a', { class: 'm-skip', href: '#m-view' }, 'Skip to content'),
    rail, drawer, railOverlay,
    el('header', { class: 'm-appbar' }, lead, title, railBtn, bell, actions),
    banner, view, composer, tabs);

  refs = { root, lead, title, actions, banner, view, composer, tabs, rail, drawer, bell, bellBadge, railBtn, railOverlay, railPanel };

  // The overlay's own lifecycle: open builds the rail, focuses it, and
  // listens for Escape; close returns focus to the button that opened it.
  let railOpen = false;
  const onKeydown = (event) => {
    if (event.key === 'Escape' && railOpen) toggleRailOverlay();
  };
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', onKeydown);
  }

  function toggleRailOverlay() {
    railOpen = !railOpen;
    if (railOpen) {
      railPanel.replaceChildren(buildRail());
      railOverlay.hidden = false;
      railBtn.setAttribute('aria-expanded', 'true');
      railPanel.focus({ preventScroll: true });
    } else {
      railOverlay.hidden = true;
      railBtn.setAttribute('aria-expanded', 'false');
      railBtn.focus({ preventScroll: true });
    }
  }
  applyDensity();
  buildTabs();
  refreshTabs();

  // The reader's choices about the phone's own composition take effect at
  // once, not at the next launch.
  onPrefsChange(() => {
    applyDensity();
    buildTabs();
    refreshTabs();
  });

  // The columns follow the window: a phone turned sideways has room for
  // them, and a phone held upright does not.
  const onResize = () => refreshColumns();
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', onResize);
  }
  refreshColumns();

  // Horizontal swipe on the view (started at the top of the scroll) hops between
  // the bottom-tab destinations. Vertical scrolling always wins.
  attachViewSwipe(view, (delta) => {
    const pages = mobilePages().filter((p) => p.nav && p.nav.mobile);
    const here = currentRoute();
    const idx = pages.findIndex((p) => p.route === here);
    if (idx === -1) return;
    const target = pages[(idx + delta + pages.length) % pages.length];
    navigate(target.route);
  });

  return root;
}

export function shellRoot() { return refs && refs.root; }
export function viewHost() { return refs && refs.view; }

export function setAppBar(head) {
  if (!refs) return;
  const h = head || {};
  refs.lead.replaceChildren();
  if (h.lead === undefined || h.lead === 'brand') {
    // The monogram's address and box are packages/brand.js's business; the link
    // is this shell's, because the app bar is the Mobile module's control.
    refs.lead.appendChild(el('a', { class: 'm-brandmark', href: path('/home'), 'aria-label': 'Home' },
      brandMark({ size: 28 })));
  } else if (h.lead === 'back') {
    refs.lead.appendChild(el('button', {
      class: 'm-iconbtn', type: 'button', 'aria-label': 'Back',
      onClick: () => {
        if (window.history && window.history.length > 1) window.history.back();
        else window.dispatchEvent(new window.CustomEvent('trycord:navigate', { detail: { route: '/home', options: {} } }));
      },
    }, icon('chevron-left', { size: 22 })));
  } else if (h.lead instanceof Node) {
    refs.lead.appendChild(h.lead);
  }

  refs.title.replaceChildren(el('div', { class: 'm-appbar__stack' },
    h.mark || null,
    el('div', { class: 'm-appbar__text' },
      el('div', { class: 'm-appbar__name truncate' }, h.title || ''),
      h.sub ? el('div', { class: 'm-appbar__sub truncate' }, h.sub) : null)));

  refs.actions.replaceChildren();
  for (const node of [].concat(h.actions || [])) if (node) refs.actions.appendChild(node);
}

export function setView(node) {
  refs.view.replaceChildren();
  if (node) refs.view.appendChild(node);
  refs.view.scrollTop = 0;
  // Move the reader's focus to the new screen so it is announced instead of the
  // tab that was just tapped.
  refs.view.focus({ preventScroll: true });
}

export function setComposer(node) {
  refs.composer.replaceChildren();
  if (node) { refs.composer.hidden = false; refs.composer.appendChild(node); }
  else refs.composer.hidden = true;
}

export function setLayout(name) {
  refs.root.dataset.layout = name || 'default';
}

export function setConnection(state, label) {
  if (!state) { refs.banner.hidden = true; refs.banner.replaceChildren(); return; }
  refs.banner.hidden = false;
  refs.banner.dataset.state = state;
  refs.banner.replaceChildren(
    icon(state === 'offline' ? 'wifi-off' : 'loader', { size: 16 }), el('span', {}, label || ''));
}

// The bottom bar carries the destinations the reader kept, in the order they
// chose. The registry says what exists; the phone's own preferences say which
// of them are here.
function buildTabs() {
  refs.tabs.replaceChildren();
  const wanted = readPrefs().tabs;
  const pages = mobilePages().filter((page) => wanted.indexOf(page.id) !== -1);
  tabRecords = pages.map((page) => {
    const nav = page.nav || {};
    const label = page.nav.tabLabel || page.nav.short || page.nav.label || page.label;
    const badgeHost = el('span', { class: 'm-tab__badge', hidden: true });
    const link = el('a', { class: 'm-tab', href: path(page.route), dataset: { page: page.id } },
      el('span', { class: 'm-tab__icon' }, icon(page.nav.icon || 'circle-dot', { size: 22 }), badgeHost),
      el('span', { class: 'm-tab__label' }, (page.nav && (page.nav.tabLabel || page.nav.short || page.nav.label)) || page.label));
    refs.tabs.appendChild(link);
    return { page, link, badge: badgeHost };
  });
}

export function refreshTabs() {
  if (!refs) return;
  const here = currentRoute();
  for (const record of tabRecords) {
    const route = record.page.route;
    const active = here === route || here.startsWith(route + '/');
    record.link.classList.toggle('is-active', active);
    if (active) record.link.setAttribute('aria-current', 'page');
    else record.link.removeAttribute('aria-current');
    const count = badgeCount(record.page.id);
    if (count) record.badge.hidden = false;
    else record.badge.hidden = true;
    record.badge.textContent = count ? (count > 99 ? '99+' : String(count)) : '';
  }
  // The bell in the app bar shows the same count the alerts tab used to
  // carry: one number, two doors into the same list.
  const alerts = badgeCount('notifications');
  if (alerts) {
    refs.bellBadge.hidden = false;
    refs.bellBadge.textContent = alerts > 99 ? '99+' : String(alerts);
    refs.bell.setAttribute('aria-label', 'Alerts, ' + alerts + ' unread');
  } else {
    refs.bellBadge.hidden = true;
    refs.bell.setAttribute('aria-label', 'Alerts');
  }
}

function badgeCount(pageId) {
  if (pageId === 'notifications') return State.notifications.unreadCount || 0;
  if (pageId === 'friends') return (State.friendRequests.incoming || []).length;
  return 0;
}

// The columns of a wide phone.
//
// The communities on the left, and the channels of the community that is
// open next to them. They are drawn only when there is room for them, and
// they are drawn from the same state the rest of the phone reads, so they
// cannot disagree with the menu screen about which communities there are.
export function refreshColumns() {
  if (!refs) return;
  const wide = isWide();
  refs.root.classList.toggle('m-app--wide', wide);
  // The rail button is the narrow phone's door; on a wide phone the rail is
  // already drawn, so the button steps aside and the overlay, if open, is
  // put away.
  refs.railBtn.hidden = wide;
  if (wide && refs.railOverlay) {
    refs.railOverlay.hidden = true;
    refs.railBtn.setAttribute('aria-expanded', 'false');
  }
  if (!wide) {
    refs.rail.hidden = true;
    refs.drawer.hidden = true;
    refs.rail.replaceChildren();
    refs.drawer.replaceChildren();
    return;
  }
  refs.rail.hidden = false;
  refs.rail.replaceChildren(buildRail());

  // The community that is open, if there is one.
  const route = currentRoute() || '';
  const match = /^\/server\/([^/]+)/.exec(route);
  const serverId = match ? match[1] : null;
  const column = serverId ? buildDrawer(serverId) : null;
  if (column) {
    refs.drawer.hidden = false;
    refs.drawer.replaceChildren(column);
  } else {
    refs.drawer.hidden = true;
    refs.drawer.replaceChildren();
  }
}

export function refreshChrome() {
  if (!refs) return;
  refreshTabs();
  refreshColumns();
}

export default { mountShell, setAppBar, setView, setComposer, setLayout, setConnection, refreshChrome };
