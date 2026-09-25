// Shell chrome. Renders the supplied structural regions from real
// application state only — the Presence Spine (identity, global
// navigation, communities, current-place navigation), the in-environment
// context header, and the MobileShell drawer + bottom tabs.

import { esc, el, clear, qs } from './ui.js';
import { avatar, navRow, serverChip, channelRow, realmTitle } from './components.js';
import State, { isAuthed, currentServerId, can } from './state.js';
import { closeMobileDrawer } from './presentation.js';

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
  const me = State.me || {};
  const box = el('div', { class: 'identity' });
  box.appendChild(avatar(me, { size: '', withPresence: true }));
  const text = el('div', { class: 'iden-text' });
  text.appendChild(el('div', { class: 'iden-name' }, me.displayName || me.username || 'You'));
  text.appendChild(el('div', { class: 'iden-sub' }, '@' + (me.username || '') + (me.statusText ? ' · ' + me.statusText : '')));
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
    region.appendChild(navRow({
      label: d.label, icon: d.icon, href: d.href, active, count,
      onClick: () => { location.hash = d.href; },
    }));
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
  for (const s of State.servers || []) {
    region.appendChild(serverChip(s, {
      active: String(s.id) === String(currentServerId()),
      onClick: () => { location.hash = '#/server/' + s.id; },
    }));
  }
  const actions = el('div', { class: 'community-actions' });
  actions.appendChild(el('button', { class: 'nav-row community-action', type: 'button', title: 'Create a community', onClick: () => { location.hash = '#/servers/new'; } },
    el('span', { class: 'nv-icon' }, '+'), el('span', { class: 'nv-label' }, 'Create community')));
  actions.appendChild(el('button', { class: 'nav-row community-action', type: 'button', title: 'Discover communities', onClick: () => { location.hash = '#/discover'; } },
    el('span', { class: 'nv-icon' }, '⌕'), el('span', { class: 'nv-label' }, 'Discover')));
  region.appendChild(actions);
}

export function renderPlaceNavigation(region) {
  clear(region);
  if (!isAuthed()) return;
  const sid = currentServerId();
  const server = State.servers.find((x) => String(x.id) === String(sid));
  const route = currentRoute();
  if (!sid) {
    region.appendChild(el('div', { class: 'place-empty' },
      el('div', { class: 'place-empty__icon' }, '＋'),
      el('strong', {}, 'Choose a community'),
      el('span', {}, 'Your channels will appear here.')));
    return;
  }

  const serverName = server ? server.name : (State.serverDetail && State.serverDetail.name) || 'Community';
  const header = el('div', { class: 'place-header' });
  header.appendChild(el('div', { class: 'place-header__name' }, serverName));
  const menu = el('button', { class: 'place-header__menu', type: 'button', title: 'Community settings and tools', 'aria-label': 'Community menu' }, '⌄');
  const menuBox = el('div', { class: 'place-menu', hidden: true });
  const addMenuItem = (label, href, allowed=true) => {
    if (!allowed) return;
    const b = el('button', { type: 'button', class: 'place-menu__item' }, label);
    b.addEventListener('click', () => { menuBox.hidden = true; location.hash = href; });
    menuBox.appendChild(b);
  };
  addMenuItem('Invite people', '#/server/' + sid + '/invites', can('MANAGE_INVITES'));
  addMenuItem('Community members', '#/server/' + sid + '/members');
  addMenuItem('Roles', '#/server/' + sid + '/roles');
  addMenuItem('Categories', '#/server/' + sid + '/categories', can('MANAGE_CHANNELS'));
  addMenuItem('Community settings', '#/server/' + sid + '/settings', can('MANAGE_SERVER'));
  menu.addEventListener('click', (e) => { e.stopPropagation(); menuBox.hidden = !menuBox.hidden; });
  header.append(menu, menuBox);
  region.appendChild(header);

  const actionRow = el('div', { class: 'place-actions' });
  if (can('MANAGE_INVITES')) actionRow.appendChild(el('button', { type: 'button', title: 'Invite people', onClick: () => { location.hash = '#/server/' + sid + '/invites'; } }, '＋ Invite'));
  if (can('MANAGE_CHANNELS')) actionRow.appendChild(el('button', { type: 'button', title: 'Create channel', onClick: () => { location.hash = '#/server/' + sid + '/channels/new'; } }, '＋ Channel'));
  if (actionRow.children.length) region.appendChild(actionRow);

  const layout = State.channels || { categories: [], channels: [] };
  const categories = layout.categories || [];
  const channels = layout.channels || [];
  const grouped = new Map();
  grouped.set('__none__', []);
  for (const c of categories) grouped.set(String(c.id), []);
  for (const ch of channels) {
    const key = ch.category_id ? String(ch.category_id) : '__none__';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(ch);
  }

  const renderCategory = (label, list, catId) => {
    if (!list.length && catId !== '__none__') return;
    const section = el('section', { class: 'channel-section', dataset: { category: catId } });
    const title = el('div', { class: 'channel-section__title' });
    const caret = el('span', { class: 'channel-section__caret' }, '⌄');
    title.append(caret, el('span', {}, label));
    title.addEventListener('click', () => { section.classList.toggle('collapsed'); });
    section.appendChild(title);
    const listBox = el('div', { class: 'channel-section__list' });
    for (const ch of list) {
      const active = route === '/server/' + sid + '/channel/' + ch.id;
      listBox.appendChild(channelRow(ch, { active, onClick: () => { location.hash = '#/server/' + sid + '/channel/' + ch.id; } }));
    }
    section.appendChild(listBox);
    region.appendChild(section);
  };

  for (const cat of categories) renderCategory(cat.name || 'Category', grouped.get(String(cat.id)) || [], String(cat.id));
  renderCategory('Text channels', grouped.get('__none__') || [], '__none__');

  if (!channels.length) region.appendChild(el('div', { class: 'place-empty compact' }, 'No channels yet.'));
}


