// Shell chrome. Renders the supplied structural regions from real
// application state only — the Presence Spine (identity, global
// navigation, communities, current-place navigation), the in-environment
// context header, and the MobileShell drawer + bottom tabs.

import { esc, el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, showContextMenu, showUserCard, copyText } from './ui.js';
import { avatar, navRow, serverChip, channelRow, communityMark, navGroup } from './components.js';
import Api from './api.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, isMuted, refreshDms, refreshFriends, refreshNotifications } from './state.js';
import { closeMobileDrawer, toggleDesktopNav, isDesktopNavOpen, openDesktopNav, closeDesktopNav } from './presentation.js';

// Shared context-menu builders (Checkpoint C). `contextmenu` fires on
// right-click (desktop) and long-press (mobile browsers), so one wiring
// covers both shells.

function serverChipMenu(e, s) {
  e.preventDefault();
  e.stopPropagation();
  const sid = String(s.id);
  const isCurrent = sid === String(currentServerId());
  showContextMenu(e.clientX, e.clientY, [
    { label: 'Open community', desc: s.name || '', onSelect: () => { location.hash = '#/server/' + sid; closeMobileDrawer(); } },
    ...(isCurrent && can('MANAGE_SERVER')
      ? [{ label: 'Community settings', onSelect: () => { location.hash = '#/server/' + sid + '/settings'; } }]
      : (s.is_owner && !isCurrent
        ? [{ label: 'Community settings', onSelect: () => { location.hash = '#/server/' + sid + '/settings'; } }]
        : [])),
    { label: 'Copy server ID', onSelect: () => copyText(sid, 'Server ID copied.') },
    { sep: true },
    {
      label: 'Leave community', danger: true,
      onSelect: () => {
        if (s.is_owner) { toast('You own this community. Transfer or delete it first.', 'warn'); return; }
        confirmDialog({
          title: 'Leave ' + (s.name || 'community') + '?',
          message: 'You can rejoin later with a new invite.',
          danger: true, confirmText: 'Leave',
          onConfirm: async () => {
            try {
              await Api.leaveServer(sid);
              await refreshServers();
              if (isCurrent) leaveServerContext();
              location.hash = '#/home';
            } catch (ex) { toast(ex.message || 'Failed', 'error'); }
          },
        });
      },
    },
  ]);
}

async function messageMember(userId) {
  try {
    const dm = await Api.openDm(userId);
    const id = (dm && (dm.id || dm.dm_id)) || dm;
    location.hash = '#/dms/' + id;
    closeMobileDrawer();
  } catch (ex) { toast(ex.message || 'Could not open conversation.', 'error'); }
}

function memberCard(e, m) {
  e.preventDefault();
  e.stopPropagation();
  const id = m.user_id || m.id;
  const sid = currentServerId();
  const name = m.nickname || m.display_name || m.username || 'Unknown';
  const mine = String(id) === String(State.me && State.me.id);
  const canMod = !m.is_owner && !mine && !!sid;
  const modTimeout = () => {
    const dur = el('select', { class: 'input' });
    [['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days']].forEach(([v, label]) => {
      dur.appendChild(el('option', { value: v }, label));
    });
    const err = el('div', { class: 'form-error', hidden: true });
    const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    const go = el('button', { class: 'btn danger', type: 'button' }, 'Time out');
    const modal = openModal({
      title: 'Time out @' + (m.username || ''),
      body: el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Duration'), dur), err),
      footer: el('div', { class: 'row-line' }, cancel, go),
    });
    cancel.addEventListener('click', () => modal.close());
    go.addEventListener('click', async () => {
      try {
        await Api.timeoutMember(sid, id, Number(dur.value));
        modal.close();
        toast('Member timed out.', 'ok');
        renderAllChrome();
      } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not time out.'; }
    });
  };
  showUserCard(e.clientX, e.clientY, {
    avatarEl: avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'lg', withPresence: true }),
    title: name,
    sub: '@' + (m.username || 'unknown'),
    statusLine: m.status_text || null,
    actions: [
      { label: 'View profile', onSelect: () => { location.hash = '#/users/' + id; } },
      ...(mine ? [] : [{ label: 'Message', primary: true, onSelect: () => messageMember(id) }]),
      ...(!mine ? [{
        label: 'Add friend', onSelect: async () => {
          try { await Api.sendFriendRequest(id); toast('Friend request sent.', 'ok'); }
          catch (ex) { toast(ex.message || 'Could not send request.', 'error'); }
        },
      }] : []),
      ...(!mine ? [{
        label: 'Report user', onSelect: () => openReportDialog({
          targetType: 'user', targetId: id, title: 'Report user', subtitle: '@' + (m.username || 'unknown'),
          onSubmit: ({ category, extra }) => Api.reportContent('user', id, category, extra || undefined),
        }),
      }] : []),
      ...(canMod && can('BAN_MEMBERS') ? [{
        label: 'Timeout', onSelect: modTimeout,
      }] : []),
      ...(canMod && can('KICK_MEMBERS') ? [{
        label: 'Kick', danger: true, onSelect: () => confirmDialog({
          title: 'Remove member?', message: '@' + (m.username || '') + ' will leave this community immediately.',
          danger: true, confirmText: 'Remove',
          onConfirm: async () => {
            try { await Api.kickMember(sid, id); toast('Member removed.', 'ok'); renderAllChrome(); }
            catch (ex) { toast(ex.message || 'Could not remove member.', 'error'); }
          },
        }),
      }] : []),
      ...(canMod && can('BAN_MEMBERS') ? [{
        label: 'Ban', danger: true, onSelect: () => confirmDialog({
          title: 'Ban @' + (m.username || '') + '?', message: 'They will be removed and blocked from rejoining.',
          danger: true, confirmText: 'Ban',
          onConfirm: async () => {
            try { await Api.banMember(sid, id, {}); toast('Member banned.', 'ok'); renderAllChrome(); }
            catch (ex) { toast(ex.message || 'Could not ban member.', 'error'); }
          },
        }),
      }] : []),
      { label: 'Copy user ID', onSelect: () => copyText(String(id), 'User ID copied.') },
    ],
  });
}

