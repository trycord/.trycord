// The directory.
//
// Everywhere a reader can go, in one list: the global destinations, then each
// community with its channels. A map is scanned, not read, so this is rows in
// panels and nothing else - no cards to scroll past.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { serverMark } from '../components.js';
import { State } from '../../packages/store.js';
import { path } from '../../packages/nav.js';
import Api from '../../packages/api.js';
import { page, band, panel, prow, loading, failure } from './util.js';

const GLOBAL = [
  { route: '/home', label: 'Home', icon: 'home' },
  { route: '/dms', label: 'Direct messages', icon: 'message' },
  { route: '/friends', label: 'Friends', icon: 'users' },
  { route: '/notifications', label: 'Notifications', icon: 'bell' },
  { route: '/discover', label: 'Discover', icon: 'compass' },
];

export function renderMenu() {
  const host = el('div', { class: 'stack' });

  const node = page({ wide: true },
    band({
      eyebrow: 'Directory',
      icon: 'list',
      title: 'Everything you can reach',
      lede: 'Your destinations, then every community you are in and the channels inside it.',
    }),
    host,
  );

  async function load() {
    host.replaceChildren(loading('Building the directory'));
    try {
      // One community with a broken channel tree must not take the whole map
      // down with it, so each fetch fails into a panel that says so.
      const trees = await Promise.all(State.servers.map((server) =>
        Api.channels(server.id)
          .then((tree) => ({ server, tree }))
          .catch(() => ({ server, tree: null }))));
      paint(trees);
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint(trees) {
    host.replaceChildren(globalPanel());
    if (!State.servers.length) {
      host.appendChild(panel({
        title: 'Your communities',
        note: 'None yet',
        tight: true,
        body: [
          el('p', { class: 'prow-sub' }, 'You are not in a community yet. Find one to join, or start your own.'),
          el('div', { class: 'prow-actions' },
            el('a', { class: 'btn btn--primary btn--sm', href: path('/discover') }, 'Discover communities'),
            el('a', { class: 'btn btn--default btn--sm', href: path('/servers/new') }, 'Create one')),
        ],
      }));
      return;
    }
    for (const { server, tree } of trees) host.appendChild(communityPanel(server, tree));
  }

  function globalPanel() {
    return panel({
      title: 'Trycord',
      note: 'Every destination',
      plain: true,
      rows: GLOBAL.map((entry) => prow({
        href: path(entry.route),
        lead: icon(entry.icon, { size: 17 }),
        title: entry.label,
      })),
    });
  }

  function communityPanel(server, tree) {
    const channels = (tree && tree.channels) || [];
    const categories = (tree && tree.categories) || [];
    const order = new Map(categories.map((c) => [c.id, c.position || 0]));
    const rank = (channel) => {
      const place = order.get(channel.category_id);
      return place === undefined ? -1 : place;
    };
    const sorted = channels.slice().sort((a, b) =>
      (rank(a) - rank(b)) || ((a.position || 0) - (b.position || 0)));
    const members = server.member_count || 0;

    return panel({
      lead: serverMark(server, { size: 'sm' }),
      title: server.name,
      note: members + (members === 1 ? ' member' : ' members'),
      actions: el('a', {
        class: 'btn btn--ghost btn--sm', href: path('/server/' + server.id),
        'aria-label': 'Open ' + server.name,
      }, icon('arrow-right', { size: 16 })),
      rows: sorted.length
        ? sorted.map((channel) => prow({
          href: path('/server/' + server.id + '/channel/' + channel.id),
          lead: icon(channel.type === 'voice' || channel.type === 'stage' ? 'volume' : channel.type === 'announcement' ? 'bell' : 'hash', { size: 16 }),
          title: channel.name,
        }))
        : [prow({ sub: tree ? 'No channels yet.' : 'This community could not be read.' })],
    });
  }

  return { node, onMount: load };
}

export default { renderMenu };
