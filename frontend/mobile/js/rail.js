// The wide phone.
//
// A phone held sideways is a small tablet, and a small tablet has room for a
// column of communities and a column of channels beside the conversation. So
// on a wide screen the phone grows the two columns the desktop has, and on a
// narrow one it keeps the bottom tabs it has always had.
//
// The two columns are not a new idea: they carry the same information the
// phone's menu screen carries, in the place a person expects it - the
// communities on the left, the channels of the open community next to them.
//
// The columns are shown by their own rule and not by the device being a
// tablet, because a phone is not a tablet with a smaller screen: what
// matters is whether there is room, and room is measured in the window.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { path, currentRoute } from '../../packages/nav.js';
import { State, serverById, channelsOf, categoriesOf } from '../../packages/store.js';
import { serverMark } from './components.js';
import { attachChannelMenu } from './manage.js';

/** The width at which the phone grows its columns. */
export const WIDE_AT = 760;

/** Whether there is room for the columns. */
export function isWide() {
  const width = (typeof window !== 'undefined' && window.innerWidth) || 0;
  return width >= WIDE_AT;
}

// The channels of a community, in the order the community put them in.
//
// The categories come first in the order they were given, and the channels
// that belong to none of them come first of all - which is where a channel
// that was never filed tends to belong.
function orderedChannels(serverId) {
  const channels = channelsOf(serverId);
  const categories = categoriesOf(serverId);
  const rank = new Map(categories.map((category) => [category.id, category.position || 0]));
  const place = (channel) => {
    const at = rank.get(channel.category_id || channel.categoryId);
    return at === undefined ? -1 : at;
  };
  return channels.slice().sort((a, b) =>
    (place(a) - place(b)) || ((a.position || 0) - (b.position || 0)));
}

/**
 * The column of communities.
 *
 * @returns {HTMLElement}
 */
export function buildRail() {
  const rail = el('nav', { class: 'm-rail', 'aria-label': 'Communities' });

  const home = el('a', {
    class: 'm-rail__item m-rail__item--home',
    href: path('/home'),
    'aria-label': 'Home',
  }, el('span', { class: 'm-rail__mark' }, icon('home', { size: 20 })));
  rail.appendChild(home);

  for (const server of State.servers || []) {
    const here = currentRoute() || '';
    const active = here === '/server/' + server.id || here.startsWith('/server/' + server.id + '/');
    rail.appendChild(el('a', {
      class: 'm-rail__item' + (active ? ' is-active' : ''),
      href: path('/server/' + server.id),
      'aria-label': server.name,
      'aria-current': active ? 'page' : null,
    }, el('span', { class: 'm-rail__mark' }, serverMark(server, { size: 'md' }))));
  }

  rail.appendChild(el('a', {
    class: 'm-rail__item m-rail__item--new',
    href: path('/servers/new'),
    'aria-label': 'Make a community',
  }, el('span', { class: 'm-rail__mark' }, icon('plus', { size: 20 }))));

  return rail;
}

/**
 * The column of channels, for the community that is open.
 *
 * @param {string} serverId
 * @returns {HTMLElement|null}
 */
export function buildDrawer(serverId) {
  const server = serverById(serverId);
  if (!server) return null;

  const drawer = el('nav', { class: 'm-drawer', 'aria-label': 'Channels of ' + server.name });
  drawer.appendChild(el('a', {
    class: 'm-drawer__head',
    href: path('/server/' + server.id),
  },
    el('span', { class: 'm-drawer__mark' }, serverMark(server, { size: 'sm' })),
    el('span', { class: 'm-drawer__name truncate' }, server.name)));

  const channels = orderedChannels(server.id);
  if (!channels.length) {
    drawer.appendChild(el('p', { class: 'm-drawer__empty' },
      'No channels yet. A conversation starts in a channel; name one in the settings.'));
    return drawer;
  }

  const list = el('div', { class: 'm-drawer__list' });
  const here = currentRoute() || '';
  for (const channel of channels) {
    const route = '/server/' + server.id + '/channel/' + channel.id;
    const active = here === route;
    const row = el('a', {
      class: 'm-drawer__item' + (active ? ' is-active' : ''),
      href: path(route),
      'aria-current': active ? 'page' : null,
    },
      el('span', { class: 'm-drawer__glyph' }, icon(channelIconOf(channel), { size: 16 })),
      el('span', { class: 'm-drawer__label truncate' }, channel.name));
    // A long press on a channel raises the actions that belong to it, the
    // same as on the phone's own channel list.
    attachChannelMenu(row, server.id, channel, null);
    list.appendChild(row);
  }
  drawer.appendChild(list);
  return drawer;
}

// The glyph of a channel: a hash for a conversation, a speaker for a room.
function channelIconOf(channel) {
  const type = channel && channel.type;
  if (type === 'voice' || type === 'stage') return 'volume';
  if (type === 'forum') return 'messages-square';
  return 'hash';
}

export default { buildRail, buildDrawer, isWide, WIDE_AT };
