// The current place's navigation.
//
// Every screen that has one gets it from here, so its shape is decided once: a
// head that names where you are and a scrollable body of links. The account is
// not here any more - the shell's spine carries it at the foot of the column, so
// every place has it and no page has to remember to add it.

import { el } from './dom.js';
import { icon } from './icons.js';
import { avatar, iconButton, serverMark } from './components.js';
import { State, nameOf, isMuted, refreshMutes, refreshServers } from './store.js';
import { path, currentRoute, navigate } from './nav.js';
import { openMenu, attachContextMenu, confirmDialog, toast, errorToast } from './ui.js';
import { attachUserMenu } from './user-menu.js';
import Api from './api.js';

function head(title, actions) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : (actions ? [actions] : []);
  return el('div', { class: 'sidebar-head' },
    el('div', { class: 'sidebar-title truncate' }, title),
    list.length ? el('div', { class: 'sidebar-actions' }, list) : null,
  );
}

function body(children) {
  const node = el('div', { class: 'sidebar-scroll' });
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function navItem(entry, active) {
  return el('a', {
    class: 'nav-item' + (active ? ' is-active' : ''),
    href: path(entry.route),
    'aria-current': active ? 'page' : null,
  },
    icon(entry.icon, { size: 18 }),
    el('span', { class: 'truncate' }, entry.label),
  );
}

// ---- global sidebars -------------------------------------------------------

// Home is a global surface, so the destinations it used to list - friends,
// discover, the directory - are the spine's global group now. What is left that
// is worth a column is the reader's own communities, as links rather than the
// switcher's menu, so they can be middle-clicked and opened in a new tab.
function homeSidebar() {
  const here = currentRoute();
  return [
    head('Home', iconButton('plus', {
      label: 'Create a community',
      onClick: () => navigate('/servers/new'),
    })),
    body([
      el('div', { class: 'nav-label' }, 'Your communities'),
      State.servers.length
        ? el('div', { class: 'nav-group' }, State.servers.map((server) => {
          const link = el('a', {
            class: 'nav-item' + (here.startsWith('/server/' + server.id) ? ' is-active' : ''),
            href: path('/server/' + server.id),
          }, serverMark(server, { size: 'xs' }), el('span', { class: 'truncate' }, server.name));
          attachContextMenu(link, () => serverMenuItems(server));
          return link;
        }))
        : el('div', { class: 'sidebar-empty' }, 'No communities yet.'),
    ]),
  ];
}

// The actions a community carries wherever its name is drawn - the home column
// and the far-left rail. One list, so the two never disagree.
export function serverMenuItems(server) {
  const id = server.id;
  return [
    { header: server.name },
    { label: 'Open', icon: 'arrow-right', onSelect: () => navigate('/server/' + id) },
    { label: 'Copy link', icon: 'link', onSelect: () => copyLink('/server/' + id) },
    { separator: true },
    { label: 'Invite people', icon: 'mail', onSelect: () => navigate('/server/' + id + '/settings/invites') },
    { label: 'Members', icon: 'users', onSelect: () => navigate('/server/' + id + '/members') },
    { label: 'Community settings', icon: 'settings', onSelect: () => navigate('/server/' + id + '/settings') },
  ];
}

function dmsSidebar(ctx) {
  const here = currentRoute();
  const list = State.dms;
  return [
    head('Direct messages', iconButton('plus', {
      label: 'Start a conversation',
      onClick: () => navigate('/friends'),
    })),
    body([
      list.length
        ? el('div', { class: 'nav-group' }, list.map((dm) => dmRow(dm, here)))
        : el('div', { class: 'sidebar-empty' }, 'No conversations yet. Open a friend to start one.'),
    ]),
  ];
}

function dmRow(dm, here) {
  const peer = dmUsers(dm);
  const name = peer.map((u) => nameOf(u)).join(', ') || 'Conversation';
  const active = here === '/dms/' + dm.id;
  const row = el('a', {
    class: 'nav-item nav-item--dm' + (active ? ' is-active' : ''),
    href: path('/dms/' + dm.id),
    'aria-current': active ? 'page' : null,
  },
    peer.length === 1
      ? avatar(peer[0], { size: 'sm', presence: State.presence.get(peer[0].id) || 'offline' })
      : el('span', { class: 'dm-stack' }, peer.slice(0, 2).map((u) => avatar(u, { size: 'xs' }))),
    el('span', { class: 'truncate' }, name),
  );
  // On a person, the conversation is only one of the things the row can do, so
  // the row carries the whole person menu on a right-click or a long press.
  if (peer.length === 1) attachUserMenu(row, peer[0]);
  return row;
}

function dmUsers(dm) {
  const me = State.user && State.user.id;
  const users = dm.users || dm.participants || [];
  return users.filter((u) => u && u.id !== me).map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.displayName || u.username,
    avatarUrl: u.avatar_url !== undefined ? u.avatar_url : u.avatarUrl,
  }));
}

