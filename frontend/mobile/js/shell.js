// The Mobile shell.
//
// The module's own shell, not the desktop one at a different width: an app bar, a
// scrolling view, an optional composer, and a bottom tab bar. It shares nothing
// with the desktop shell except the platform packages. Views never reach into it;
// they return a description and the router paints it.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { brandMark } from '../../packages/brand.js';
import { path, currentRoute } from '../../packages/nav.js';
import { mobilePages } from '../../packages/registry.js';
import { State } from '../../packages/store.js';

let refs = null;
let tabRecords = [];

export function mountShell() {
  const lead = el('div', { class: 'm-appbar__lead' });
  const title = el('div', { class: 'm-appbar__title' });
  const actions = el('div', { class: 'm-appbar__actions' });
  const banner = el('div', { class: 'm-banner', hidden: true, role: 'status' });
  const view = el('main', { class: 'm-view', id: 'm-view', tabindex: '-1' });
  const composer = el('div', { id: 'm-composer', hidden: true });
  const tabs = el('nav', { class: 'm-tabs', id: 'm-tabs', 'aria-label': 'Primary' });

  const root = el('div', { class: 'm-app', id: 'm-shell' },
    el('header', { class: 'm-appbar' }, lead, title, actions),
    banner, view, composer, tabs);

  refs = { root, lead, title, actions, banner, view, composer, tabs };
  buildTabs();
  refreshTabs();
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

function buildTabs() {
  refs.tabs.replaceChildren();
  tabRecords = mobilePages().map((page) => {
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
}

function badgeCount(pageId) {
  if (pageId === 'notifications') return State.notifications.unreadCount || 0;
  if (pageId === 'friends') return (State.friendRequests.incoming || []).length;
  return 0;
}

export function refreshChrome() { if (refs) refreshTabs(); }

export default { mountShell, setAppBar, setView, setComposer, setLayout, setConnection, refreshChrome };