const DESTINATIONS = [
  { id: 'home', label: 'Home', icon: '⌂', href: '#/home' },
  { id: 'dms', label: 'DMs', icon: '✉', href: '#/dms' },
  { id: 'notifications', label: 'Notifications', icon: '♧', href: '#/notifications', badge: () => State.notifUnread },
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

export function renderCommunities(region) {
  clear(region);
  if (!isAuthed()) return;
  const route = currentRoute();

  // Rail groups, in order: global destinations, then the user's
  // communities, then creation. Discover lives in the global group
  // only — it is a primary destination, not a community action.
  const globalItems = [
    { id: 'home', label: 'Home', icon: '⌂', href: '#/home' },
    { id: 'dms', label: 'Direct messages', icon: '✉', href: '#/dms' },
    { id: 'notifications', label: 'Notifications', icon: '♧', href: '#/notifications', badge: () => State.notifUnread },
    { id: 'discover', label: 'Discover', icon: '⌕', href: '#/discover' },
    { id: 'friends', label: 'Friends', icon: '☺', href: '#/friends', badge: () => (State.friendsIn || []).length },
  ];

  const railButton = ({ label, icon, href, active, badge }) => {
    const btn = el('button', {
      class: 'rail-nav-item' + (active ? ' active' : ''),
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-current': active ? 'page' : null,
      dataset: { label },
      onClick: () => { location.hash = href; },
    }, el('span', { class: 'rail-nav-icon' }, icon));
    const count = badge ? badge() : 0;
    if (count > 0) {
      btn.appendChild(el('span', { class: 'rail-nav-badge' }, count > 99 ? '99+' : String(count)));
    }
    return btn;
  };

  for (const item of globalItems) {
    region.appendChild(railButton({
      label: item.label, icon: item.icon, href: item.href, badge: item.badge,
      active: route === item.href.replace('#', '') || route.startsWith(item.href.replace('#', '') + '/'),
    }));
  }

  const servers = State.servers || [];
  if (servers.length) {
    region.appendChild(el('div', { class: 'rail-divider' }));
    for (const s of servers) {
      const chip = serverChip(s, {
        active: String(s.id) === String(currentServerId()),
        onClick: () => { location.hash = '#/server/' + s.id; },
      });
      chip.dataset.label = s.name || 'Community';
      chip.addEventListener('contextmenu', (e) => serverChipMenu(e, s));
      region.appendChild(chip);
    }
  }

  // Creation action. Discover is deliberately absent: it is a global
  // destination above, and duplicating it here double-counts it.
  const create = el('button', {
    class: 'rail-nav-item community-action',
    type: 'button',
    title: 'Create a community',
    'aria-label': 'Create a community',
    dataset: { label: 'Create a community' },
    onClick: () => { location.hash = '#/servers/new'; },
  }, el('span', { class: 'rail-nav-icon' }, '+'));
  region.appendChild(el('div', { class: 'rail-divider' }));
  region.appendChild(create);

  const foot = el('div', { class: 'rail-foot' });
  const me = State.me;
  if (me) {
    foot.appendChild(railButton({
      label: 'Your account',
      icon: '',
      href: '#/settings',
      active: route.startsWith('/settings') || route.startsWith('/account'),
    }));
    // Swap the icon slot for the real avatar.
    const accountBtn = foot.lastElementChild;
    clear(accountBtn);
    accountBtn.appendChild(avatar(me, { size: 'sm', withPresence: true }));
  }
  foot.appendChild(sidebarToggleButton());
  region.appendChild(foot);
}

// Background refresh for the DM context (conversations, requests, unread).
// Throttled + single-flight: the repaint it triggers re-enters this
// renderer, which returns early — no refresh loop possible.
let homeRefreshAt = 0;
let homeRefreshOn = false;
function refreshHomeSidebar(region) {
  const now = Date.now();
  if (homeRefreshOn || now - homeRefreshAt < 30000) return;
  homeRefreshOn = true;
  homeRefreshAt = now;
  Promise.allSettled([refreshDms(), refreshFriends(), refreshNotifications()]).finally(() => {
    homeRefreshOn = false;
    if (region.isConnected) {
      try { renderPlaceNavigation(region); } catch { /* stale view */ }
      try { renderAllChrome(); } catch { /* ignore */ }
    }
  });
}

// ---- context sidebar ------------------------------------------------------
// One component tree, composed per context:
//
//   ctx-head      optional context header (community identity, page title)
//   ctx-scroll    the only scrolling region: nav groups for this context
//   user-controls pinned session bar
//
// The global rail owns global destinations; everything below is contextual.

const LS_COLLAPSED_GROUPS = 'trycord.collapsedGroups';

function collapsedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_COLLAPSED_GROUPS) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
function persistCollapsedGroups(set) {
  try { localStorage.setItem(LS_COLLAPSED_GROUPS, JSON.stringify([...set])); } catch { /* ignore */ }
}