function friendsSidebar(ctx) {
  const tab = ctx.query && ctx.query.get ? ctx.query.get('tab') || 'all' : 'all';
  const items = [
    { id: 'all', route: '/friends', label: 'All', icon: 'users' },
    { id: 'online', route: '/friends?tab=online', label: 'Online', icon: 'dot' },
    { id: 'pending', route: '/friends?tab=pending', label: 'Pending', icon: 'mail' },
    { id: 'blocked', route: '/friends?tab=blocked', label: 'Blocked', icon: 'ban' },
    { id: 'add', route: '/friends?tab=add', label: 'Add friend', icon: 'plus' },
  ];
  return [
    head('Friends', null),
    body([
      el('div', { class: 'nav-group' }, items.map((item) => navItem(item, tab === item.id))),
    ]),
  ];
}

function notificationsSidebar() {
  return [
    head('Notifications', null),
    body([
      el('div', { class: 'sidebar-note' }, 'Everything addressed to you, newest first.'),
    ]),
  ];
}

// ---- community -------------------------------------------------------------

export function communitySidebar(ctx, serverId) {
  const server = State.servers.find((s) => s.id === serverId) || State.serverDetail.get(serverId);
  const tree = State.serverTree.get(serverId) || { categories: [], channels: [] };
  const here = currentRoute();

  const actions = [
    State.serverPermissions.get(serverId) && (State.serverPermissions.get(serverId).is_owner)
      ? iconButton('settings', { label: 'Community settings', onClick: () => navigate('/server/' + serverId + '/settings') })
      : null,
    iconButton('more', {
      label: 'Community menu',
      onClick: (event) => openCommunityMenu(event, serverId, server),
    }),
  ];

  const group = (label, nodes) => {
    if (!nodes.length) return null;
    return el('div', { class: 'nav-group' },
      el('div', { class: 'nav-label' }, label || 'Channels'),
      nodes);
  };

  const channelItem = (channel) => {
    const route = '/server/' + serverId + '/channel/' + channel.id;
    const active = here.startsWith(route);
    const link = el('a', {
      class: 'nav-item nav-item--channel' + (active ? ' is-active' : ''),
      href: path(route),
      'aria-current': active ? 'page' : null,
    },
      icon(channel.type === 'voice' ? 'volume' : channel.type === 'announcement' ? 'bell' : 'hash', { size: 16 }),
      el('span', { class: 'truncate' }, channel.name),
      isMuted(channel.id) ? el('span', { class: 'nav-muted', title: 'Muted' }, icon('bell', { size: 13 })) : null,
      channel.unread ? el('span', { class: 'nav-dot' }) : null,
    );
    attachContextMenu(link, () => channelMenuItems(serverId, channel));
    return link;
  };

  const byCategory = new Map();
  for (const channel of tree.channels) {
    const key = channel.category_id || '';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(channel);
  }

  const sections = [];
  const named = tree.categories.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  for (const category of named) {
    sections.push(group(category.name, (byCategory.get(category.id) || []).map(channelItem)));
    byCategory.delete(category.id);
  }
  const loose = byCategory.get('') || [];
  const orphans = [];
  for (const [key, list] of byCategory) if (key !== '') orphans.push(...list);
  const uncategorised = loose.concat(orphans);
  if (uncategorised.length) sections.push(group(named.length ? 'Other' : 'Channels', uncategorised.map(channelItem)));

  return [
    head(server ? server.name : 'Community', actions.filter(Boolean)),
    body(sections.length ? sections : [el('div', { class: 'sidebar-empty' }, 'No channels yet.')]),
  ];
}

