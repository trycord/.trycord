
import { esc, el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, showContextMenu, attachMenu, attachContextMenu, showUserCard, copyText, announce } from './ui.js';
import { avatar, icon, navRow, serverChip, channelRow, communityMark, communityBannerUrl, loadAuthedImage, navGroup } from './components.js';
import Api from './api.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, isMuted, setMuted, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from './state.js';
import { toggleDesktopNav, isDesktopNavOpen, openDesktopNav, closeDesktopNav } from './presentation.js';
import { serverPath, channelPath, absoluteChannelUrl } from './links.js';

// wiring, so a menu can never exist on one input method and be missing on
// another. Menus are permission-shaped here: an action the viewer cannot perform

function serverChipMenuFor(s) {
  return () => {
    const sid = String(s.id);
    const isCurrent = sid === String(currentServerId());
    const mayManage = (isCurrent && can('MANAGE_SERVER')) || (s.is_owner && !isCurrent);
    return [
      { label: 'Open community', desc: s.name || '', onSelect: () => { location.hash = serverPath(sid); } },
      {
        label: 'Community settings', desc: mayManage ? undefined : 'Requires Manage Community',
        disabled: !mayManage,
        onSelect: () => { location.hash = serverPath(sid, 'settings'); },
      },
      { label: 'Copy community link', onSelect: () => copyText(sid, 'Community ID copied.') },
      { label: 'Copy community ID', onSelect: () => copyText(sid, 'Community ID copied.') },
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
    ];
  };
}

function roleAssignable(roleId) {
  if (!can('MANAGE_ROLES')) return false;
  if ((State.permissions || []).includes('*')) return true;
  const role = (State.roles || []).find((r) => String(r.id) === String(roleId));
  if (!role) return false;
  return myTopPosition() > Number(role.position || 0);
}

function myTopPosition() {
  const me = State.me;
  if (!me) return -1;
  const row = (State.members || []).find((m) => String(m.user_id || m.id) === String(me.id));
  const mine = (row && row.roles) || [];
  return mine.length ? Math.max(...mine.map((r) => Number(r.position || 0))) : -1;
}

function memberMenu(m) {
  return () => memberActions(m);
}

