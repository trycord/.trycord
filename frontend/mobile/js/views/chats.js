// Chats: the people you talk to.
//
// The friend strip on top — requests first, then the people themselves — and
// the conversations under it, newest words first. One press opens the
// conversation; a long-press on a friend offers the things friends get.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import {
  State, nameOf, normalizeUser, refreshDms, refreshFriends, signedIn,
} from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { avatar } from '../../../js/ui/primitives.js';
import { confirm, attachLongPress, failed, emptyState, hold, failure, section } from '../ui.js';
import { lastWordsOf, timeAgo } from './time.js';

export function renderChats(ctx) {
  const host = el('div', { class: 'm-stack' });

  let version = 0;
  async function load() {
    const mine = ++version;
    await Promise.allSettled([refreshDms(), refreshFriends()]);
    if (mine !== version) return;
    paint();
  }

  function openPerson(raw) {
    // A press on a face opens the person's profile page - the page, not a
    // sheet, so every reader has one address that is always theirs.
    navigate(path('/users/' + raw.id));
  }

  function friendRow(person) {
    const friend = normalizeUser(person);
    const row = el('a', { class: 'm-row', href: path('/users/' + friend.id) },
      avatar(friend, { size: 'md' }),
      el('div', { class: 'm-row__body' },
        el('div', { class: 'm-row__name' }, nameOf(friend)),
        el('div', { class: 'm-row__note' }, '@' + (friend.username || ''))),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 })));
    attachLongPress(row, () => personActions(friend));
    return row;
  }

  function personActions(friend) {
    return [
      { label: 'Send a message', icon: 'message', onClick: async () => {
        try { const dm = await Api.createDm(friend.id); await refreshDms(); navigate(path('/dms/' + dm.id)); }
        catch (e) { failed(e); }
      } },
      { label: 'View profile', icon: 'users', onClick: () => navigate(path('/users/' + friend.id)) },
      { label: 'Remove friend', icon: 'user-minus', danger: true, onClick: async () => {
        if (!(await confirm({ title: 'Remove ' + nameOf(friend) + '?', confirmLabel: 'Remove', danger: true }))) return;
        try { await Api.removeFriend(friend.id); await refreshFriends(); paint(); }
        catch (e) { failed(e); }
      } },
    ];
  }

  function dmRow(dm) {
    const others = (dm.people || dm.members || []).filter((p) => !State.user || String(p.id) !== String(State.user.id));
    const who = dm.isGroup || dm.is_group
      ? (dm.name || (others.length ? others.map(nameOf).join(', ') : 'A group'))
      : nameOf(normalizeUser(others[0] || {}));
    const face = dm.isGroup || dm.is_group
      ? avatar({ id: dm.id, displayName: who }, { size: 'md', rounded: true })
      : avatar(normalizeUser(others[0] || {}), { size: 'md' });
    const unread = Number(dm.unread || 0);
    const row = el('a', {
      class: 'm-row' + (unread ? ' m-row--unread' : ''), href: path('/dms/' + dm.id),
    },
      face,
      el('div', { class: 'm-row__body' },
        el('div', { class: 'm-row__name' }, who),
        el('div', { class: 'm-row__note' }, lastWordsOf(dm))),
      el('div', { class: 'm-row__meta' },
        dm.lastMessageAt || dm.last_message_at
          ? el('span', { class: 'm-row__time' }, timeAgo(dm.lastMessageAt || dm.last_message_at))
          : null,
        unread ? el('span', { class: 'm-row__pip' }, unread > 9 ? '9+' : String(unread)) : null));
    return row;
  }

  function requestsStrip() {
    const requests = State.friendRequests || State.friend_requests || [];
    if (!requests.length) return null;
    return section('Requests', el('div', { class: 'm-card' },
      requests.map((request) => el('div', { class: 'm-row' },
        avatar(normalizeUser(request.from || request.user || {}), { size: 'sm' }),
        el('div', { class: 'm-row__body' },
          el('div', { class: 'm-row__name' }, nameOf(normalizeUser(request.from || request.user || {}))),
          el('div', { class: 'm-row__note' }, 'wants to be friends')),
        el('button', { class: 'm-send__attach', type: 'button', 'aria-label': 'Accept', onClick: () => answer(request, true) }, icon('check', { size: 18 })),
        el('button', { class: 'm-send__attach', type: 'button', 'aria-label': 'Decline', onClick: () => answer(request, false) }, icon('x', { size: 18 }))))));
  }

  async function answer(request, accept) {
    try {
      if (accept) await Api.acceptFriendRequest(request.id);
      else await Api.cancelFriendRequest(request.id);
      await refreshFriends();
      paint();
    } catch (e) { failed(e); }
  }

  function paint() {
    clear(host);
    const friends = (State.friends || []).slice(0, 12);
    const dms = (State.dms || []).slice();

    if (friends.length) {
      host.appendChild(section('Friends', el('div', { class: 'm-card' }, friends.map(friendRow))));
    }
    const requests = requestsStrip();
    if (requests) host.appendChild(requests);

    if (dms.length) {
      host.appendChild(section('Conversations', el('div', { class: 'm-card' }, dms.map(dmRow))));
    } else if (!friends.length) {
      host.appendChild(emptyState('message', 'No chats yet',
        'Add a friend and a conversation opens here. Their first word arrives in this list.'));
    }
  }

  host.appendChild(hold());
  load().catch((e) => { clear(host); host.appendChild(failure(e, load)); });

  return {
    node: host,
    head: { title: 'Chats', actions: [el('a', { class: 'm-bar__btn', href: path('/friends'), 'aria-label': 'Find friends' }, icon('user-plus', { size: 21 }))] },
    door: '/dms',
    onMount: load,
    cleanup() { version += 1; },
  };
}