// Anchored dropdown panel. Self-contained (no portal) so it inherits the
// sidebar's stacking context; closes on outside click and Escape.
function dropdownPanel(anchor, buildItems) {
  const panel = el('div', { class: 'ctx-dropdown', role: 'menu', hidden: true });
  const close = () => {
    panel.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onAway, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onAway = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    if (open) {
      clear(panel);
      for (const item of buildItems()) {
        if (!item) continue;
        if (item.sep) { panel.appendChild(el('div', { class: 'ctx-dropdown__sep' })); continue; }
        const b = el('button', {
          class: 'ctx-dropdown__item' + (item.danger ? ' is-danger' : ''),
          type: 'button', role: 'menuitem',
        }, el('span', { class: 'ctx-dropdown__icon' }, item.icon || ''), el('span', {}, item.label));
        b.addEventListener('click', () => { close(); item.onSelect(); });
        panel.appendChild(b);
      }
    }
    panel.hidden = !open;
    anchor.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      setTimeout(() => {
        document.addEventListener('click', onAway, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
    }
  });
  return panel;
}

// Community header. Communities have no stored banner, so identity is built
// from the derived community mark plus a restrained accent wash. If a banner
// ever exists it is layered behind the mark without changing the geometry.
function communityHeader(sid, server) {
  const name = (server && server.name) || (State.serverDetail && State.serverDetail.name) || 'Community';
  const head = el('header', { class: 'ctx-head ctx-head--community' });
  const bar = el('div', { class: 'ctx-head__bar' });
  bar.appendChild(el('span', { class: 'ctx-head__mark' }, communityMark(name)));
  const text = el('div', { class: 'ctx-head__text' });
  text.appendChild(el('div', { class: 'ctx-head__title' }, name));
  text.appendChild(el('div', { class: 'ctx-head__sub' }, (server && server.is_owner) ? 'Your community' : 'Community'));
  bar.appendChild(text);

  const trigger = el('button', {
    class: 'ctx-head__action', type: 'button',
    title: 'Community menu', 'aria-label': 'Community menu for ' + name,
  }, '⌄');
  bar.appendChild(trigger);
  head.appendChild(bar);

  // Community-level actions live here, not scattered through the channel
  // list. Every entry is permission-gated by the existing role system.
  const panel = dropdownPanel(trigger, () => {
    const items = [];
    items.push({ label: 'Community overview', icon: '⌂', onSelect: () => { location.hash = '#/server/' + sid; } });
    if (can('MANAGE_INVITES')) {
      items.push({ label: 'Invite people', icon: '✉', onSelect: () => { location.hash = '#/server/' + sid + '/invites'; } });
    }
    if (can('MANAGE_CHANNELS')) {
      items.push({ label: 'Create channel', icon: '＋', onSelect: () => { location.hash = '#/server/' + sid + '/channels/new'; } });
    }
    items.push({ sep: true });
    items.push({ label: 'Leave community', icon: '⤶', danger: true, onSelect: () => serverChipMenuLeave(sid, server) });
    return items;
  });
  head.appendChild(panel);
  return head;
}

function serverChipMenuLeave(sid, server) {
  if (server && server.is_owner) {
    toast('You own this community. Transfer or delete it first.', 'warn');
    return;
  }
  confirmDialog({
    title: 'Leave ' + ((server && server.name) || 'community') + '?',
    message: 'You can rejoin later with a new invite.',
    danger: true, confirmText: 'Leave',
    onConfirm: async () => {
      try {
        await Api.leaveServer(sid);
        await refreshServers();
        leaveServerContext();
        location.hash = '#/home';
      } catch (ex) { toast(ex.message || 'Failed', 'error'); }
    },
  });
}

// Generic context header for non-community contexts.
function pageHeader(title, sub) {
  const head = el('header', { class: 'ctx-head' });
  const bar = el('div', { class: 'ctx-head__bar' });
  const text = el('div', { class: 'ctx-head__text' });
  text.appendChild(el('div', { class: 'ctx-head__title' }, title));
  if (sub) text.appendChild(el('div', { class: 'ctx-head__sub' }, sub));
  bar.appendChild(text);
  head.appendChild(bar);
  return head;
}

// Pinned session bar, shared by every context.
function sessionBar() {
  const me = State.me;
  if (!me) return null;
  const bar = el('div', { class: 'user-controls' });
  const idBox = el('button', {
    class: 'user-controls__identity', type: 'button',
    title: 'Your account', 'aria-label': 'Your account',
    onClick: () => { location.hash = '#/settings'; },
  });
  idBox.appendChild(el('span', { class: 'user-controls__avatar' }, avatar(
    { id: me.id, username: me.username, displayName: me.display_name, avatarUrl: me.avatar_url },
    { size: 'sm', withPresence: true })));
  const info = el('span', { class: 'user-controls__info' });
  info.appendChild(el('span', { class: 'user-controls__name' }, me.display_name || me.username || 'You'));
  info.appendChild(el('span', { class: 'user-controls__status' }, 'Online'));
  idBox.appendChild(info);
  bar.appendChild(idBox);
  const buttons = el('div', { class: 'user-controls__buttons' });
  buttons.appendChild(el('button', {
    class: 'user-controls__btn', type: 'button',
    title: 'Settings', 'aria-label': 'Settings',
    onClick: () => { location.hash = '#/settings'; },
  }, '⚙'));
  bar.appendChild(buttons);
  return bar;
}

// ---- community context ----------------------------------------------------

function communityContext(region, sid) {
  const route = currentRoute();
  const server = (State.servers || []).find((x) => String(x.id) === String(sid));

  region.appendChild(communityHeader(sid, server));

  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);

  const collapsed = collapsedGroups();
  const groupKey = (catId) => 'cat:' + sid + ':' + catId;

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

  const channelRowEl = (ch) => {
    const active = route === '/server/' + sid + '/channel/' + ch.id;
    const muted = isMuted(ch.id);
    const row = channelRow(ch, {
      active, muted,
      onClick: () => { location.hash = '#/server/' + sid + '/channel/' + ch.id; },
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [
        { label: 'Open channel', desc: '#' + (ch.name || 'channel'), onSelect: () => { location.hash = '#/server/' + sid + '/channel/' + ch.id; } },
        { label: 'Copy channel ID', onSelect: () => copyText(String(ch.id), 'Channel ID copied.') },
      ];
      if (can('MANAGE_CHANNELS')) {
        items.push({ sep: true });
        items.push({ label: 'Edit channel', icon: '✎', onSelect: () => { location.hash = '#/server/' + sid + '/channels/new'; } });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    return row;
  };

  // One group per category. Uncategorized channels sit in a leading group so
  // they are never visually merged with a real category.
  const addChannelGroup = (label, list, catId) => {
    if (!list.length) return;
    const key = groupKey(catId);
    const group = navGroup({
      label,
      collapsible: true,
      collapsed: collapsed.has(key),
      id: catId,
    });
    group.onToggleChange((isCollapsed) => {
      const set = collapsedGroups();
      if (isCollapsed) set.add(key); else set.delete(key);
      persistCollapsedGroups(set);
    });
    for (const ch of list) group.list.appendChild(channelRowEl(ch));
    scroll.appendChild(group);
  };

  const uncategorised = grouped.get('__none__') || [];
  if (uncategorised.length) addChannelGroup(categories.length ? 'Channels' : 'Text channels', uncategorised, '__none__');
  for (const cat of categories) {
    addChannelGroup(cat.name || 'Category', grouped.get(String(cat.id)) || [], String(cat.id));
  }
  if (!channels.length) {
    scroll.appendChild(el('div', { class: 'ctx-empty' }, 'No channels yet.'));
  }

  // Community management. Semantically distinct from channels: different
  // group treatment, and only destinations this user may actually open.
  const manage = navGroup({ label: 'Community', collapsible: true, collapsed: collapsed.has('manage:' + sid), id: 'manage' });
  manage.onToggleChange((isCollapsed) => {
    const set = collapsedGroups();
    if (isCollapsed) set.add('manage:' + sid); else set.delete('manage:' + sid);
    persistCollapsedGroups(set);
  });
  const manageLinks = [
    { label: 'Overview', href: '#/server/' + sid, path: '/server/' + sid, exact: true, show: true },
    { label: 'Members', href: '#/server/' + sid + '/members', path: '/server/' + sid + '/members', show: true },
    { label: 'Roles', href: '#/server/' + sid + '/roles', path: '/server/' + sid + '/roles', show: can('MANAGE_ROLES') || can('MANAGE_SERVER') },
    { label: 'Categories', href: '#/server/' + sid + '/categories', path: '/server/' + sid + '/categories', show: can('MANAGE_CHANNELS') },
    { label: 'Invites', href: '#/server/' + sid + '/invites', path: '/server/' + sid + '/invites', show: can('MANAGE_INVITES') },
    { label: 'Community settings', href: '#/server/' + sid + '/settings', path: '/server/' + sid + '/settings', show: can('MANAGE_SERVER') },
  ];
  for (const m of manageLinks) {
    if (!m.show) continue;
    const active = m.exact ? route === m.path : (route === m.path || route.startsWith(m.path + '/'));
    manage.list.appendChild(navRow({
      label: m.label, href: m.href, active,
      onClick: () => { location.hash = m.href; },
    }));
  }
  if (manage.list.children.length) scroll.appendChild(manage);

  const bar = sessionBar();
  if (bar) region.appendChild(bar);
}

// ---- DMs context ----------------------------------------------------------

function dmsContext(region) {
  const route = currentRoute();
  region.appendChild(pageHeader('Direct messages', 'Your conversations'));

  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);

  const search = el('input', {
    class: 'input ctx-search', type: 'search',
    placeholder: 'Find a conversation', 'aria-label': 'Filter conversations',
  });
  const listBox = el('div', { class: 'ctx-list' });

  const paint = (q) => {
    clear(listBox);
    const query = String(q || '').trim().toLowerCase();
    const dms = State.dms || [];
    const shown = query
      ? dms.filter((d) => String((d.peer && (d.peer.displayName || d.peer.username)) || '').toLowerCase().includes(query))
      : dms;
    if (!shown.length) {
      listBox.appendChild(el('div', { class: 'ctx-empty' },
        dms.length ? 'No conversations match.' : 'No conversations yet. Start one from a profile.'));
      return;
    }
    for (const dm of shown) {
      const peer = dm.peer || {};
      const name = peer.displayName || peer.username || 'Unknown';
      const active = route === '/dms/' + dm.id;
      const row = el('button', {
        class: 'row row--dm' + (active ? ' active' : '') + (dm.unreadCount ? ' is-unread' : ''),
        type: 'button', title: name,
        onClick: () => { location.hash = '#/dms/' + dm.id; },
      });
      row.appendChild(avatar(peer, { size: 'sm', withPresence: true }));
      const main = el('div', { class: 'row__stack' });
      const top = el('div', { class: 'row__line' });
      top.appendChild(el('span', { class: 'row__title' }, name));
      if (dm.lastMessage) top.appendChild(el('span', { class: 'row__time' }, relTime(dm.lastMessage.createdAt)));
      main.appendChild(top);
      main.appendChild(el('div', { class: 'row__sub' },
        dm.lastMessage ? String(dm.lastMessage.content || '').slice(0, 80) : 'Say hello'));
      row.appendChild(main);
      if (dm.unreadCount) {
        row.appendChild(el('span', { class: 'row__count' },
          String(dm.unreadCount > 99 ? '99+' : dm.unreadCount)));
      }
      listBox.appendChild(row);
    }
  };

  const compose = el('div', { class: 'ctx-actions' });
  compose.appendChild(el('button', {
    class: 'btn primary block', type: 'button',
    onClick: () => { location.hash = '#/friends'; },
  }, 'New message'));
  scroll.appendChild(compose);
  scroll.appendChild(search);
  scroll.appendChild(listBox);
  search.addEventListener('input', () => paint(search.value));
  paint('');

  const bar = sessionBar();
  if (bar) region.appendChild(bar);
  refreshHomeSidebar(region);
}

// ---- settings context -----------------------------------------------------

const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'My Account', path: '/settings' },
  { id: 'security', label: 'Security', path: '/settings/security' },
  { id: 'appearance', label: 'Appearance', path: '/settings/appearance' },
  { id: 'backend', label: 'Backend', path: '/settings/backend' },
  { id: 'updates', label: 'Updates', path: '/settings/updates' },
];