function openCommunityMenu(event, serverId, server) {
  event.preventDefault();
  const items = [
    { label: 'Invite people', icon: 'mail', onSelect: () => navigate('/server/' + serverId + '/settings/invites') },
    { label: 'Members', icon: 'users', onSelect: () => navigate('/server/' + serverId + '/members') },
    { separator: true },
    { label: 'Community settings', icon: 'settings', onSelect: () => navigate('/server/' + serverId + '/settings') },
    { label: 'Leave community', icon: 'logout', danger: true, onSelect: () => leaveCommunity(serverId, server) },
  ];
  openMenu({ anchor: event.currentTarget, items, align: 'right' });
}

async function leaveCommunity(serverId, server) {
  const sure = await confirmDialog({
    title: 'Leave ' + (server ? server.name : 'this community') + '?',
    body: 'You will need an invite to come back.',
    confirmLabel: 'Leave',
    danger: true,
  });
  if (!sure) return;
  try {
    await Api.leaveServer(serverId);
    await refreshServers();
    toast('You left the community.', { type: 'success' });
    navigate('/home');
  } catch (error) {
    errorToast(error);
  }
}

// ---- a channel and a person carry a menu too -------------------------------

// A channel's own actions. Mute reads the viewer's list rather than a guessed
// default, so the label is what pressing it will actually do.
function channelMenuItems(serverId, channel) {
  const muted = isMuted(channel.id);
  const items = [
    { header: (channel.type === 'voice' ? '' : '#') + channel.name },
    { label: 'Copy link', icon: 'link', onSelect: () => copyLink('/server/' + serverId + '/channel/' + channel.id) },
    { label: muted ? 'Unmute' : 'Mute', icon: 'bell', onSelect: () => toggleMute(channel) },
  ];
  if (channel.topic) items.push({ label: 'Copy topic', icon: 'copy', onSelect: () => copyValue(channel.topic) });
  return items;
}

async function toggleMute(channel) {
  const muted = isMuted(channel.id);
  try {
    if (muted) await Api.unmuteChannel(channel.id);
    else await Api.muteChannel(channel.id);
    await refreshMutes();
    toast(muted ? 'Unmuted.' : 'Muted.', { type: 'success' });
  } catch (error) {
    errorToast(error);
  }
}

// Both helpers fall back to showing the value when the clipboard is unavailable,
// rather than claiming a copy that did not happen.
function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('clipboard unavailable'));
}

function copyLink(route) {
  copyValue(window.location.origin + path(route), 'Link copied.');
}

function copyValue(text, message) {
  writeClipboard(text)
    .then(() => toast(message || 'Copied.', { type: 'success' }))
    .catch(() => toast(text, { type: 'info' }));
}

// ---- dispatch --------------------------------------------------------------

export function buildSidebar(kind, ctx, page) {
  switch (kind) {
    case 'home': return homeSidebar(ctx);
    case 'dms': return dmsSidebar(ctx);
    case 'friends': return friendsSidebar(ctx);
    case 'notifications': return notificationsSidebar(ctx);
    case 'community': return communitySidebar(ctx, ctx.serverId);
    default: return null;
  }
}