// The action list for one member, permission-shaped. Exported so the member
export function memberActions(m) {
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

  // offered. There is deliberately no "assign to yourself" path anywhere.
  const held = new Set(((m.roles) || []).map((r) => String(r.id)));
  const assignable = (State.roles || []).filter((r) => !held.has(String(r.id)) && roleAssignable(String(r.id)));
  const removable = ((m.roles) || []).filter((r) => roleAssignable(String(r.id)));

  const rolesSubmenu = () => {
    if (!sid || mine) return null;
    if (!can('MANAGE_ROLES')) return null;
    const items = [];
    if (assignable.length) {
      items.push({ heading: 'Add role' });
      for (const r of assignable) {
        items.push({
          label: r.name || 'Role',
          desc: r.color ? 'Coloured' : undefined,
          onSelect: async () => {
            try {
              await Api.assignRole(sid, r.id, id);
              toast('Added ' + (r.name || 'role') + '.', 'ok');
              await refreshServerView();
              renderAllChrome();
            } catch (ex) { toast(ex.message || 'Could not add that role.', 'error'); }
          },
        });
      }
    }
    if (removable.length) {
      if (items.length) items.push({ sep: true });
      items.push({ heading: 'Remove role' });
      for (const r of removable) {
        items.push({
          label: r.name || 'Role',
          onSelect: async () => {
            try {
              await Api.unassignRole(sid, r.id, id);
              toast('Removed ' + (r.name || 'role') + '.', 'ok');
              await refreshServerView();
              renderAllChrome();
            } catch (ex) { toast(ex.message || 'Could not remove that role.', 'error'); }
          },
        });
      }
    }
    if (!items.length) return null;
    return { label: 'Roles', desc: 'Assign or remove', items };
  };

  const modSubmenu = () => {
    if (!canMod) return null;
    const items = [];
    if (can('BAN_MEMBERS')) items.push({ label: 'Timeout', onSelect: modTimeout });
    if (can('KICK_MEMBERS')) {
      items.push({
        label: 'Kick', danger: true, onSelect: () => confirmDialog({
          title: 'Remove member?', message: '@' + (m.username || '') + ' will leave this community immediately.',
          danger: true, confirmText: 'Remove',
          onConfirm: async () => {
            try { await Api.kickMember(sid, id); toast('Member removed.', 'ok'); renderAllChrome(); }
            catch (ex) { toast(ex.message || 'Could not remove member.', 'error'); }
          },
        }),
      });
    }
    if (can('BAN_MEMBERS')) {
      items.push({
        label: 'Ban', danger: true, onSelect: () => confirmDialog({
          title: 'Ban @' + (m.username || '') + '?', message: 'They will be removed and blocked from rejoining.',
          danger: true, confirmText: 'Ban',
          onConfirm: async () => {
            try { await Api.banMember(sid, id, {}); toast('Member banned.', 'ok'); renderAllChrome(); }
            catch (ex) { toast(ex.message || 'Could not ban member.', 'error'); }
          },
        }),
      });
    }
    if (!items.length) return null;
    return { label: 'Moderation', items };
  };

  const actions = [
    { label: 'View profile', onSelect: () => { location.hash = '#/users/' + id; } },
    ...(mine ? [] : [{ label: 'Message', onSelect: () => messageMember(id) }]),
    { label: 'Copy user ID', onSelect: () => copyText(String(id), 'User ID copied.') },
  ];
  const roles = rolesSubmenu();
  if (roles) actions.push(roles);
  const mod = modSubmenu();
  if (mod) actions.push(mod);
  if (!mine) {
    actions.push({ sep: true });
    actions.push({
      label: 'Add friend', onSelect: async () => {
        try { await Api.sendFriendRequest(id); toast('Friend request sent.', 'ok'); }
        catch (ex) { toast(ex.message || 'Could not send request.', 'error'); }
      },
    });
    actions.push({
      label: 'Report user', onSelect: () => openReportDialog({
        targetType: 'user', targetId: id, title: 'Report user', subtitle: '@' + (m.username || 'unknown'),
        onSubmit: ({ category, extra }) => Api.reportContent('user', id, category, extra || undefined),
      }),
    });
  }
  return actions;
}

const DESTINATIONS = [
  { id: 'home', label: 'Home', icon: 'home', href: '#/home' },
  { id: 'dms', label: 'DMs', icon: 'mail', href: '#/dms' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', href: '#/notifications', badge: () => State.notifUnread },
  { id: 'discover', label: 'Discover', icon: 'search', href: '#/discover' },
  { id: 'support', label: 'Support', icon: '?', href: '#/support' },
  { id: 'friends', label: 'Friends', icon: 'users', href: '#/friends' },
];

let navRoute = () => '';

export function setNavRoute(fn) {
  navRoute = fn;
}

function currentRoute() {
  return navRoute();
}


export function renderCommunities(region) {
  clear(region);
  if (!isAuthed()) return;
  const route = currentRoute();

  const globalItems = [
    { id: 'home', label: 'Home', icon: 'home', href: '#/home' },
    { id: 'dms', label: 'Direct messages', icon: 'mail', href: '#/dms' },
    { id: 'notifications', label: 'Notifications', icon: 'bell', href: '#/notifications', badge: () => State.notifUnread },
    { id: 'discover', label: 'Discover', icon: 'search', href: '#/discover' },
    { id: 'friends', label: 'Friends', icon: 'users', href: '#/friends', badge: () => (State.friendsIn || []).length },
  ];

  const railButton = ({ label, icon: iconName, href, active, badge }) => {
    const btn = el('button', {
      class: 'rail-nav-item' + (active ? ' active' : ''),
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-current': active ? 'page' : null,
      dataset: { label },
      onClick: () => { location.hash = href; },
    }, el('span', { class: 'rail-nav-icon' }, icon(iconName)));
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
        onClick: () => { location.hash = serverPath(s.id); },
      });
      chip.dataset.label = s.name || 'Community';
      attachContextMenu(chip, serverChipMenuFor(s), {
        target: (node) => ({ type: 'community', id: String(s.id) }),
      });
      region.appendChild(chip);
    }
  }

  // Creation action. Discover is deliberately absent: it is a global
  const create = el('button', {
    class: 'rail-nav-item community-action',
    type: 'button',
    title: 'Create a community',
    'aria-label': 'Create a community',
    dataset: { label: 'Create a community' },
    onClick: () => { location.hash = '#/servers/new'; },
  }, el('span', { class: 'rail-nav-icon' }, icon('plus')));
  region.appendChild(el('div', { class: 'rail-divider' }));
  region.appendChild(create);

  const foot = el('div', { class: 'rail-foot' });
  foot.appendChild(sidebarToggleButton());
  region.appendChild(foot);
}

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