function settingsContext(region) {
  const route = currentRoute();
  region.appendChild(pageHeader('Settings', 'Your account and preferences'));
  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);

  const group = navGroup({ label: 'Settings' });
  for (const s of SETTINGS_SECTIONS) {
    const active = route === s.path || route.startsWith(s.path + '/');
    group.list.appendChild(navRow({
      label: s.label, href: '#' + s.path, active,
      onClick: () => { location.hash = '#' + s.path; },
    }));
  }
  scroll.appendChild(group);

  if (State.me && State.me.isAdmin) {
    const admin = navGroup({ label: 'Administration' });
    admin.list.appendChild(navRow({
      label: 'Admin console', href: '#/admin', active: route.startsWith('/admin'),
      onClick: () => { location.hash = '#/admin'; },
    }));
    scroll.appendChild(admin);
  }

  const bar = sessionBar();
  if (bar) region.appendChild(bar);
}

// ---- friends / notifications / discover / profile / admin -----------------

function simpleListContext(region, { title, sub, groups }) {
  const route = currentRoute();
  region.appendChild(pageHeader(title, sub));
  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);
  for (const g of groups) {
    if (!g || !g.items.length) continue;
    const group = navGroup({ label: g.label });
    for (const item of g.items) {
      const active = item.exact ? route === item.path : (route === item.path || route.startsWith(item.path + '/'));
      group.list.appendChild(navRow({
        label: item.label, href: '#' + item.path, active,
        onClick: () => { location.hash = '#' + item.path; },
      }));
    }
    scroll.appendChild(group);
  }
  const bar = sessionBar();
  if (bar) region.appendChild(bar);
}

