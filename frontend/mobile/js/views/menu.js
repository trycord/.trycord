// The directory, on a phone.
//
// Everywhere a reader can go, in one scroll: the global destinations, then each
// community with its channels, then the account controls. It is the phone's
// answer to a rail plus a sidebar, and it is a screen rather than a drawer so it
// can carry the full map without a gesture.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { serverMark, loading, failure } from '../components.js';
import { State, logout } from '../../../packages/store.js';
import { path, navigate, BASE } from '../../../packages/nav.js';
import { setOverride, siblingMount } from '../../../packages/chooser.js';
import Api from '../../../packages/api.js';
import { screen, section } from './util.js';
import { attachLongPress } from '../ui.js';
import { channelActions } from '../manage.js';

const GLOBAL = [
  { route: '/home', label: 'Home', icon: 'home' },
  { route: '/dms', label: 'Direct messages', icon: 'message' },
  { route: '/friends', label: 'Friends', icon: 'users' },
  { route: '/notifications', label: 'Notifications', icon: 'bell' },
  { route: '/search', label: 'Search', icon: 'search' },
  { route: '/collections', label: 'Collections', icon: 'folder' },
  { route: '/federation', label: 'Federation reports', icon: 'share' },
  { route: '/discover', label: 'Discover', icon: 'compass' },
  { route: '/status', label: 'Service status', icon: 'activity' },
];

function channelIcon(channel) {
  const type = String(channel.type || 'text');
  if (type === 'voice' || type === 'stage') return 'volume';
  if (type === 'announcement') return 'bell';
  return 'hash';
}

export function renderMenu() {
  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Everything you can reach'),
      el('div', { class: 'm-hero__sub' }, 'Your destinations, every community you are in, and your account.')),
    host);

  async function load() {
    host.replaceChildren(loading('Building the directory'));
    try {
      const trees = await Promise.all(State.servers.map((server) =>
        Api.channels(server.id).then((tree) => ({ server, tree })).catch(() => ({ server, tree: null }))));
      paint(trees);
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint(trees) {
    host.replaceChildren();

    const globals = el('div', { class: 'm-list' });
    for (const entry of GLOBAL) {
      globals.appendChild(el('a', { class: 'm-row', href: path(entry.route) },
        el('span', { class: 'm-row__lead' }, icon(entry.icon, { size: 18 })),
        el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, entry.label))));
    }
    host.appendChild(section('Trycord', globals));

    if (!State.servers.length) {
      host.appendChild(section('Communities', el('div', { class: 'm-actions' },
        el('a', { class: 'm-btn m-btn--primary', href: path('/servers/new') }, 'Create one'),
        el('a', { class: 'm-btn m-btn--ghost', href: path('/discover') }, 'Discover'))));
    } else {
      for (const { server, tree } of trees) host.appendChild(communitySection(server, tree));
    }

    host.appendChild(accountSection());
  }

  function communitySection(server, tree) {
    const channels = (tree && tree.channels) || [];
    const categories = (tree && tree.categories) || [];
    const order = new Map(categories.map((c) => [c.id, c.position || 0]));
    const rank = (channel) => {
      const place = order.get(channel.category_id || channel.categoryId);
      return place === undefined ? -1 : place;
    };
    const sorted = channels.slice().sort((a, b) => (rank(a) - rank(b)) || ((a.position || 0) - (b.position || 0)));
    const members = server.member_count || 0;

    const header = el('div', { class: 'm-section__head' },
      el('a', { class: 'm-section__lead', href: path('/server/' + server.id) },
        serverMark(server, { size: 'sm' }),
        el('span', { class: 'm-section__title' }, server.name)),
      el('span', { class: 'm-section__note' }, members + (members === 1 ? ' member' : ' members')));

    const list = el('div', { class: 'm-list' });
    if (sorted.length) {
      for (const channel of sorted) {
        const row = el('a', { class: 'm-row', href: path('/server/' + server.id + '/channel/' + channel.id) },
          el('span', { class: 'm-row__lead' }, icon(channelIcon(channel), { size: 16 })),
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title truncate' }, channel.name)));
        // A long press on a channel raises the actions that belong to it.
        attachLongPress(row, () => channelActions(server.id, channel, null), { title: '#' + channel.name });
        list.appendChild(row);
      }
    } else {
      list.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__sub' }, tree ? 'No channels yet.' : 'This community could not be read.'))));
    }
    return el('section', { class: 'm-section' }, header, list);
  }

  function accountSection() {
    const list = el('div', { class: 'm-list' });
    list.appendChild(el('a', { class: 'm-row', href: path('/settings') },
      el('span', { class: 'm-row__lead' }, icon('user', { size: 18 })),
      el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Settings'))));
    if (State.user && State.user.isAdmin) {
      list.appendChild(el('a', { class: 'm-row', href: path('/admin') },
        el('span', { class: 'm-row__lead' }, icon('shield', { size: 18 })),
        el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Administration'))));
    }
    list.appendChild(el('button', {
      class: 'm-row', type: 'button',
      onClick: () => { setOverride('desktop'); window.location.assign(siblingMount('mobile', BASE) + '/'); },
    },
      el('span', { class: 'm-row__lead' }, icon('server', { size: 18 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, 'Open the desktop site'),
        el('span', { class: 'm-row__sub' }, 'Use the full layout on this device'))));
    list.appendChild(el('button', {
      class: 'm-row', type: 'button',
      onClick: async () => {
        try { await logout(); } catch { /* the session is going regardless */ }
        navigate('/login');
      },
    },
      el('span', { class: 'm-row__lead' }, icon('log-out', { size: 18 })),
      el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Sign out'))));
    return section('Account', list);
  }

  return { node, head: { title: 'Menu' }, onMount: load };
}

export default { renderMenu };