export function renderMemberSidebar(region) {
  clear(region);
  if (!isAuthed() || !currentServerId() || !State.serverDetail) {
    region.hidden = true;
    return;
  }
  region.hidden = false;
  const server = State.serverDetail;
  region.appendChild(el('div', { class: 'member-sidebar__header' },
    el('span', {}, 'Members'),
    el('span', { class: 'member-count' }, String((State.members || []).length))
  ));

  const roles = Array.isArray(State.roles) ? [...State.roles].sort((a,b) => (Number(b.position)||0) - (Number(a.position)||0)) : [];
  const roleById = new Map(roles.map(r => [String(r.id), r]));
  const groups = new Map();
  const roleKey = (member) => {
    if (member.is_owner) return '__owner__';
    const top = Array.isArray(member.roles) && member.roles.length
      ? member.roles.map(r => roleById.get(String(r.id)) || r).sort((a,b) => (Number(b.position)||0) - (Number(a.position)||0))[0]
      : null;
    return top ? String(top.id) : '__member__';
  };
  for (const m of State.members || []) {
    const k = roleKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const order = ['__owner__', ...roles.map(r => String(r.id)), '__member__'];
  const seen = new Set();
  for (const key of order) {
    if (seen.has(key)) continue; seen.add(key);
    const members = groups.get(key) || [];
    if (!members.length) continue;
    let label = 'MEMBERS';
    if (key === '__owner__') label = 'OWNER';
    else if (key !== '__member__') {
      const role = roleById.get(key);
      label = role ? String(role.name || 'ROLE').toUpperCase() : 'ROLE';
    }
    const group = el('section', { class: 'member-group' });
    group.appendChild(el('div', { class: 'member-group__label' }, label + ' · ' + members.length));
    for (const m of members) {
      const id = m.user_id || m.id;
      const name = m.nickname || m.display_name || m.username || 'Unknown';
      const rolesForMember = Array.isArray(m.roles) ? m.roles : [];
      const row = el('button', { class: 'member-item', type: 'button', title: '@' + (m.username || '') });
      row.appendChild(avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'sm', withPresence: true }));
      const info = el('span', { class: 'member-item__info' });
      info.appendChild(el('span', { class: 'member-item__name' }, name));
      const roleText = m.is_owner ? 'Owner' : (rolesForMember[0] && rolesForMember[0].name) || 'Member';
      info.appendChild(el('span', { class: 'member-item__role' }, roleText));
      row.appendChild(info);
      row.addEventListener('click', () => { location.hash = '#/users/' + id; });
      group.appendChild(row);
    }
    region.appendChild(group);
  }
  if (!(State.members || []).length) {
    region.appendChild(el('div', { class: 'member-sidebar__empty' }, 'No members to show yet.'));
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

  const sid = currentServerId();
  const server = (State.servers || []).find((s) => String(s.id) === String(sid)) || State.serverDetail;
  const root = el('div', { class: 'mobile-nav-v3' });

  const top = el('div', { class: 'mobile-nav-v3__top' });
  const brand = el('div', { class: 'mobile-nav-v3__brand' },
    el('img', { class: 'brand-logo', src: './assets/trycord-logo.png', alt: 'Trycord' }),
    el('span', {}, 'TRYCORD'));
  const close = el('button', {
    class: 'mobile-nav-v3__close', type: 'button', 'aria-label': 'Close navigation',
    onClick: () => closeMobileDrawer()
  }, '×');
  top.append(brand, close);
  root.appendChild(top);

  const me = State.me || {};
  const account = el('button', { class: 'mobile-nav-v3__account', type: 'button' });
  account.appendChild(avatar(me, { size: 'sm', withPresence: true }));
  const accountText = el('span', { class: 'mobile-nav-v3__account-text' });
  accountText.appendChild(el('strong', {}, me.displayName || me.username || 'You'));
  accountText.appendChild(el('span', {}, '@' + (me.username || '')));
  account.appendChild(accountText);
  account.appendChild(el('span', { class: 'mobile-nav-v3__account-action' }, '⚙'));
  account.addEventListener('click', () => { location.hash = '#/settings'; closeMobileDrawer(); });
  root.appendChild(account);

  const mode = el('div', { class: 'mobile-nav-v3__mode' });
  const exploreBtn = el('button', { type: 'button', class: !sid ? 'active' : '', 'aria-label': 'Global navigation' }, 'Explore');
  const channelsBtn = el('button', { type: 'button', class: sid ? 'active' : '', 'aria-label': 'Current community channels' }, 'Channels');
  channelsBtn.disabled = !sid;
  mode.append(exploreBtn, channelsBtn);
  root.appendChild(mode);

  const content = el('div', { class: 'mobile-nav-v3__content' });

  const renderExplore = () => {
    clear(content);
    mode.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    exploreBtn.classList.add('active');

    const global = el('div', { class: 'mobile-nav-v3__section' });
    global.appendChild(el('div', { class: 'mobile-nav-v3__eyebrow' }, 'NAVIGATE'));
    const grid = el('div', { class: 'mobile-nav-v3__global-grid' });
    const route = currentRoute();
    for (const d of DESTINATIONS) {
      const active = route.startsWith(d.href.replace('#', ''));
      const btn = el('button', { type: 'button', class: active ? 'active' : '' });
      btn.append(el('span', { class: 'mobile-nav-v3__global-icon' }, d.icon), el('span', {}, d.label));
      if (d.id === 'dms' && State.notifUnread) btn.appendChild(el('span', { class: 'mobile-nav-v3__badge' }, String(State.notifUnread)));
      btn.addEventListener('click', () => { location.hash = d.href; closeMobileDrawer(); });
      grid.appendChild(btn);
    }
    if (State.me && State.me.isAdmin) {
      const admin = el('button', { type: 'button', class: route.startsWith('/admin') ? 'active' : '' });
      admin.append(el('span', { class: 'mobile-nav-v3__global-icon' }, '🛡'), el('span', {}, 'Admin'));
      admin.addEventListener('click', () => { location.hash = '#/admin'; closeMobileDrawer(); });
      grid.appendChild(admin);
    }
    global.appendChild(grid);
    content.appendChild(global);

    const communities = el('div', { class: 'mobile-nav-v3__section' });
    const head = el('div', { class: 'mobile-nav-v3__section-head' });
    head.append(el('div', { class: 'mobile-nav-v3__eyebrow' }, 'COMMUNITIES'), el('span', { class: 'mobile-nav-v3__count' }, String((State.servers || []).length)));
    communities.appendChild(head);
    const list = el('div', { class: 'mobile-nav-v3__server-list' });
    for (const s of State.servers || []) {
      const active = String(s.id) === String(sid);
      const chip = serverChip(s, { active, onClick: () => { location.hash = '#/server/' + s.id; closeMobileDrawer(); } });
      list.appendChild(chip);
    }
    if (!State.servers || !State.servers.length) {
      list.appendChild(el('div', { class: 'mobile-nav-v3__empty' }, 'No communities yet.'));
    }
    communities.appendChild(list);
    const actions = el('div', { class: 'mobile-nav-v3__actions' });
    const create = el('button', { type: 'button', onClick: () => { location.hash = '#/servers/new'; closeMobileDrawer(); } }, '＋ Create');
    const discover = el('button', { type: 'button', onClick: () => { location.hash = '#/discover'; closeMobileDrawer(); } }, '⌕ Discover');
    actions.append(create, discover);
    communities.appendChild(actions);
    content.appendChild(communities);
  };

  const renderChannels = () => {
    clear(content);
    mode.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    channelsBtn.classList.add('active');
    if (!sid) return renderExplore();

    const serverName = server?.name || 'Community';
    const head = el('div', { class: 'mobile-nav-v3__server-head' });
    head.appendChild(el('div', { class: 'mobile-nav-v3__server-mark' }, (serverName[0] || 'C').toUpperCase()));
    const text = el('div', {});
    text.appendChild(el('strong', {}, serverName));
    text.appendChild(el('span', {}, 'Channels & community tools'));
    head.append(text);
    content.appendChild(head);

    const tools = el('div', { class: 'mobile-nav-v3__tool-grid' });
    const toolsList = [
      ['Invite', '#/server/' + sid + '/invites', can('MANAGE_INVITES')],
      ['Members', '#/server/' + sid + '/members', true],
      ['Roles', '#/server/' + sid + '/roles', true],
      ['Settings', '#/server/' + sid + '/settings', can('MANAGE_SERVER')],
    ];
    for (const [label, href, allowed] of toolsList) {
      if (!allowed) continue;
      const b = el('button', { type: 'button' }, label);
      b.addEventListener('click', () => { location.hash = href; closeMobileDrawer(); });
      tools.appendChild(b);
    }
    if (can('MANAGE_CHANNELS')) {
      const b = el('button', { type: 'button' }, '＋ Channel');
      b.addEventListener('click', () => { location.hash = '#/server/' + sid + '/channels/new'; closeMobileDrawer(); });
      tools.appendChild(b);
    }
    content.appendChild(tools);

    const layout = State.channels || { categories: [], channels: [] };
    const categories = layout.categories || [];
    const channels = layout.channels || [];
    const grouped = new Map([['__none__', []]]);
    for (const c of categories) grouped.set(String(c.id), []);
    for (const ch of channels) {
      const key = ch.category_id ? String(ch.category_id) : '__none__';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(ch);
    }
    const channelWrap = el('div', { class: 'mobile-nav-v3__channels' });
    const addCategory = (label, list, catId) => {
      if (!list.length && catId !== '__none__') return;
      const section = el('section', { class: 'mobile-nav-v3__channel-section' });
      section.appendChild(el('div', { class: 'mobile-nav-v3__eyebrow' }, label));
      for (const ch of list) {
        const active = currentRoute() === '/server/' + sid + '/channel/' + ch.id;
        const b = el('button', { type: 'button', class: active ? 'active' : '' });
        b.append(el('span', { class: 'mobile-nav-v3__channel-icon' }, '#'), el('span', {}, ch.name || 'channel'));
        b.addEventListener('click', () => { location.hash = '#/server/' + sid + '/channel/' + ch.id; closeMobileDrawer(); });
        section.appendChild(b);
      }
      channelWrap.appendChild(section);
    };
    for (const cat of categories) addCategory(cat.name || 'Category', grouped.get(String(cat.id)) || [], String(cat.id));
    addCategory('Text channels', grouped.get('__none__') || [], '__none__');
    if (!channels.length) channelWrap.appendChild(el('div', { class: 'mobile-nav-v3__empty' }, 'No channels yet.'));
    content.appendChild(channelWrap);
  };

  exploreBtn.addEventListener('click', renderExplore);
  channelsBtn.addEventListener('click', renderChannels);
  root.appendChild(content);
  mobileNav.appendChild(root);

  if (sid) renderChannels(); else renderExplore();
}

export function renderAllChrome() {
  renderIdentity(qs('#identity-region'));
  renderGlobalNavigation(qs('#global-navigation'));
  renderCommunities(qs('#community-navigation'));
  renderPlaceNavigation(qs('#place-navigation'));
  renderMobileTabs(qs('#mobile-tab-navigation'));
  syncMobileNavigation(qs('#mobile-navigation'));
  renderMemberSidebar(qs('#member-sidebar'));
}

export default { renderAllChrome, renderContextHeader, renderIdentity, renderGlobalNavigation, renderCommunities, renderPlaceNavigation, renderMemberSidebar, renderMobileHeader, renderMobileTabs, syncMobileNavigation, setNavRoute, DESTINATIONS };