function friendsContext(region) {
  const requests = (State.friendsIn || []).length;
  simpleListContext(region, {
    title: 'Friends',
    sub: requests ? requests + ' request' + (requests === 1 ? '' : 's') + ' pending' : 'People you know',
    groups: [{ label: 'People', items: [
      { label: 'All friends', path: '/friends', exact: true },
      { label: 'Add friend', path: '/friends', exact: true },
    ] }],
  });
}

function notificationsContext(region) {
  simpleListContext(region, {
    title: 'Notifications',
    sub: State.notifUnread ? State.notifUnread + ' unread' : 'All caught up',
    groups: [{ label: 'Activity', items: [
      { label: 'All notifications', path: '/notifications', exact: true },
    ] }],
  });
}

function discoverContext(region) {
  simpleListContext(region, {
    title: 'Discover',
    sub: 'Communities on this instance',
    groups: [{ label: 'Browse', items: [
      { label: 'Discover communities', path: '/discover', exact: true },
    ] }, { label: 'Create', items: [
      { label: 'Create a community', path: '/servers/new', exact: true },
    ] }],
  });
}

function profileContext(region, userId) {
  simpleListContext(region, {
    title: 'Profile',
    sub: userId ? 'User profile' : 'Your profile',
    groups: [{ label: 'You', items: [
      { label: 'Your profile', path: '/users/' + (State.me && State.me.id), exact: true },
      { label: 'Edit profile', path: '/settings', exact: true },
    ] }],
  });
}