//   user-controls pinned session bar

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


// geometry is unchanged either way, so adding media never moves the controls.
function communityHeader(sid, server) {
  const name = (server && server.name) || (State.serverDetail && State.serverDetail.name) || 'Community';
  const identity = server || State.serverDetail;
  const head = el('header', { class: 'ctx-head ctx-head--community' + (communityBannerUrl(identity) ? ' has-banner' : '') });
  const bar = el('div', { class: 'ctx-head__bar' });
  const banner = communityBannerUrl(identity);
  if (banner) {
    const layer = el('div', { class: 'ctx-head__banner' });
    loadAuthedImage(banner).then((url) => {
      if (url) layer.style.backgroundImage = 'url("' + url + '")';
    });
    head.appendChild(layer);
  }
  bar.appendChild(el('span', { class: 'ctx-head__mark' }, communityMark(name, { server: identity })));
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

  // list. Every entry is permission-gated by the existing role system.
  // attachMenu, not a second dropdown implementation: this is the same menu as
  // right-click and long-press, so submenus, disabled items, Escape, arrow keys
  // and outside-click dismissal behave identically whichever menu is opened.
  attachMenu(trigger, () => {
    const go = (path) => () => { location.hash = path; };
    const base = serverPath(sid);
    const items = [];

    items.push({ label: 'Community overview', icon: '⌂', onSelect: go(base) });
    items.push({ label: 'Members', icon: 'menu', onSelect: go(base + '/members') });
    if (can('MANAGE_ROLES') || can('MANAGE_SERVER')) {
      items.push({ label: 'Roles', icon: '◈', onSelect: go(base + '/roles') });
    }
    if (can('MANAGE_CHANNELS')) {
      items.push({ label: 'Categories', icon: 'list', onSelect: go(base + '/categories') });
      items.push({ label: 'Create channel', icon: '＋', onSelect: go(base + '/channels/new') });
    }
    if (can('MANAGE_INVITES')) {
      items.push({ label: 'Invites', icon: 'mail', onSelect: go(base + '/invites') });
    }
    if (can('MANAGE_SERVER')) {
      items.push({ sep: true });
      items.push({ label: 'Community settings', icon: 'gear', onSelect: go(base + '/settings') });
    }
    items.push({ sep: true });
    items.push({ label: 'Leave community', icon: 'logout', danger: true, onSelect: () => serverChipMenuLeave(sid, server) });
    return items;
  });
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
  // both normalise casing themselves, so never rebuild the user object here.
  idBox.appendChild(el('span', { class: 'user-controls__avatar' }, avatar(me, { size: 'sm', withPresence: true })));
  const info = el('span', { class: 'user-controls__info' });
  info.appendChild(el('span', { class: 'user-controls__name' }, me.displayName || me.display_name || me.username || 'You'));
  info.appendChild(el('span', { class: 'user-controls__status' }, 'Online'));
  idBox.appendChild(info);
  bar.appendChild(idBox);
  const buttons = el('div', { class: 'user-controls__buttons' });
  buttons.appendChild(el('button', {
    class: 'user-controls__btn', type: 'button',
    title: 'Settings', 'aria-label': 'Settings',
    onClick: () => { location.hash = '#/settings'; },
  }, icon('gear')));
  bar.appendChild(buttons);
  return bar;
}

