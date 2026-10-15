// A person's profile, on a phone.
//
// What is public about an account, and the one or two things the viewer can do
// about it. Every label follows the relationship the server reported, so a
// control never claims to do one thing while holding state that means another.

import { el } from '../../../packages/dom.js';
import { avatar, loading, failure } from '../components.js';
import { State, normalizeUser, nameOf } from '../../../packages/store.js';
import { navigate } from '../../../packages/nav.js';
import { toast, confirm } from '../ui.js';
import { joinedLabel } from '../../../packages/format.js';
import { mediaUrl } from '../../../packages/media.js';
import Api from '../../../packages/api.js';
import { screen, section, notice, stat } from './util.js';

function presenceText(presence) {
  const value = presence || 'offline';
  if (value === 'online') return 'Online';
  return value.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function currentRoute() {
  const pathname = String(window.location.pathname || '/');
  return pathname.replace(/\/+$/, '') || '/';
}

export function renderProfile(ctx) {
  const id = ctx.params.id;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  async function load() {
    host.replaceChildren(loading('Loading profile'));
    try {
      const profile = await Api.user(id, ctx.serverId || undefined);
      host.replaceChildren(view(normalizeUser(profile), profile));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function view(user, profile) {
    const frag = document.createDocumentFragment();

    const banner = el('div', { class: 'm-profile-banner' });
    if (user.bannerUrl) mediaUrl(user.bannerUrl).then((src) => { if (src) banner.style.backgroundImage = 'url("' + src + '")'; }).catch(() => {});
    frag.appendChild(banner);

    frag.appendChild(el('div', { class: 'm-profile-id' },
      avatar(user, { size: 'xl', decorative: true }),
      el('div', {},
        el('h1', { class: 'm-profile-name' }, nameOf(user)),
        el('div', { class: 'm-profile-handle' }, '@' + user.username))));

    const actions = el('div', { class: 'm-actions m-actions--wrap' });
    paintActions(actions, user, profile);
    frag.appendChild(actions);

    frag.appendChild(el('div', { class: 'm-strip' },
      stat('@' + user.username, 'Username'),
      stat(presenceText(profile.presence), 'Presence'),
      stat(user.createdAt ? joinedLabel(user.createdAt) : 'Unknown', 'Joined')));

    if (user.statusText) frag.appendChild(notice({ text: user.statusText }));
    if (user.bio) frag.appendChild(section('About', el('p', { class: 'm-lede' }, user.bio)));

    const roles = (profile.roles || []).slice();
    if (roles.length) {
      const list = el('div', { class: 'm-list' });
      for (const role of roles) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, el('span', { class: 'm-role-dot', style: role.color ? { background: role.color } : null })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, role.name),
            (role.description || role.memberCount) ? el('span', { class: 'm-row__sub' }, role.description || (role.memberCount + ' members')) : null)));
      }
      frag.appendChild(section('Roles', list, { note: profile.serverName || null }));
    }

    return frag;
  }

  function paintActions(actions, user, profile) {
    const relation = profile.relation || 'none';
    if (relation === 'friend') {
      actions.append(
        el('button', { class: 'm-btn m-btn--primary', type: 'button', onClick: () => message(user) }, 'Message'),
        el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => removeFriend(user) }, 'Remove friend'));
    } else if (relation === 'pending-out') {
      actions.append(el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => cancelRequest() }, 'Cancel request'));
    } else if (relation === 'pending-in') {
      actions.append(
        el('button', { class: 'm-btn m-btn--primary', type: 'button', onClick: () => acceptRequest() }, 'Accept'),
        el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => declineRequest() }, 'Decline'));
    } else if (relation === 'self') {
      actions.appendChild(el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => navigate('/settings') }, 'Account settings'));
    } else {
      actions.appendChild(el('button', { class: 'm-btn m-btn--primary', type: 'button', onClick: () => addFriend(user) }, 'Add friend'));
    }
    if (State.user && State.user.id !== user.id) {
      actions.appendChild(el('button', {
        class: 'm-btn ' + (profile.blockedByViewer ? 'm-btn--ghost' : 'm-btn--danger'),
        type: 'button',
        onClick: () => (profile.blockedByViewer ? unblock(user) : block(user)),
      }, profile.blockedByViewer ? 'Unblock' : 'Block'));
    }
  }

  async function message(user) {
    try { const dm = await Api.createDm(user.id); navigate('/dms/' + dm.id); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function addFriend(user) {
    try { await Api.sendFriendRequest(user.id); toast('Request sent.', { type: 'success' }); navigate(currentRoute()); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function findRequest() {
    const page = await Api.friendRequests();
    const incoming = page.incoming || [];
    const outgoing = page.outgoing || [];
    return incoming[0] || outgoing[0] || null;
  }

  async function acceptRequest() {
    try { const r = await findRequest(); if (!r) return; await Api.acceptFriendRequest(r.id); toast('You are friends now.', { type: 'success' }); navigate(currentRoute()); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function declineRequest() {
    try { const r = await findRequest(); if (!r) return; await Api.declineFriendRequest(r.id); navigate(currentRoute()); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function cancelRequest() {
    try { const r = await findRequest(); if (!r) return; await Api.cancelFriendRequest(r.id); navigate(currentRoute()); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function removeFriend(user) {
    const sure = await confirm({ title: 'Remove ' + nameOf(user) + '?', text: 'You can add them again later.', confirmLabel: 'Remove', danger: true });
    if (!sure) return;
    try { await Api.removeFriend(user.id); toast('Removed.', { type: 'success' }); navigate(currentRoute()); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function block(user) {
    try { await Api.blockUser(user.id, ''); toast('Blocked.', { type: 'success' }); navigate(currentRoute()); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function unblock(user) {
    try { await Api.unblockUser(user.id); toast('Unblocked.', { type: 'success' }); navigate(currentRoute()); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  return { node, head: { lead: 'back', title: 'Profile' }, onMount: load };
}

export default { renderProfile };