const ADMIN_SECTIONS = [
  { label: 'Overview', path: '/admin' },
  { label: 'Users', path: '/admin/users' },
  { label: 'Communities', path: '/admin/communities' },
  { label: 'Reports', path: '/admin/reports' },
  { label: 'Appeals', path: '/admin/appeals' },
  { label: 'Audit log', path: '/admin/audit' },
];

function adminContext(region) {
  const route = currentRoute();
  region.appendChild(pageHeader('Administration', 'Moderation and platform health'));
  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);
  const group = navGroup({ label: 'Console' });
  for (const s of ADMIN_SECTIONS) {
    const active = route === s.path || route.startsWith(s.path + '/');
    group.list.appendChild(navRow({
      label: s.label, href: '#' + s.path, active,
      onClick: () => { location.hash = '#' + s.path; },
    }));
  }
  scroll.appendChild(group);
  const bar = sessionBar();
  if (bar) region.appendChild(bar);
}

// ---- dispatcher -----------------------------------------------------------

export function sidebarContext() {
  const path = currentRoute() || '';
  const server = /^\/server\/([^/]+)/.exec(path);
  if (server && server[1]) return { type: 'community', serverId: server[1] };
  if (path === '/dms' || path.startsWith('/dms/')) return { type: 'dms' };
  if (path.startsWith('/settings') || path.startsWith('/account')) return { type: 'settings' };
  if (path.startsWith('/admin')) return { type: 'admin' };
  if (path.startsWith('/notifications')) return { type: 'notifications' };
  if (path.startsWith('/friends')) return { type: 'friends' };
  if (path.startsWith('/discover')) return { type: 'discover' };
  if (path.startsWith('/users/')) return { type: 'profile', userId: path.split('/')[2] };
  return { type: 'dms' };
}