// Re-render every mounted session bar in place.
export function refreshSessionBar() {
  if (!State.me) return;
  document.querySelectorAll('.user-controls').forEach((old) => {
    const next = sessionBar();
    if (next) old.replaceWith(next);
  });
}


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

  // Channel actions, permission-shaped. Editing a channel lives in Community
  // administration must not become a disconnected second system.
  const channelActions = (ch) => {
    const cid = String(ch.id);
    const items = [
      { label: 'Open channel', desc: '#' + (ch.name || 'channel'), onSelect: () => { location.hash = channelPath(sid, cid); } },
      { label: isMuted(ch.id) ? 'Unmute channel' : 'Mute channel', onSelect: () => setMuted(ch.id, !isMuted(ch.id)) },
      { label: 'Copy channel link', onSelect: () => copyText(absoluteChannelUrl(sid, cid), 'Channel link copied.') },
      { label: 'Copy channel ID', onSelect: () => copyText(cid, 'Channel ID copied.') },
    ];
    if (can('MANAGE_CHANNELS')) {
      items.push({ sep: true });
      items.push({
        label: 'Edit channel', onSelect: () => { location.hash = serverPath(sid, 'settings/structure'); },
      });
    }
    return items;
  };

  const channelRowEl = (ch) => {
    const active = route === '/server/' + sid + '/channel/' + ch.id;
    const row = channelRow(ch, {
      active, muted: isMuted(ch.id),
      onClick: () => { location.hash = channelPath(sid, ch.id); },
    });
    attachContextMenu(row, () => channelActions(ch), {
      target: () => ({ type: 'channel', id: String(ch.id) }),
    });
    return row;
  };

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

  // here. The sidebar is deliberately channels-only: mixing destinations

  const bar = sessionBar();
  if (bar) region.appendChild(bar);
}


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

