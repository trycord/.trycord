// A person's profile.
//
// What is public about an account, and the one or two things the viewer can do
// about it: start a conversation, send a request, or block. Every label follows
// the relationship the server reported, so a control never claims to do one
// thing while holding state that means another.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar, bannerNode } from '../ui/primitives.js';
import { State, normalizeUser, nameOf } from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import { toast, errorToast, confirmDialog } from '../ui/overlays.js';
import { joinedLabel } from '../../packages/format.js';
import Api from '../../packages/api.js';
import { page, panel, prow, strip, loading, failure } from './util.js';

export function renderProfile(ctx) {
  const id = ctx.params.id;
  const host = el('div', {});
  const node = page({ wide: true }, host);

  // The page says what it is before the data lands: while it loads, and if the
  // account cannot be read, there is still a heading on screen.
  function pendingHead() {
    return el('h1', { class: 'profile-title' }, 'Profile');
  }

  async function load() {
    host.replaceChildren(pendingHead(), loading('Loading profile'));
    try {
      const profile = await Api.user(id, ctx.serverId || undefined);
      host.replaceChildren(view(normalizeUser(profile), profile));
    } catch (error) {
      host.replaceChildren(pendingHead(), failure(error, load));
    }
  }

  function view(user, profile) {
    const actions = el('div', { class: 'band-actions' });
    paintActions(actions, user, profile);

    const roles = (profile.roles || []).slice();

    return el('div', { class: 'profile' },
      bannerNode(user.bannerUrl, 'profile-banner'),
      el('div', { class: 'profile-head' },
        avatar(user, { size: 'xl', presence: profile.presence }),
        el('div', { class: 'profile-id' },
          el('h1', { class: 'profile-title' }, nameOf(user)),
          el('div', { class: 'profile-handle' }, '@' + user.username))),
      el('div', { class: 'band' },
        el('div', { class: 'band-main' },
          el('div', { class: 'band-eyebrow' },
            icon('user', { size: 13 }), el('span', {}, 'Profile')),
          user.statusText
            ? el('p', { class: 'band-lede' }, user.statusText)
            : el('p', { class: 'band-lede' }, presenceText(profile.presence))),
        actions),
      strip([
        { label: 'Username', value: '@' + user.username },
        { label: 'Presence', value: presenceText(profile.presence) },
        { label: 'Joined', value: user.createdAt ? joinedLabel(user.createdAt) : 'Unknown' },
        profile.joinedAt
          ? { label: 'Here since', value: joinedLabel(profile.joinedAt) }
          : null,
      ]),
      user.bio
        ? panel({ title: 'About', body: el('p', { class: 'profile-bio' }, user.bio), tight: true })
        : null,
      roles.length
        ? panel({
          title: 'Roles',
          note: profile.serverName || null,
          rows: roles.map((role) => roleRow(role)),
        })
        : null,
    );
  }

  function paintActions(actions, user, profile) {
    actions.replaceChildren();
    const relation = profile.relation || 'none';

    if (relation === 'friend') {
      actions.append(
        el('button', { class: 'btn btn--primary', type: 'button', onClick: () => message(user) },
          icon('message', { size: 16 }), el('span', {}, 'Message')),
        el('button', { class: 'btn btn--default', type: 'button', onClick: () => removeFriend(user, profile) }, 'Remove friend'));
    } else if (relation === 'pending-out') {
      actions.append(el('button', { class: 'btn btn--default', type: 'button', onClick: () => cancelRequest(user) }, 'Cancel request'));
    } else if (relation === 'pending-in') {
      actions.append(
        el('button', { class: 'btn btn--primary', type: 'button', onClick: () => acceptRequest(user) }, 'Accept'),
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => declineRequest(user) }, 'Decline'));
    } else if (relation === 'self') {
      actions.appendChild(el('button', {
        class: 'btn btn--default', type: 'button', onClick: () => navigate('/settings'),
      }, 'Account settings'));
    } else {
      actions.appendChild(el('button', { class: 'btn btn--primary', type: 'button', onClick: () => addFriend(user) },
        icon('user-plus', { size: 16 }), el('span', {}, 'Add friend')));
    }

    if (State.user && State.user.id !== user.id) {
      const blocked = !!profile.blockedByViewer;
      actions.appendChild(el('button', {
        class: 'btn ' + (blocked ? 'btn--default' : 'btn--danger'),
        type: 'button',
        onClick: () => (blocked ? unblock(user) : block(user)),
      }, blocked ? 'Unblock' : 'Block'));
    }
  }

  return { node, onMount: load };
}

function presenceText(presence) {
  const value = presence || 'offline';
  if (value === 'online') return 'Online';
  return value.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function roleRow(role) {
  return prow({
    lead: el('span', {
      class: 'role-dot',
      style: role.color ? { background: role.color } : null,
    }),
    title: role.name,
    sub: role.description || (role.memberCount ? role.memberCount + ' members' : null),
  });
}

async function message(user) {
  try {
    const dm = await Api.createDm(user.id);
    navigate('/dms/' + dm.id);
  } catch (error) { errorToast(error); }
}

async function addFriend(user) {
  try {
    await Api.sendFriendRequest(user.id);
    toast('Request sent.', { type: 'success' });
    navigate(currentPath());
  } catch (error) { errorToast(error); }
}

function currentPath() {
  return window.location.pathname.replace(/^\//, '').replace(/^app\//, '');
}

// The request id is not on the profile, so it is read from the list the client
// already holds before acting; a request that cannot be found is reported
// rather than guessed at.
async function findRequest(user) {
  const page = await Api.friendRequests();
  const all = [].concat(page.incoming || page.incomingRequests || [], page.outgoing || page.outgoingRequests || []);
  return all.find((request) => String(request.userId || request.user_id || (request.user && request.user.id)) === String(user.id))
    || all.find((request) => request.user && String(request.user.id) === String(user.id))
    || null;
}

async function cancelRequest(user) {
  try {
    const request = await findRequest(user);
    if (!request) { toast('That request is already gone.', { type: 'info' }); return; }
    await Api.cancelFriendRequest(request.id);
    toast('Request cancelled.', { type: 'success' });
    navigate(currentPath());
  } catch (error) { errorToast(error); }
}

async function acceptRequest(user) {
  try {
    const request = await findRequest(user);
    if (!request) { toast('That request is already gone.', { type: 'info' }); return; }
    await Api.acceptFriendRequest(request.id);
    toast('You are friends now.', { type: 'success' });
    navigate(currentPath());
  } catch (error) { errorToast(error); }
}

async function declineRequest(user) {
  try {
    const request = await findRequest(user);
    if (!request) return;
    await Api.declineFriendRequest(request.id);
    navigate(currentPath());
  } catch (error) { errorToast(error); }
}

async function removeFriend(user) {
  const sure = await confirmDialog({ title: 'Remove ' + nameOf(user) + '?', body: 'You can add them again later.', confirmLabel: 'Remove', danger: true });
  if (!sure) return;
  try {
    await Api.removeFriend(user.id);
    toast('Removed.', { type: 'success' });
    navigate(currentPath());
  } catch (error) { errorToast(error); }
}

async function block(user) {
  try {
    await Api.blockUser(user.id, '');
    toast('Blocked.', { type: 'success' });
    navigate(currentPath());
  } catch (error) { errorToast(error); }
}

async function unblock(user) {
  try {
    await Api.unblockUser(user.id);
    toast('Unblocked.', { type: 'success' });
    navigate(currentPath());
  } catch (error) { errorToast(error); }
}

export default { renderProfile };
