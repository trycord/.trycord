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
import { State, can, isMuted, nameOf, refreshServers } from '../../packages/store.js';
import { path, currentRoute, navigate } from '../../packages/nav.js';
import { openMenu, attachContextMenu, confirmDialog, toast, errorToast } from '../ui/overlays.js';
import { globalPages } from '../../packages/registry.js';
import { brandMark } from './frame.js';
import { personContextMenu } from '../ui/person.js';
import Api from '../../packages/api.js';
import { avatarUrlOf } from '../../packages/identity.js';
import { federatedName } from '../../packages/places.js';
import {
  openCategoryDialog, createChannel, moveChannel, toggleMute,
  channelMenuItems, categoryMenuItems, reorderChannels, reorderCategories,
  orderAfterDrop, attachDragOrder, attachDropTarget,
} from '../community/manage.js';

// ---- shared pieces ---------------------------------------------------------

function headIdentity(node, actions) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : (actions ? [actions] : []);
  return el('div', { class: 'context-identity' },
    node,
    list.length ? el('div', { class: 'context-actions' }, list) : null,
  );
}

function group(label, nodes, action, labelNode) {
  if (!nodes.length && !action) return null;
  return el('div', { class: 'nav-group' },
    label
      ? el('div', { class: 'nav-head' },
        // The heading may be a node of the caller's own - a category's heading
        // carries the category's menu and can be dragged, and a heading that is
        // not the one on screen is a heading that cannot be acted on.
        labelNode || el('div', { class: 'nav-label' }, label),
        action || null)
      : null,
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
  const raw = dm.peer ? [dm.peer] : (dm.users || dm.participants || []);
  return raw.filter((user) => user && user.id !== me).map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.displayName || user.username,
    avatarUrl: avatarUrlOf(user),
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
  if (peer.length === 1) personContextMenu(row, peer[0]);
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
  // Creating a channel, a category or a role is a different permission from
  // running the community, and a moderator can hold one without the other.
  const managesChannels = can(serverId, 'MANAGE_CHANNELS');

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

  // The menu a channel offers. The management entries are only here for a
  // reader who may actually use them, and the whole menu opens at the pointer
  // on a right-click as well as from the button.
  const channelMenu = (channel) => channelMenuItems(serverId, channel, {
    canManageChannels: managesChannels,
    muted: isMuted(channel.id),
    onOpen: () => navigate('/server/' + serverId + '/channel/' + channel.id),
    onCopyLink: () => copyLink('/server/' + serverId + '/channel/' + channel.id),
    onCopyTopic: () => copyValue(channel.topic),
    onToggleMute: () => toggleMute(channel),
  });

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
    attachContextMenu(link, () => channelMenu(channel));
    // A channel can be dragged onto another one to take its place, or onto a
    // category to move into it. The order the server holds is the order of the
    // tree's own list, so the drop is computed over that list.
    if (managesChannels) {
      attachDragOrder(link, {
        id: channel.id,
        onDrop: (movedId, targetId) => {
          const order = orderAfterDrop(tree.channels, movedId, targetId);
          if (order) reorderChannels(serverId, order);
        },
      });
    }

    // The people in a voice room are shown under it, so a member can see who
    // is in there before they join it. A text channel has nobody in it, so
    // nothing is drawn for it.
    const people = (channel.participants || []);
    if (!people.length) return link;
    return el('div', { class: 'nav-room' },
      link,
      el('div', { class: 'nav-room__people' },
        ...people.map((person) => el('span', {
          class: 'nav-room__person',
          title: person.displayName || person.username || 'Someone in this room',
        },
          avatar({
            id: person.userId,
            username: person.username,
            displayName: person.displayName,
            avatarUrl: person.avatarUrl,
          }, { size: 'xs', rounded: true, decorative: true }),
          el('span', { class: 'truncate' }, person.displayName || person.username || 'Someone')))));
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
    // The control on the category's heading creates a channel in that
    // category. It is there for a reader who may create channels and for
    // nobody else - a control that cannot work should not be offered.
    const add = managesChannels
      ? el('button', {
        class: 'nav-add',
        type: 'button',
        'aria-label': 'Create a channel in ' + category.name,
        title: 'Create a channel in ' + category.name,
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          createChannel(serverId, category.id);
        },
      }, icon('plus', { size: 14 }))
      : null;

    // The heading itself carries the category's menu, so a right-click on the
    // name reaches the same actions the control does. It is also a place to
    // drop a channel into, and - for a reader who may manage channels - a
    // thing that can be dragged to another category to take its place.
    const heading = el('div', { class: 'nav-label' }, category.name);
    attachContextMenu(heading, () => categoryMenuItems(serverId, category, {
      canManageChannels: managesChannels,
      onCreateChannel: () => createChannel(serverId, category.id),
    }));
    if (managesChannels) {
      attachDropTarget(heading, {
        onDrop: (movedId) => {
          const channel = (tree.channels || []).find((entry) => String(entry.id) === String(movedId));
          if (channel) moveChannel(serverId, channel, category.id);
        },
      });
      attachDragOrder(heading, {
        id: category.id,
        onDrop: (movedId, targetId) => {
          const order = orderAfterDrop(tree.categories, movedId, targetId);
          if (order) reorderCategories(serverId, order);
        },
      });
    }

    sections.push(group(category.name, (byCategory.get(category.id) || []).map(channelItem), add, heading));
    byCategory.delete(category.id);
  }
  const loose = byCategory.get('') || [];
  const orphans = [];
  for (const [key, list] of byCategory) if (key !== '') orphans.push(...list);
  const uncategorised = loose.concat(orphans);
  if (uncategorised.length) {
    sections.push(group(named.length ? 'Other' : 'Channels', uncategorised.map(channelItem)));
  }

  // A community with no channels at all still needs a way to make one.
  if (managesChannels && !tree.channels.length) {
    sections.push(el('div', { class: 'context-empty' },
      'No channels yet.',
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => createChannel(serverId, ''),
      }, icon('plus', { size: 14 }), 'Create the first channel')));
  }

  // The workspace: the community's own spaces, documents, boards, events and
  // polls. It is a place rather than a channel, so it sits at the end of the
  // column under its own heading.
  const workspaceRoute = '/server/' + serverId + '/workspace';
  sections.push(el('div', { class: 'nav-label' }, 'Workspace'));
  sections.push(el('a', {
    class: 'nav-item nav-item--channel' + (here.startsWith(workspaceRoute) ? ' is-active' : ''),
    href: path(workspaceRoute),
    'aria-current': here.startsWith(workspaceRoute) ? 'page' : null,
  }, icon('layers', { size: 16 }), el('span', { class: 'truncate' }, 'Open the workspace')));

  // The two things a manager creates most, at the end of the column.
  if (managesChannels) {
    sections.push(el('div', { class: 'context-actions-row' },
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => createChannel(serverId, ''),
      }, icon('plus', { size: 14 }), 'Channel'),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => openCategoryDialog(serverId, {}),
      }, icon('folder', { size: 14 }), 'Category')));
  }

  return {
    head: headIdentity(communityIdentity(server), actions),
    body: sections.length ? sections : [el('div', { class: 'context-empty' }, 'No channels yet.')],
  };
}

