// The You hub.
//
// The third place of the phone's bar: everything that belongs to the reader
// rather than to a conversation or a community. It is a map of doors, each
// one a real screen with its own life - the profile, the friends, the
// alerts, and the settings. Counts shown here are the store's own counts
// (incoming friend requests, unread alerts); nothing is invented for the
// hub's sake.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { path } from '../../../packages/nav.js';
import { State, nameOf } from '../../../packages/store.js';
import { avatar } from '../components.js';
import { screen, section } from './util.js';

export function renderYou() {
  const user = State.user || {};

  const friendsCount = (State.friendRequests.incoming || []).length;
  const alertsCount = State.notifications.unreadCount || 0;

  const node = screen(
    section('You', el('a', { class: 'm-row', href: path('/profile') },
      el('span', { class: 'm-row__lead' }, avatar(user, { size: 'lg', decorative: true })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, nameOf(user) || 'Your profile'),
        el('span', { class: 'm-row__sub truncate' }, user.username ? '@' + user.username : '')),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 })))),
    section('The reader', el('div', { class: 'm-stack' },
      el('a', { class: 'm-row', href: path('/friends') },
        el('span', { class: 'm-row__lead' }, icon('users', { size: 20 })),
        el('span', { class: 'm-row__title' }, 'Friends'),
        el('span', { class: 'm-row__side' }, friendsCount ? el('span', { class: 'm-chip' }, String(friendsCount)) : null),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))),
      el('a', { class: 'm-row', href: path('/notifications') },
        el('span', { class: 'm-row__lead' }, icon('bell', { size: 20 })),
        el('span', { class: 'm-row__title' }, 'Alerts'),
        el('span', { class: 'm-row__side' }, alertsCount ? el('span', { class: 'm-chip' }, String(alertsCount)) : null),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))),
      el('a', { class: 'm-row', href: path('/home') },
        el('span', { class: 'm-row__lead' }, icon('home', { size: 20 })),
        el('span', { class: 'm-row__title' }, 'Home'),
        el('span', { class: 'm-row__sub' }, 'The places and the news'),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))))),
    section('The phone', el('div', { class: 'm-stack' },
      el('a', { class: 'm-row', href: path('/settings') },
        el('span', { class: 'm-row__lead' }, icon('settings', { size: 20 })),
        el('span', { class: 'm-row__title' }, 'Settings'),
        el('span', { class: 'm-row__sub' }, 'Account, appearance and the rest'),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))))),
  );
  return { node, head: { title: 'You' } };
}

export default { renderYou };
