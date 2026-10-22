// The communities hub.
//
// The wide phone carries the communities as a rail beside the conversation;
// the narrow one carries them as a destination of the bottom bar. This is
// that destination: the same list the rail draws, presented as rows with
// room for a name, framed by the two actions that matter here - starting a
// community, and finding the public ones - and by the finder for everything
// that is not a community.
//
// The list is the store's, the same one the rail and the menu read, so this
// screen cannot disagree with the rest of the phone about which communities
// there are. Unread state is deliberately absent: the store does not carry a
// per-community count, and an invented one would be a lie with a badge.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { path } from '../../../packages/nav.js';
import { State } from '../../../packages/store.js';
import { screen, section } from './util.js';
import { serverMark } from '../components.js';

export function renderCommunities() {
  const places = el('div', { class: 'm-stack' });
  for (const server of State.servers || []) {
    places.appendChild(el('a', { class: 'm-row', href: path('/server/' + server.id) },
      el('span', { class: 'm-row__lead' }, serverMark(server, { size: 'md' })),
      el('span', { class: 'm-row__title truncate' }, server.name),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
  }
  if (!places.children.length) {
    places.appendChild(el('p', { class: 'm-lede' },
      'Nothing here yet. Make a community of your own, or find one in Discover.'));
  }

  const node = screen(
    el('div', { class: 'm-hero' },
      el('div', { class: 'm-hero__eyebrow' }, 'Communities'),
      el('h1', { class: 'm-hero__title' }, 'Your communities'),
      el('div', { class: 'm-actions' },
        el('a', { class: 'm-btn m-btn--primary', href: path('/servers/new') }, icon('plus', { size: 17 }), 'New community'),
        el('a', { class: 'm-btn m-btn--ghost', href: path('/discover') }, icon('compass', { size: 17 }), 'Discover'))),
    section('Places you are in', places),
    section('Everything else', el('a', { class: 'm-row', href: path('/menu') },
      el('span', { class: 'm-row__lead' }, icon('menu', { size: 20 })),
      el('span', { class: 'm-row__title' }, 'The finder'),
      el('span', { class: 'm-row__sub' }, 'Search every place, person and page'))),
  );
  return { node, head: { title: 'Communities' } };
}

export default { renderCommunities };
