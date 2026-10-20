// Command.
//
// The /menu page, rebuilt for a command-first product: a finder that answers
// with everywhere the reader can go - destinations, communities, channels,
// people - grouped and narrowed as they type. On an empty query it shows the
// map itself: where you are, where you can be. Enter takes the first answer.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { serverMark, avatar, channelIcon } from '../ui/primitives.js';
import { State, nameOf } from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { globalPages } from '../../packages/registry.js';
import Api from '../../packages/api.js';
import { tokensIn } from '../../packages/format.js';
import { head, card, row, hold, fault, fold, blank } from '../ui/page.js';
import { copyText } from '../ui/clipboard.js';

export function renderMenu() {
  const input = el('input', {
    class: 'input finder-input', type: 'search',
    placeholder: 'Jump to a place, community, channel or person',
    'aria-label': 'Search everything',
    autocomplete: 'off', spellcheck: 'false',
  });
  const results = el('div', { class: 'fold fold--tight' });

  const node = fold([
    head({
      kicker: 'Everything',
      title: 'Command',
      lede: 'Type to jump. The whole instance answers.',
    }),
    card({ label: 'Finder', glyph: 'search', body: input, tight: true, flat: true }),
    results,
  ]);

  let corpus = [];

  function entry(group, label, route, lead, sub) {
    return { group, label, route, lead: lead || icon('hash', { size: 16 }), sub: sub || null };
  }

  async function build() {
    // Destinations and communities come from what the client already holds; the
    // channel trees are the one fetch this page makes, one per community, each
    // alone allowed to fail.
    const destinations = globalPages().map((page) =>
      entry('Places', page.nav.label, page.route, icon(page.nav.icon, { size: 17 })));
    destinations.push(
      entry('Places', 'Account settings', '/settings', icon('settings', { size: 17 })),
      entry('Places', 'New community', '/servers/new', icon('plus', { size: 17 })),
      entry('Places', 'Extensions', '/extensions', icon('grid', { size: 17 })),
      entry('Places', 'Developer', '/developer', icon('code', { size: 17 })),
    );

    const communities = State.servers.map((server) =>
      entry('Communities', server.name, '/server/' + server.id, serverMark(server, { size: 'sm' }),
        (server.member_count || 0) + ' members'));

    let channels = [];
    let people = [];

    for (const server of State.servers) {
      try {
        const tree = await Api.channels(server.id);
        for (const channel of tree.channels || []) {
          channels.push(entry('Channels',
            (channel.type === 'voice' || channel.type === 'stage' ? '' : '#') + channel.name,
            '/server/' + server.id + '/channel/' + channel.id,
            channelIcon(channel, 16), server.name));
        }
      } catch { /* this community simply answers no channels */ }
    }

    const me = State.user && State.user.id;
    for (const friend of State.friends || []) {
      if (friend && friend.id && String(friend.id) !== String(me)) {
        people.push(entry('People', nameOf(friend), '/users/' + friend.id,
          avatar(friend, { size: 'xs' }), 'Friend'));
      }
    }
    for (const dm of State.dms || []) {
      const peer = (dm.users || dm.participants || []).find((user) => user && String(user.id) !== String(me));
      if (peer && !people.some((item) => item.route === '/dms/' + dm.id)) {
        people.push(entry('People', nameOf(peer), '/dms/' + dm.id, avatar(peer, { size: 'xs' }), 'Conversation'));
      }
    }

    corpus = destinations.concat(communities, channels, people);
  }

  function paint() {
    const query = input.value.trim();
    const keys = tokensIn(query);
    const matched = keys.length
      ? corpus.filter((item) => keys.every((key) => item.label.toLowerCase().includes(key)
        || (item.sub || '').toLowerCase().includes(key)))
      : corpus.filter((item) => item.group === 'Places' || item.group === 'Communities');

    if (query && !matched.length) {
      results.replaceChildren(blank({
        glyph: 'search',
        title: 'Nothing answers that',
        text: 'Try a community, a channel, or a person by name.',
      }));
      return;
    }

    const groups = ['Places', 'Communities', 'Channels', 'People'];
    const painted = [];
    for (const group of groups) {
      const rows = matched.filter((item) => item.group === group);
      if (!rows.length) continue;
      painted.push(card({
        label: group === 'Places' ? 'Destinations' : group,
        rows: rows.map((item) => row({
          link: true, href: path(item.route),
          lead: item.lead, title: item.label, sub: item.sub,
          side: icon('arrow-right', { size: 14 }),
          // An answer is a place: it can be opened, and its address taken.
          menu: () => [
            {
              label: 'Open', icon: 'external',
              onSelect: () => navigate(item.route),
            },
            {
              label: 'Copy the link', icon: 'link',
              onSelect: () => copyText(window.location.origin + path(item.route), 'Link copied.'),
            },
          ],
        })),
      }));
    }
    results.replaceChildren(...painted);
  }

  input.addEventListener('input', paint);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const first = results.querySelector('.cardrow--link');
    if (first) { event.preventDefault(); navigate(first.getAttribute('href')); }
  });

  async function load() {
    results.replaceChildren(hold('Mapping your instance'));
    try {
      await build();
      paint();
    } catch (error) {
      results.replaceChildren(fault(error, load));
    }
    input.focus();
  }

  return { node, onMount: load };
}

export default { renderMenu };
