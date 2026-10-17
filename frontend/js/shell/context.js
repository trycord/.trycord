// The place column.
//
// One column, one scope - never mixed. Whatever the address is, this module
// answers with a head that names the place and a body of links into it: the
// registry's global destinations for the reader's own scope, the channel tree
// for a community, and nothing from the other scope hanging around underneath.
//
// The account control is not here. The shell keeps it at the foot of the
// column, so every scope has it and no page has to remember to add it.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar, channelIcon, countBadge, iconButton, serverMark } from '../ui/primitives.js';
import { State, can, isMuted, nameOf, refreshMutes, refreshServers } from '../../packages/store.js';
import { path, currentRoute, navigate } from '../../packages/nav.js';
import { openMenu, attachContextMenu, confirmDialog, toast, errorToast } from '../ui/overlays.js';
import { globalPages } from '../../packages/registry.js';
import { brandMark } from './frame.js';
import { attachUserMenu } from '../user-menu.js';
import Api from '../../packages/api.js';

// ---- shared pieces ---------------------------------------------------------

function headIdentity(node, actions) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : (actions ? [actions] : []);
  return el('div', { class: 'context-identity' },
    node,
    list.length ? el('div', { class: 'context-actions' }, list) : null,
  );
}

function group(label, nodes) {
  if (!nodes.length) return null;
  return el('div', { class: 'nav-group' },
    label ? el('div', { class: 'nav-label' }, label) : null,
    nodes);
}

function navItem(entry, active) {
  return el('a', {
    class: 'nav-item' + (active ? ' is-active' : ''),
    href: path(entry.route),
    'aria-label': entry.label,
    'aria-current': active ? 'page' : null,
  },
    icon(entry.icon, { size: 18 }),
    el('span', { class: 'truncate' }, entry.label),
    entry.badge || null,
  );
}

function activeFor(here, route) {
  return !!here && !!route && (here === route || here.startsWith(route + '/'));
}

// ---- the reader's own scope ------------------------------------------------

// The five global destinations are the registry's, drawn in registry order, so
// the column and the phone's tab bar can never disagree about what exists.
function globalNavigation() {
  const here = currentRoute();
  const nav = el('nav', { id: 'global-navigation', class: 'nav-group', 'aria-label': 'Global' });
  for (const page of globalPages()) {
    nav.appendChild(navItem({
      route: page.route,
      label: page.nav.label,
      icon: page.nav.icon,
      badge: page.id === 'notifications' ? countBadge(State.notifications.unreadCount) : null,
    }, activeFor(here, page.route)));
  }
  return nav;
}

function dmUsers(dm) {
  const me = State.user && State.user.id;
  const users = dm.users || dm.participants || [];
  return users.filter((user) => user && user.id !== me).map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.displayName || user.username,
    avatarUrl: user.avatar_url !== undefined ? user.avatar_url : user.avatarUrl,
  }));
}

function dmRow(dm, here) {
  const peer = dmUsers(dm);
  const name = peer.map((user) => nameOf(user)).join(', ') || 'Conversation';
  const active = here === '/dms/' + dm.id;
  const row = el('a', {
    class: 'nav-item nav-item--dm' + (active ? ' is-active' : ''),
    href: path('/dms/' + dm.id),
    'aria-current': active ? 'page' : null,
  },
    peer.length === 1
      ? avatar(peer[0], { size: 'sm', presence: State.presence.get(peer[0].id) || 'offline' })
      : el('span', { class: 'dm-stack' }, peer.slice(0, 2).map((user) => avatar(user, { size: 'xs' }))),
    el('span', { class: 'truncate' }, name),
  );
  // On a person, the conversation is only one of the things the row can do, so
  // the row carries the whole person menu on a right-click or a long press.
  if (peer.length === 1) attachUserMenu(row, peer[0]);
  return row;
}

function youContext(kind) {
  const head = headIdentity(
    brandMark('context-brand'),
    kind === 'dms'
      ? [iconButton('plus', { label: 'Start a conversation', onClick: () => navigate('/friends') })]
      : null,
  );
  const parts = [globalNavigation()];

  if (kind === 'dms') {
    const list = State.dms;
    parts.push(el('div', { class: 'nav-sep' }));
    parts.push(list.length
      ? group('Conversations', list.map((dm) => dmRow(dm, currentRoute())))
      : el('div', { class: 'context-empty' }, 'No conversations yet. Open a friend to start one.'));
  }

  return { head, body: parts };
}

// ---- a community -----------------------------------------------------------

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

function communityIdentity(server) {
  const mark = server
    ? serverMark(server, { size: 'sm' })
    : el('span', { class: 'context-mark-fallback' }, icon('grid', { size: 16 }));
  return el('a', {
    class: 'context-identity-link',
    href: path('/server/' + (server ? server.id : '')),
    title: server ? server.name : 'Community',
  },
    mark,
    el('span', { class: 'truncate' }, server ? server.name : 'Community'));
}

function communityContext(serverId) {
  const server = State.servers.find((entry) => entry.id === serverId) || State.serverDetail.get(serverId);
  const here = currentRoute();
  const tree = State.serverTree.get(serverId) || { categories: [], channels: [] };

  // The settings shortcut is drawn only when the reader could open the settings,
  // and the question is asked of the permission system rather than of a cache
  // that nothing fills.
  const manages = can(serverId, 'MANAGE_SERVER');
  const actions = [
    manages ? iconButton('settings', {
      label: 'Community settings',
      onClick: () => navigate('/server/' + serverId + '/settings'),
    }) : null,
    iconButton('more', {
      label: 'Community menu',
      haspopup: 'menu',
      onClick: (event) => openCommunityMenu(event, serverId, server),
    }),
  ];

  const channelItem = (channel) => {
    const route = '/server/' + serverId + '/channel/' + channel.id;
    const link = el('a', {
      class: 'nav-item nav-item--channel' + (here.startsWith(route) ? ' is-active' : ''),
      href: path(route),
      'aria-current': here.startsWith(route) ? 'page' : null,
    },
      channelIcon(channel, 16),
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

  return {
    head: headIdentity(communityIdentity(server), actions),
    body: sections.length ? sections : [el('div', { class: 'context-empty' }, 'No channels yet.')],
  };
}

function openCommunityMenu(event, serverId, server) {
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

// ---- a channel carries a menu too -------------------------------------------

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

export function buildContext(kind, ctx, page) {
  switch (kind) {
    case 'home':
    case 'dms':
    case 'friends':
    case 'notifications':
      return youContext(kind);
    case 'community':
      return communityContext(ctx.serverId);
    default:
      return null;
  }
}
