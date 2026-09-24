// Shell chrome. Renders the supplied structural regions from real
// application state only — the Presence Spine (identity, global
// navigation, communities, current-place navigation), the in-environment
// context header, and the MobileShell drawer + bottom tabs.

import { esc, el, clear, qs } from './ui.js';
import { avatar, navRow, serverChip, channelRow, realmTitle } from './components.js';
import State, { isAuthed, currentServerId, can } from './state.js';

const DESTINATIONS = [
  { id: 'home', label: 'Home', icon: '⌂', href: '#/home' },
  { id: 'dms', label: 'DMs', icon: '✉', href: '#/dms' },
  { id: 'discover', label: 'Discover', icon: '⌕', href: '#/discover' },
  { id: 'friends', label: 'Friends', icon: '☺', href: '#/friends' },
];

let navRoute = () => '';

export function setNavRoute(fn) {
  navRoute = fn;
}

function currentRoute() {
  return navRoute();
}

// ---- desktop presence spine ---------------------------------------------

export function renderIdentity(region) {
  clear(region);
  if (!isAuthed()) return;
  const me = State.me;
  const box = el('div', { class: 'identity' });
  box.appendChild(avatar(me, { size: '', withPresence: true }));
  const text = el('div', { class: 'iden-text' });
  text.appendChild(el('div', { class: 'iden-name' }, me.displayName || me.username));
  text.appendChild(el('div', { class: 'iden-sub' }, me.username + (me.statusText ? ' · ' + me.statusText : '')));
  box.appendChild(text);
  const actions = el('div', { class: 'iden-actions' });
  actions.appendChild(el('button', { type: 'button', title: 'Settings', 'aria-label': 'Settings', onClick: () => { location.hash = '#/settings'; } }, '⚙'));
  box.appendChild(actions);
  region.appendChild(box);
}

export function renderGlobalNavigation(region) {
  clear(region);
  if (!isAuthed()) return;
  const route = currentRoute();
  region.appendChild(realmTitle('Navigate'));
  for (const d of DESTINATIONS) {
    const active = route.startsWith(d.href.replace('#', ''));
    const count = d.id === 'dms' && State.notifUnread ? State.notifUnread : 0;
    const row = navRow({
      label: d.label, icon: d.icon, href: d.href, active,
      count,
      onClick: () => { location.hash = d.href; },
    });
    region.appendChild(row);
  }
  if (State.me && State.me.isAdmin) {
    region.appendChild(navRow({
      label: 'Admin', icon: '🛡', href: '#/admin', active: route.startsWith('/admin'),
      onClick: () => { location.hash = '#/admin'; },
    }));
  }
}

export function renderCommunities(region) {
  clear(region);
  if (!isAuthed()) return;
  region.appendChild(realmTitle('Communities'));
  if (!State.servers.length) {
    region.appendChild(el('div', {
      class: 'row-sub',
      style: { padding: 'var(--t-d-2) var(--t-d-4)', color: 'var(--t-mut)' },
    }, 'No servers yet. Create or join one.'));
  }
  for (const s of State.servers) {
    region.appendChild(serverChip(s, { active: String(s.id) === String(currentServerId()), onClick: () => { location.hash = '#/server/' + s.id; } }));
  }
  region.appendChild(el('button', {
    class: 'nav-row', type: 'button',
    onClick: () => { location.hash = '#/servers/new'; },
  }, el('span', { class: 'nv-icon' }, '+'), el('span', { class: 'nv-label' }, 'New server')));
}

export function renderPlaceNavigation(region) {
  clear(region);
  if (!isAuthed()) return;
  const sid = currentServerId();
  const server = State.servers.find((x) => String(x.id) === String(sid));
  const route = currentRoute();

  // Server header row
  const serverName = server ? server.name : (State.serverDetail && State.serverDetail.name) || 'Home';
  region.appendChild(realmTitle(serverName));

  if (!sid) {
    region.appendChild(el('div', {
      class: 'row-sub', style: { padding: 'var(--t-d-2) var(--t-d-4)', color: 'var(--t-mut)' },
    }, 'Pick a community to see its channels here.'));
    return;
  }

  // Current-community actions ("Full navigation" model). Only items the
  // viewer is actually allowed to open are shown, gated on real permissions.
  const actions = el('div', { class: 'row-line', style: { padding: 'var(--t-d-2) var(--t-d-4)', gap: '6px', flexWrap: 'wrap' } });
  const placeLink = (label, href) => {
    const active = route === href.replace('#', '');
    const btn = el('button', { class: 'btn ghost sm' + (active ? ' active' : ''), type: 'button' }, label);
    btn.addEventListener('click', () => { location.hash = href; });
    return btn;
  };
  if (can('MANAGE_INVITES')) actions.appendChild(placeLink('Invite', '#/server/' + sid + '/invites'));
  if (can('MANAGE_CHANNELS')) actions.appendChild(placeLink('+ Channel', '#/server/' + sid + '/channels/new'));
  if (can('MANAGE_SERVER')) actions.appendChild(placeLink('Settings', '#/server/' + sid + '/settings'));
  region.appendChild(actions);

  // Channel list grouped by category
  const layout = State.channels;
  const categories = layout.categories || [];
  const channels = layout.channels || [];
  const grouped = new Map();
  grouped.set('__none__', []);
  for (const c of categories) grouped.set(c.id, []);
  for (const ch of channels) {
    const key = ch.category_id ? String(ch.category_id) : '__none__';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(ch);
  }

  for (const [catId, list] of grouped) {
    if (!list.length && catId !== '__none__') continue;
    const cat = categories.find((c) => String(c.id) === String(catId));
    if (catId === '__none__') {
      if (!list.length) continue;
    } else {
      region.appendChild(realmTitle((cat ? cat.name : 'Channels')));
    }
    for (const ch of list) {
      const active = route === '/server/' + sid + '/channel/' + ch.id;
      region.appendChild(channelRow(ch, {
        active,
        onClick: () => { location.hash = '#/server/' + sid + '/channel/' + ch.id; },
      }));
    }
  }
}

