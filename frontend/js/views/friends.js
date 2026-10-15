// Friends.
//
// Four readings of one relationship - friend, request in, request out, blocked -
// plus a way to start one. They belong on one page because they are the same
// question asked of a different set of rows.

import { el } from '../../packages/dom.js';
import { avatar, iconButton } from '../components.js';
import { State, nameOf, normalizeUser, refreshFriends } from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { openMenu, toast, errorToast, confirmDialog } from '../ui.js';
import Api from '../../packages/api.js';
import { page, band, panel, prow, loading, failure, empty } from './util.js';

const TABS = [
  ['all', 'All'],
  ['online', 'Online'],
  ['pending', 'Pending'],
  ['blocked', 'Blocked'],
  ['add', 'Add friend'],
];

export function renderFriends(ctx) {
  const tab = ctx.query.get('tab') || 'all';
  const host = el('div', { class: 'stack' });
  const node = page(
    band({
      eyebrow: 'Friends',
      icon: 'users',
      title: 'Friends',
      lede: LEDE[tab] || LEDE.all,
      actions: tabStrip(tab),
    }),
    host,
  );

  let blocked = [];

  function tabStrip(active) {
    const strip = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Friend lists' });
    for (const [id, label] of TABS) {
      strip.appendChild(el('button', {
        class: 'segmented-item', type: 'button', role: 'tab',
        'aria-selected': id === active ? 'true' : 'false',
        onClick: () => navigate('/friends?tab=' + id),
      }, label));
    }
    return strip;
  }

  async function load() {
    host.replaceChildren(loading('Loading your friends'));
    try {
      if (tab === 'blocked') {
        blocked = await Api.blocks();
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
    host.replaceChildren();
    if (tab === 'add') {
      host.appendChild(addPanel());
      return;
    }
    if (tab === 'pending') {
      paintPending();
      return;
    }
    let list = State.friends;
    if (tab === 'online') {
      list = list.filter((friend) => (State.presence.get(friend.id) || 'offline') !== 'offline');
    }
    if (!list.length) {
      host.appendChild(empty({
        icon: tab === 'online' ? 'clock' : 'users',
        title: tab === 'online' ? 'Nobody is around' : 'No friends yet',
        text: tab === 'online'
          ? 'Friends who come online will appear here.'
          : 'Add someone by their username and they will show up here.',
        action: tab === 'online'
          ? null
          : el('a', { class: 'btn btn--primary btn--sm', href: path('/friends?tab=add') }, 'Add a friend'),
      }));
      return;
    }
    host.appendChild(panel({
      title: tab === 'online' ? 'Online now' : 'Your friends',
      note: String(list.length),
      rows: list.map(friendRow),
    }));
  }

  function friendRow(friend) {
    const presence = State.presence.get(friend.id) || 'offline';
    return prow({
      lead: avatar(friend, { size: 'md', presence }),
      title: nameOf(friend),
      sub: friend.statusText || '@' + friend.username,
      actions: [
        iconButton('message', { label: 'Message ' + nameOf(friend), onClick: () => openConversation(friend) }),
        iconButton('more', { label: 'More for ' + nameOf(friend), onClick: (event) => friendMenu(event, friend) }),
      ],
    });
  }

  function paintPending() {
    const { incoming, outgoing } = State.friendRequests;
    if (!incoming.length && !outgoing.length) {
      host.appendChild(empty({
        icon: 'user-plus',
        title: 'No pending requests',
        text: 'Requests you send and requests you receive both wait here.',
      }));
      return;
    }
    if (incoming.length) {
      host.appendChild(panel({
        title: 'Waiting for you',
        note: String(incoming.length),
        rows: incoming.map((request) => prow({
          lead: avatar(request.user, { size: 'md' }),
          title: nameOf(request.user),
          sub: 'wants to be friends',
          actions: [
            el('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: () => accept(request) }, 'Accept'),
            el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => decline(request) }, 'Decline'),
          ],
        })),
      }));
    }
    if (outgoing.length) {
      host.appendChild(panel({
        title: 'Waiting on them',
        note: String(outgoing.length),
        rows: outgoing.map((request) => prow({
          lead: avatar(request.user, { size: 'md' }),
          title: nameOf(request.user),
          sub: 'Request sent',
          actions: el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => cancel(request),
          }, 'Cancel'),
        })),
      }));
    }
  }

  function paintBlocked() {
    host.replaceChildren();
    if (!blocked.length) {
      host.appendChild(empty({
        icon: 'ban',
        title: 'Nobody is blocked',
        text: 'People you block cannot message you, add you or see your activity.',
      }));
      return;
    }
    host.appendChild(panel({
      title: 'Blocked',
      note: String(blocked.length),
      rows: blocked.map((entry) => {
        const user = normalizeUser(entry.user || entry);
        return prow({
          lead: avatar(user, { size: 'md' }),
          title: nameOf(user),
          sub: 'Cannot reach you',
          actions: el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: async () => {
              try {
                await Api.unblockUser(user.id);
                blocked = blocked.filter((b) => (b.user || b).id !== user.id);
                paintBlocked();
                toast(nameOf(user) + ' can reach you again.', { type: 'success' });
              } catch (error) { errorToast(error); }
            },
          }, 'Unblock'),
        });
      }),
    }));
  }

  function addPanel() {
    const input = el('input', {
      class: 'input', type: 'text', placeholder: 'username', autocomplete: 'off',
      'aria-label': 'Username to add',
    });
    const note = el('p', { class: 'form-error', role: 'status' });
    const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Send request');
    const form = el('form', { class: 'search-row' }, input, submit);

    const card = panel({
      title: 'Add a friend',
      note: 'By username',
      body: [
        el('p', { class: 'prow-sub' }, 'Type the exact username of the person you want to add. They will get a request to accept.'),
        form,
        note,
      ],
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const term = input.value.trim();
      if (!term) {
        note.textContent = 'Enter a username first.';
        return;
      }
      submit.disabled = true;
      note.textContent = '';
      try {
        const user = await findUser(term);
        if (!user) {
          note.textContent = 'No one here has exactly that username.';
          return;
        }
        await Api.sendFriendRequest(user.id);
        await refreshFriends();
        toast('Request sent to ' + nameOf(user) + '.', { type: 'success' });
        input.value = '';
      } catch (error) {
        note.textContent = error.message || 'That request could not be sent.';
      } finally {
        submit.disabled = false;
      }
    });

    return card;
  }

  // Search returns anything close, so the request only goes to an exact
  // username - a near match is someone else's name.
  async function findUser(term) {
    const results = await Api.searchUsers(term);
    const list = Array.isArray(results) ? results : (results && results.items) || [];
    const wanted = term.toLowerCase();
    return list.find((user) => String(user.username || '').toLowerCase() === wanted) || null;
  }

  async function openConversation(friend) {
    try {
      const dm = await Api.createDm(friend.id);
      navigate('/dms/' + dm.id);
    } catch (error) {
      errorToast(error);
    }
  }

  function friendMenu(event, friend) {
    openMenu({
      anchor: event.currentTarget,
      align: 'right',
      items: [
        { label: 'Send a message', icon: 'message', onSelect: () => openConversation(friend) },
        { label: 'View profile', icon: 'user', onSelect: () => navigate('/users/' + friend.id) },
        { separator: true },
        { label: 'Remove friend', icon: 'trash', danger: true, onSelect: () => removeFriend(friend) },
      ],
    });
  }

  async function accept(request) {
    try {
      await Api.acceptFriendRequest(request.id);
      await refreshFriends();
      paint();
      toast(nameOf(request.user) + ' is now a friend.', { type: 'success' });
    } catch (error) { errorToast(error); }
  }

  async function decline(request) {
    try {
      await Api.declineFriendRequest(request.id);
      await refreshFriends();
      paint();
    } catch (error) { errorToast(error); }
  }

  async function cancel(request) {
    try {
      await Api.cancelFriendRequest(request.id);
      await refreshFriends();
      paint();
    } catch (error) { errorToast(error); }
  }

  async function removeFriend(friend) {
    const sure = await confirmDialog({
      title: 'Remove ' + nameOf(friend) + '?',
      body: 'They stay in your direct messages. You can add them again later.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!sure) return;
    try {
      await Api.removeFriend(friend.id);
      await refreshFriends();
      paint();
      toast('Removed.', { type: 'success' });
    } catch (error) { errorToast(error); }
  }

  return { node, onMount: load };
}

const LEDE = {
  all: 'Everyone you have added.',
  online: 'Friends who are around right now.',
  pending: 'Requests you have sent and requests waiting on you.',
  blocked: 'People who cannot reach you.',
  add: 'Send someone a request by their username.',
};

export default { renderFriends };