export function renderPlaceNavigation(region) {
  clear(region);
  if (!isAuthed()) return;
  const ctx = sidebarContext();
  switch (ctx.type) {
    case 'community': return communityContext(region, ctx.serverId);
    case 'settings': return settingsContext(region);
    case 'admin': return adminContext(region);
    case 'friends': return friendsContext(region);
    case 'notifications': return notificationsContext(region);
    case 'discover': return discoverContext(region);
    case 'profile': return profileContext(region, ctx.userId);
    default: return dmsContext(region);
  }
}

const LS_HIDE_MEMBERS = 'trycord.hideMembers';
const LS_SIDEBAR_COLLAPSED = 'trycord.sidebarCollapsed';

export function membersHidden() {
  try { return localStorage.getItem(LS_HIDE_MEMBERS) === '1'; } catch { return false; }
}

export function toggleMembers() {
  try {
    localStorage.setItem(LS_HIDE_MEMBERS, membersHidden() ? '0' : '1');
  } catch { /* ignore */ }
  renderMemberSidebar(qs('#member-sidebar'));
}

// ---- collapsible sidebar ---------------------------------------------------
// Persistent preference (localStorage). Collapsed = icon-only rail with
// tooltips; expanded = full labels. Survives navigation and reloads.

export function isSidebarCollapsed() {
  try { return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1'; } catch { return false; }
}

export function toggleSidebar() {
  const next = !isSidebarCollapsed();
  try { localStorage.setItem(LS_SIDEBAR_COLLAPSED, next ? '1' : '0'); } catch { /* ignore */ }
  applySidebarState();
}

export function applySidebarState() {
  const shell = qs('#desktop-shell');
  if (shell) shell.classList.toggle('sidebar-collapsed', isSidebarCollapsed());
  // Re-render chrome so tooltips and aria states update immediately.
  renderAllChrome();
}

// Widths below this cannot dock the context sidebar; it becomes an overlay.
const SIDEBAR_DOCK_MIN = 760;

function contextSidebarDocked() {
  return window.innerWidth >= SIDEBAR_DOCK_MIN;
}

function contextSidebarVisible() {
  const shell = qs('#desktop-shell');
  if (!shell) return false;
  if (shell.classList.contains('sidebar-collapsed')) return isDesktopNavOpen();
  if (isDesktopNavOpen()) return true;
  return contextSidebarDocked();
}

// The context-header hamburger is a true visibility toggle. When the sidebar
// is docked it collapses it (releasing the content column); when it is
// off-canvas it opens/closes the overlay drawer. Previously it only ever
// opened the overlay, so pressing it against a docked sidebar looked dead.
export function toggleContextSidebar() {
  const shell = qs('#desktop-shell');
  if (!shell) return;
  if (contextSidebarDocked()) {
    if (isDesktopNavOpen()) closeDesktopNav();
    toggleSidebar();
    return;
  }
  if (isDesktopNavOpen()) closeDesktopNav();
  else openDesktopNav();
  const btn = qs('.nav-toggle');
  if (btn) btn.setAttribute('aria-expanded', isDesktopNavOpen() ? 'true' : 'false');
}

function sidebarToggleButton() {
  const collapsed = isSidebarCollapsed();
  const btn = el('button', {
    class: 'sidebar-collapse-toggle',
    type: 'button',
    title: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
    'aria-label': collapsed ? 'Expand sidebar' : 'Collapse sidebar',
    'aria-pressed': collapsed ? 'true' : 'false',
  }, collapsed ? '▶' : '◀');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });
  return btn;
}