// ---- context header -------------------------------------------------------

export function renderContextHeader({ title, sub, icon, actions } = {}) {
  const header = qs('#context-header');
  if (!header) return;
  header.dataset.hasIcon = icon ? 'true' : 'false';
  clear(header);

  const titles = el('div', { class: 'context-header__titles' });
  if (icon) titles.appendChild(el('div', { class: 'context-header__icon' }, icon));
  titles.appendChild(el('div', { class: 'context-title', id: 'context-title' }, title || 'Trycord'));
  if (sub) titles.appendChild(el('div', { class: 'context-sub' }, sub));
  header.appendChild(titles);

  const acts = el('div', { class: 'context-actions' });
  for (const a of actions || []) acts.appendChild(a);
  if (actions && actions.length) header.appendChild(acts);

  // Mirror into the mobile header context region so both presentations
  // show the current place context.
  const mobileCtx = qs('#mobile-context');
  if (mobileCtx && typeof title === 'string') {
    clear(mobileCtx);
    const mt = el('div', { class: 'context-title', style: { fontSize: 'var(--t-fs-l)' } }, title);
    if (sub) mt.appendChild(el('span', { style: { color: 'var(--t-mut)', fontWeight: '400', fontSize: 'var(--t-fs-xs)' } }, ' · ' + String(sub)));
    mobileCtx.appendChild(mt);
  }
}

// ---- mobile --------------------------------------------------------------

export function renderMobileHeader() {
  const ctx = qs('#mobile-context');
  if (ctx) {
    const header = qs('.mobile-header');
    const t = (header && header.dataset.title) || 'Trycord';
    if (!ctx.children.length) ctx.appendChild(el('div', { class: 'context-title', style: { fontSize: 'var(--t-fs-l)' } }, t));
  }
}

export function renderMobileTabs(region) {
  clear(region);
  if (!isAuthed()) return;
  const route = currentRoute();
  const tabs = [
    { id: 'home', label: 'Home', icon: '⌂', href: '#/home' },
    { id: 'dms', label: 'DMs', icon: '✉', href: '#/dms' },
    { id: 'discover', label: 'Browse', icon: '⌕', href: '#/discover' },
    { id: 'account', label: 'You', icon: '☺', href: '#/settings' },
  ];
  for (const t of tabs) {
    const active = route.startsWith(t.href.replace('#', ''));
    const btn = el('button', {
      type: 'button', class: active ? 'active' : '',
      onClick: () => { location.hash = t.href; },
    });
    btn.appendChild(el('span', { class: 'micon' }, t.icon));
    btn.appendChild(el('span', {}, t.label));
    region.appendChild(btn);
  }
}

export function syncMobileNavigation(mobileNav) {
  if (!mobileNav) return;
  clear(mobileNav);
  if (!isAuthed()) return;
  const identity = el('div', { class: 'presence-spine__identity' });
  renderIdentity(identity);
  const global = el('div', { class: 'presence-spine__global-navigation' });
  renderGlobalNavigation(global);
  const communities = el('div', { class: 'presence-spine__communities' });
  renderCommunities(communities);
  const place = el('div', { class: 'presence-spine__place-navigation' });
  renderPlaceNavigation(place);
  mobileNav.append(identity, global, communities, place);
}

export function renderAllChrome() {
  renderIdentity(qs('#identity-region'));
  renderGlobalNavigation(qs('#global-navigation'));
  renderCommunities(qs('#community-navigation'));
  renderPlaceNavigation(qs('#place-navigation'));
  renderMobileTabs(qs('#mobile-tab-navigation'));
  syncMobileNavigation(qs('#mobile-navigation'));
}

export default { renderAllChrome, renderContextHeader, renderIdentity, renderGlobalNavigation, renderCommunities, renderPlaceNavigation, renderMobileHeader, renderMobileTabs, syncMobileNavigation, setNavRoute, DESTINATIONS };