// Privacy Policy are full document loads at /terms and /privacy, not hash
function supportContext(region) {
  simpleListContext(region, {
    title: 'Support',
    sub: 'Help and appeals',
    groups: [{ label: 'Support', items: [
      { label: 'Support home', path: '/support', exact: true },
      { label: 'Appeal a decision', path: '/support/appeals/new', exact: true },
    ] }, { label: 'Your appeals', items: [
      { label: 'My appeals', path: '/support/appeals', exact: true },
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

// queue - an admin reaches it deliberately, not while triaging - so it lives
// current destination is never hidden behind a collapsed control.
const ADMIN_SECTIONS = [
  { label: 'Overview', path: '/admin', exact: true },
  { label: 'Users', path: '/admin/users' },
  { label: 'Communities', path: '/admin/communities' },
  { label: 'Reports', path: '/admin/reports' },
  { label: 'Appeals', path: '/admin/appeals' },
  { label: 'GDPR requests', path: '/admin/gdpr' },
  // The site builder. It was reachable only by typing the URL or by arriving
  // from the account menu, because nothing in the navigation pointed at it -
  // the router and the page's own tab bar had it, the sidebar did not.
  { label: 'Pages', path: '/admin/pages' },
  { label: 'Audit log', path: '/admin/audit' },
];

const ADMIN_OVERFLOW = [
  { label: 'Announcements', path: '/admin/announcements' },
];

const adminSectionActive = (s, route) => (s.exact ? route === s.path : (route === s.path || route.startsWith(s.path + '/')));

function adminContext(region) {
  const route = currentRoute();
  region.appendChild(pageHeader('Administration', 'Moderation and platform health'));
  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);
  const group = navGroup({ label: 'Console' });
  for (const s of ADMIN_SECTIONS) {
    group.list.appendChild(navRow({
      label: s.label, href: '#' + s.path, active: adminSectionActive(s, route),
      onClick: () => { location.hash = '#' + s.path; },
    }));
  }
  scroll.appendChild(group);

  const activeOverflow = ADMIN_OVERFLOW.find((s) => adminSectionActive(s, route));
  const more = navGroup({
    label: activeOverflow ? activeOverflow.label : 'More',
    collapsible: true,
    collapsed: !activeOverflow,
    id: 'admin-overflow',
  });
  for (const s of ADMIN_OVERFLOW) {
    more.list.appendChild(navRow({
      label: s.label, href: '#' + s.path, active: adminSectionActive(s, route),
      onClick: () => { location.hash = '#' + s.path; },
    }));
  }
  scroll.appendChild(more);

  const bar = sessionBar();
  if (bar) region.appendChild(bar);
}


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
  if (path.startsWith('/support') || path.startsWith('/legal')) return { type: 'support' };
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
    case 'support': return supportContext(region);
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


export function isSidebarCollapsed() {
  try { return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1'; } catch { return false; }
}

export function toggleSidebar() {
  const next = !isSidebarCollapsed();
  try { localStorage.setItem(LS_SIDEBAR_COLLAPSED, next ? '1' : '0'); } catch { /* ignore */ }
  applySidebarState();
}

export function applySidebarState() {
  const shell = qs('#shell');
  if (shell) shell.classList.toggle('sidebar-collapsed', isSidebarCollapsed());
  renderAllChrome();
}

const SIDEBAR_DOCK_MIN = 760;

function contextSidebarDocked() {
  return window.innerWidth >= SIDEBAR_DOCK_MIN;
}

function contextSidebarVisible() {
  const shell = qs('#shell');
  if (!shell) return false;
  if (shell.classList.contains('sidebar-collapsed')) return isDesktopNavOpen();
  if (isDesktopNavOpen()) return true;
  return contextSidebarDocked();
}

export function toggleContextSidebar() {
  const shell = qs('#shell');
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
      const rowWrap = el('div', { class: 'member-row-wrap' });
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
      attachContextMenu(row, memberMenu(m), {
        target: (node) => ({ type: 'member', id: String(m.user_id || m.id) }),
      });
      let hoverTimer = null;
      const hoverCapable = () => {
        try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return true; }
      };
      row.addEventListener('mouseenter', () => {
        if (!hoverCapable()) return;
        hoverTimer = setTimeout(() => {
          const r = row.getBoundingClientRect();
          showUserCard(r.right + 8, r.top, {
            avatarEl: avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'lg', withPresence: true }),
            title: name,
            sub: '@' + (m.username || 'unknown'),
            statusLine: m.status_text || null,
            actions: [],
          });
        }, 420);
      });
      const clearHover = () => { clearTimeout(hoverTimer); hoverTimer = null; };
      row.addEventListener('mouseleave', clearHover);
      row.addEventListener('click', clearHover);
      rowWrap.appendChild(row);
      group.appendChild(rowWrap);
    }
    region.appendChild(group);
  }
  if (!(State.members || []).length) {
    region.appendChild(el('div', { class: 'member-sidebar__empty' }, 'No members to show yet.'));
  }
}


// `icon` is destructured to iconGlyph rather than bound as `icon`: the imported
// icon() below builds the navigation toggle, and a parameter of the same name
// shadowed it. Every caller omits it, so icon() resolved to undefined and threw
// "icon is not a function" on every single header render - which is every page.
// The public { icon } key is unchanged; only the local binding is renamed.
export function renderContextHeader({ title, sub, icon: iconGlyph, actions } = {}) {
  const header = qs('#context-header');
  if (!header) return;
  header.dataset.hasIcon = iconGlyph ? 'true' : 'false';
  clear(header);

  if (title) announce(title + (sub ? '. ' + sub : ''));

  const navToggle = el('button', {
    class: 'nav-toggle', type: 'button',
    title: 'Navigation', 'aria-label': 'Toggle navigation',
    'aria-expanded': isDesktopNavOpen() ? 'true' : 'false',
  }, icon('menu'));
  navToggle.addEventListener('click', () => toggleContextSidebar());
  header.appendChild(navToggle);

  const titles = el('div', { class: 'context-header__titles' });
  if (iconGlyph) titles.appendChild(el('div', { class: 'context-header__icon' }, iconGlyph));
  titles.appendChild(el('div', { class: 'context-title', id: 'context-title' }, title || 'Trycord'));
  if (sub) titles.appendChild(el('div', { class: 'context-sub' }, sub));
  header.appendChild(titles);

  const acts = el('div', { class: 'context-actions' });
  for (const a of actions || []) acts.appendChild(a);
  if (actions && actions.length) header.appendChild(acts);

}


export function renderMobileTabs(region) {
  clear(region);
  if (!isAuthed()) return;
  const route = currentRoute();
  const tabs = [
    { id: 'home', label: 'Home', icon: 'home', href: '#/home' },
    { id: 'dms', label: 'DMs', icon: 'mail', href: '#/dms' },
    { id: 'friends', label: 'Friends', icon: 'users', href: '#/friends' },
    { id: 'notifications', label: 'Alerts', icon: 'bell', href: '#/notifications' },
    { id: 'menu', label: 'Menu', icon: 'menu', href: '#/menu' },
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

// Each region is independent: the rail, the channel list, the mobile tab bar and
// the member pane are separate features, and one of them failing says nothing
// about the others.
//
// They were painted by one unguarded sequence, so any throw inside any of them
// propagated out of renderAllChrome and into the router's catch - which replaced
// the whole view with an error screen. A stale cached module was enough to blank
// the entire app that way: shell.js calling icon() against a components.js the
// page had not reloaded threw "icon is not a function" and took every region
// with it.
function paintRegion(fn) {
  try {
    fn();
  } catch (e) {
    try { console.error('[trycord] chrome region failed', e); } catch { /* ignore */ }
  }
}

export function renderAllChrome() {
  paintRegion(() => renderCommunities(qs('#community-navigation')));
  paintRegion(() => renderPlaceNavigation(qs('#place-navigation')));
  paintRegion(() => renderMobileTabs(qs('#mobile-tab-navigation')));
  paintRegion(() => renderMemberSidebar(qs('#member-sidebar')));
  paintRegion(() => renderAnnouncementBanner());
  paintRegion(() => renderVerifyBanner());
}

// fetched once per session and then refreshed on a slow interval, so an admin
let annState = { items: [], loaded: false, timer: null };

export function loadAnnouncements({ force = false } = {}) {
  if (!isAuthed()) return Promise.resolve([]);
  if (annState.loaded && !force) return Promise.resolve(annState.items);
  return Api.announcements()
    .then((list) => {
      annState = { items: Array.isArray(list) ? list : [], loaded: true, timer: annState.timer };
      renderAnnouncementBanner();
      return annState.items;
    })
    .catch(() => { annState = { items: [], loaded: true, timer: annState.timer }; return []; });
}

function scheduleAnnouncementRefresh() {
  if (annState.timer) return;
  // Deliberately slow: this is instance chrome, not live data.
  annState.timer = setInterval(() => { loadAnnouncements({ force: true }); }, 120000);
}

// Announcements are session-scoped chrome. Without this the refresh timer
// outlives sign-out, keeps firing against a dead session, and carries the
// previous user's banners into the next session.
// This only tears down. It must not go back through renderAnnouncementBanner(),
// which reschedules whenever a session still looks live: sign-out clears the
// token *after* calling this, so the old token is still present here and the
export function clearAnnouncements() {
  if (annState.timer) { clearInterval(annState.timer); }
  annState = { items: [], loaded: false, timer: null };
  paintAnnouncementBanners();
}

export function renderAnnouncementBanner() {
  if (isAuthed()) scheduleAnnouncementRefresh();
  paintAnnouncementBanners();
}

function paintAnnouncementBanners() {
  const items = annState.items || [];
  for (const shell of [qs('#trycord-main')]) {
    if (!shell) continue;
    for (const old of Array.from(shell.querySelectorAll(':scope > .announce-banner'))) old.remove();
    for (const a of items.slice(0, 2)) {
      const level = ['info', 'warning', 'critical'].includes(a.level) ? a.level : 'info';
      const bar = el('div', {
        class: 'announce-banner announce-banner--' + level,
        role: level === 'critical' ? 'alert' : 'status',
      });
      if (a.linkHref) {
        bar.appendChild(el('a', { class: 'announce-banner__link', href: a.linkHref }, a.linkLabel || 'Open'));
      }
      bar.appendChild(el('span', { class: 'announce-banner__text' }, a.body));
      shell.prepend(bar);
    }
  }
}

// Shown while the session is unverified, with resend or
export function renderVerifyBanner() {
  const me = State.me;
  const show = !!(isAuthed() && mustVerifyToPost());
  for (const shell of [qs('#trycord-main')]) {
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

export default { renderAllChrome, renderVerifyBanner, renderContextHeader, renderCommunities, renderPlaceNavigation, renderMemberSidebar, renderMobileTabs, setNavRoute, membersHidden, toggleMembers, isSidebarCollapsed, toggleSidebar, applySidebarState };