export function renderMemberSidebar(region) {
  clear(region);
  // The member panel belongs to community surfaces only. On home, DMs,
  // settings and other app routes it hid a stale community's roster.
  if (!isAuthed() || !currentServerId() || !State.serverDetail || !currentRoute().startsWith('/server/')) {
    region.hidden = true;
    return;
  }
  if (membersHidden()) {
    region.hidden = true;
    return;
  }
  region.hidden = false;
  const server = State.serverDetail;
  const onlineCount = (State.members || []).filter((m) => peerPresence(m.user_id || m.id) === 'online').length;
  region.appendChild(el('div', { class: 'member-sidebar__header' },
    el('span', {}, 'Members'),
    el('span', { class: 'member-count' }, String(onlineCount) + ' online')
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
    const groupLabel = el('div', { class: 'member-group__label' }, label + ' · ' + members.length);
    if (key !== '__owner__' && key !== '__member__') {
      const role = roleById.get(key);
      if (role && role.color) groupLabel.style.color = role.color;
    }
    group.appendChild(groupLabel);
    for (const m of members) {
      const id = m.user_id || m.id;
      const name = m.nickname || m.display_name || m.username || 'Unknown';
      const rolesForMember = Array.isArray(m.roles) ? m.roles : [];
      const top = m.is_owner ? null
        : rolesForMember.map((r) => roleById.get(String(r.id)) || r)
          .sort((a, b) => Number(b.position || 0) - Number(a.position || 0))[0] || null;
      const row = el('button', { class: 'row row--member', type: 'button', title: '@' + (m.username || '') });
      row.appendChild(avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'sm', withPresence: true }));
      const info = el('span', { class: 'member-item__info' });
      const nameLine = el('span', { class: 'member-item__name' }, name);
      if (m.is_bot) nameLine.appendChild(el('span', { class: 'bot-tag' }, 'BOT'));
      info.appendChild(nameLine);
      const roleText = m.is_owner ? 'Owner' : (top && top.name) || 'Member';
      const roleLine = el('span', { class: 'member-item__role' });
      if (top && top.color) roleLine.appendChild(el('span', { class: 'role-color-dot', style: { background: top.color } }));
      roleLine.appendChild(el('span', {}, roleText));
      info.appendChild(roleLine);
      row.appendChild(info);
      row.addEventListener('click', () => { location.hash = '#/users/' + id; });
      row.addEventListener('contextmenu', (e) => memberCard(e, m));
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

  // Pop-out rail toggle: the spine is off-canvas on desktop, this
  // hamburger is its only persistent entry point.
  const navToggle = el('button', {
    class: 'nav-toggle', type: 'button',
    title: 'Navigation', 'aria-label': 'Toggle navigation',
    'aria-expanded': isDesktopNavOpen() ? 'true' : 'false',
  }, '☰');
  navToggle.addEventListener('click', () => toggleContextSidebar());
  header.appendChild(navToggle);

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
    { id: 'friends', label: 'Friends', icon: '☺', href: '#/friends' },
    { id: 'notifications', label: 'Alerts', icon: '♧', href: '#/notifications' },
    { id: 'menu', label: 'Menu', icon: '☰', href: '#/menu' },
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

export function renderAllChrome() {
  renderCommunities(qs('#community-navigation'));
  renderPlaceNavigation(qs('#place-navigation'));
  renderMobileTabs(qs('#mobile-tab-navigation'));
  renderMemberSidebar(qs('#member-sidebar'));
  renderVerifyBanner();
}

// Email-verification notice (UX only — the backend is the authority).
// Shows in both shells while the session is unverified, with resend or
// add-email paths. Disappears on the next chrome paint after verify.
export function renderVerifyBanner() {
  const me = State.me;
  const show = !!(isAuthed() && me && !me.emailVerified);
  for (const shell of [qs('#trycord-main'), qs('#mobile-shell')]) {
    if (!shell) continue;
    let bar = shell.querySelector(':scope > .verify-banner');
    if (!show) {
      if (bar) bar.remove();
      continue;
    }
    if (!bar) {
      bar = el('div', { class: 'verify-banner', role: 'status' });
      shell.prepend(bar);
    } else {
      clear(bar);
    }
    const hasEmail = !!(me && me.email);
    bar.appendChild(el('span', { class: 'verify-banner__text' }, hasEmail
      ? 'Verify your email to unlock messaging.'
      : 'Add an email address to verify your account.'));
    if (hasEmail) {
      const resend = el('button', { class: 'btn sm', type: 'button' }, 'Resend email');
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try {
          await Api.verifyEmailResend({ email: me.email });
          toast('Verification email sent.', 'ok');
        } catch (ex) { toast(ex.message || 'Could not resend.', 'error'); }
        finally { resend.disabled = false; }
      });
      bar.appendChild(resend);
    }
    const go = el('button', { class: 'btn ghost sm', type: 'button' }, hasEmail ? 'Settings' : 'Add email');
    go.addEventListener('click', () => { location.hash = '#/settings'; });
    bar.appendChild(go);
  }
}

export default { renderAllChrome, renderVerifyBanner, renderContextHeader, renderCommunities, renderPlaceNavigation, renderMemberSidebar, renderMobileHeader, renderMobileTabs, setNavRoute, membersHidden, toggleMembers, isSidebarCollapsed, toggleSidebar, applySidebarState };