// Move a channel into another category. The dialog itself is the shared one,
// in community/manage.js, so the tree and the settings page ask the same
// question the same way.

function openCommunityMenu(event, serverId, server) {
  const items = [
    { label: 'Invite people', icon: 'mail', onSelect: () => navigate('/server/' + serverId + '/settings/invites') },
    { label: 'Members', icon: 'users', onSelect: () => navigate('/server/' + serverId + '/members') },
    { separator: true },
    { label: 'Workspace', icon: 'layers', onSelect: () => navigate('/server/' + serverId + '/workspace') },
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
//
// The menu itself is the shared one, in community/manage.js: the column and
// the settings page draw the same entries for the same channel, and one
// place decides what a moderator may do with it.

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
    case 'federated':
      return federatedContext(ctx);
    default:
      return null;
  }
}

// The place column of a community that lives on another instance.
//
// There is no channel tree to draw here: the channels are the ones the other
// instance publishes, and they are read, not joined. What the column shows is
// where the community lives and what the reader may do with it.
function federatedContext(ctx) {
  const instanceId = ctx.params && ctx.params.instanceId;
  const communityId = ctx.params && ctx.params.communityId;
  const community = (State.federated || []).find((entry) =>
    String(entry.originInstanceId) === String(instanceId)
    && String(entry.originCommunityId) === String(communityId)) || null;
  const name = community ? federatedName(community) : 'A community on another instance';

  const parts = [
    el('div', { class: 'context-identity' },
      serverMark({
        id: communityId,
        name,
        icon_url: community ? community.iconUrl : null,
      }, { size: 'sm' }),
      el('span', { class: 'truncate' }, name)),
    el('p', { class: 'context-empty' },
      community && community.originName
        ? 'It lives on ' + community.originName + '.'
        : 'It lives on another instance.'),
  ];

  const channels = community && community.channels ? community.channels : [];
  if (channels.length) {
    parts.push(el('div', { class: 'nav-sep' }));
    parts.push(el('p', { class: 'nav-group' }, 'Channels'));
    for (const channel of channels) {
      parts.push(el('div', { class: 'nav-item nav-item--channel' },
        channelIcon(channel, 16),
        el('span', { class: 'truncate' }, channel.name),
        el('span', { class: 'nav-muted' }, channel.canPost ? 'open' : 'read only')));
    }
  }

  return { head: null, body: parts };
}
