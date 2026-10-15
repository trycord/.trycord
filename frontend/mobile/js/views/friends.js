// Friends, on a phone.
//
// Four readings of one relationship - friend, request in, request out, blocked -
// plus a way to start one. The list is chosen by a query parameter so a tab is a
// URL, which means Back returns to the tab you left.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar, empty, loading, failure } from '../components.js';
import { State, nameOf, normalizeUser, refreshFriends } from '../../../packages/store.js';
import { path, navigate } from '../../../packages/nav.js';
import { menu, confirm, toast } from '../ui.js';
import Api from '../../../packages/api.js';
import { screen, section, notice } from './util.js';

const TABS = [
  ['all', 'All'],
  ['online', 'Online'],
  ['pending', 'Pending'],
  ['blocked', 'Blocked'],
  ['add', 'Add'],
];

const LEDE = {
  all: 'Everyone you have added.',
  online: 'Friends who are around right now.',
  pending: 'Requests you have sent and requests waiting on you.',
  blocked: 'People who cannot reach you.',
  add: 'Send someone a request by their username.',
};

export function renderFriends(ctx) {
  const tab = ctx.query.get('tab') || 'all';
  const host = el('div', { class: 'm-stack' });
  let blocked = [];

  const strip = el('div', { class: 'm-seg', role: 'tablist', 'aria-label': 'Friend lists' });
  for (const [id, label] of TABS) {
    strip.appendChild(el('a', {
      class: 'm-seg__item' + (id === tab ? ' is-active' : ''),
      role: 'tab', href: path('/friends?tab=' + id),
      'aria-selected': id === tab ? 'true' : 'false',
    }, label));
  }

  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Friends'),
      el('div', { class: 'm-hero__sub' }, LEDE[tab] || LEDE.all)),
    strip,
    host,
  );

  async function load() {
    host.replaceChildren(loading('Loading friends'));
    try {
      if (tab === 'blocked') {
        const page = await Api.blocks();
        blocked = Array.isArray(page) ? page : (page && page.items) || [];
        paintBlocked();
        return;
      }
      await refreshFriends();
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint() {
    if (tab === 'add') { host.replaceChildren(addPanel()); return; }
    if (tab === 'pending') { paintPending(); return; }
    const list = tab === 'online'
      ? State.friends.filter((friend) => (State.presence.get(friend.id) || 'offline') !== 'offline')
      : State.friends.slice();
    host.replaceChildren();
    if (!list.length) {
      host.appendChild(empty({
        icon: tab === 'online' ? 'clock' : 'users',
        title: tab === 'online' ? 'Nobody is around' : 'No friends yet',
        text: tab === 'online' ? 'Friends who come online will appear here.' : 'Add someone by their username.',
        action: tab === 'online' ? null : el('a', { class: 'm-btn m-btn--primary', href: path('/friends?tab=add') }, 'Add a friend'),
      }));
      return;
    }
    const rows = el('div', { class: 'm-list' });
    for (const friend of list) rows.appendChild(friendRow(friend));
    host.appendChild(section(tab === 'online' ? 'Online now' : 'Your friends', rows, { note: String(list.length) }));
  }

  function friendRow(friend) {
    const presence = State.presence.get(friend.id) || 'offline';
    return el('button', { class: 'm-row', type: 'button', onClick: () => openFriend(friend) },
      el('span', { class: 'm-row__lead' }, avatar(friend, { size: 'md', presence: true, decorative: true })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, nameOf(friend)),
        el('span', { class: 'm-row__sub truncate' }, friend.statusText || '@' + friend.username)),
      el('span', { class: 'm-row__chevron' }, icon('more', { size: 18 })));
  }

  function openFriend(friend) {
    menu({
      title: nameOf(friend),
      items: [
        { label: 'Send a message', icon: 'message', onSelect: () => openConversation(friend) },
        { label: 'View profile', icon: 'user', onSelect: () => navigate('/users/' + friend.id) },
        { separator: true },
        { label: 'Remove friend', icon: 'trash', danger: true, onSelect: () => removeFriend(friend) },
      ],
    });
  }

  function paintPending() {
    const { incoming, outgoing } = State.friendRequests;
    host.replaceChildren();
    if (!incoming.length && !outgoing.length) {
      host.appendChild(empty({ icon: 'user-plus', title: 'No pending requests', text: 'Requests you send and receive wait here.' }));
      return;
    }
    if (incoming.length) {
      const rows = el('div', { class: 'm-list' });
      for (const request of incoming) {
        rows.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, avatar(request.user, { size: 'md', decorative: true })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, nameOf(request.user)),
            el('span', { class: 'm-row__sub' }, 'wants to be friends')),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--primary', type: 'button', onClick: () => accept(request) }, 'Accept'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => decline(request) }, 'Decline'))));
      }
      host.appendChild(section('Waiting for you', rows, { note: String(incoming.length) }));
    }
    if (outgoing.length) {
      const rows = el('div', { class: 'm-list' });
      for (const request of outgoing) {
        rows.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, avatar(request.user, { size: 'md', decorative: true })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, nameOf(request.user)),
            el('span', { class: 'm-row__sub' }, 'Request sent')),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => cancel(request) }, 'Cancel'))));
      }
      host.appendChild(section('Waiting on them', rows, { note: String(outgoing.length) }));
    }
  }

  function paintBlocked() {
    host.replaceChildren();
    if (!blocked.length) {
      host.appendChild(empty({ icon: 'ban', title: 'Nobody is blocked', text: 'People you block cannot message you, add you or see your activity.' }));
      return;
    }
    const rows = el('div', { class: 'm-list' });
    for (const entry of blocked) {
      const user = normalizeUser(entry.user || entry);
      rows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, avatar(user, { size: 'md', decorative: true })),
        el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title truncate' }, nameOf(user))),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            onClick: async () => {
              try {
                await Api.unblockUser(user.id);
                blocked = blocked.filter((b) => (b.user || b).id !== user.id);
                paintBlocked();
                toast(nameOf(user) + ' can reach you again.', { type: 'success' });
              } catch (error) { toast(error.message, { type: 'danger' }); }
            },
          }, 'Unblock'))));
    }
    host.appendChild(section('Blocked', rows, { note: String(blocked.length) }));
  }

  function addPanel() {
    const input = el('input', { class: 'm-input', type: 'text', placeholder: 'username', autocomplete: 'off', 'aria-label': 'Username to add' });
    const note = el('p', { class: 'm-lede' });
    const submit = el('button', { class: 'm-btn m-btn--primary', type: 'submit' }, 'Send request');
    const form = el('form', { class: 'm-inline-form' }, input, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const term = input.value.trim();
      if (!term) { note.textContent = 'Enter a username.'; return; }
      submit.disabled = true;
      note.textContent = '';
      try {
        const results = await Api.searchUsers(term);
        const list = Array.isArray(results) ? results : (results && results.items) || [];
        const wanted = term.toLowerCase();
        const user = list.find((u) => String(u.username || '').toLowerCase() === wanted) || null;
        if (!user) { note.textContent = 'No account has that exact username.'; return; }
        await Api.sendFriendRequest(user.id);
        await refreshFriends();
        toast('Request sent to ' + nameOf(user) + '.', { type: 'success' });
        navigate('/friends?tab=pending');
      } catch (error) { note.textContent = error.message || 'That request could not be sent.'; }
      finally { submit.disabled = false; }
    });
    return el('div', { class: 'm-stack' },
      notice({ title: 'Add a friend', text: 'Send someone a request by their exact username.' }), form, note);
  }

  async function accept(request) {
    try {
      await Api.acceptFriendRequest(request.id);
      await refreshFriends();
      paint();
      toast(nameOf(request.user) + ' is now a friend.', { type: 'success' });
    } catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function decline(request) {
    try { await Api.declineFriendRequest(request.id); await refreshFriends(); paint(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function cancel(request) {
    try { await Api.cancelFriendRequest(request.id); await refreshFriends(); paint(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function removeFriend(friend) {
    const sure = await confirm({ title: 'Remove ' + nameOf(friend) + '?', text: 'They stay in your direct messages.', confirmLabel: 'Remove', danger: true });
    if (!sure) return;
    try {
      await Api.removeFriend(friend.id);
      await refreshFriends();
      paint();
      toast('Removed.', { type: 'success' });
    } catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function openConversation(friend) {
    try { const dm = await Api.createDm(friend.id); navigate('/dms/' + dm.id); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  return { node, head: { title: 'Friends' }, onMount: load };
}

export default { renderFriends };
