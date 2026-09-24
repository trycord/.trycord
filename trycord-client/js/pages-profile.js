// Public profile page (#/users/:id). Renders a real user's profile from
// GET /api/users/:id plus the shell chrome — no mock data.

import Api from './api.js';
import State, { refreshFriends } from './state.js';
import { el, clear, toast } from './ui.js';
import { avatar, loadAuthedImage } from './components.js';
import { renderContextHeader } from './shell.js';
import { fullTime } from './ui.js';

export async function renderProfile(container, { id } = {}) {
  clear(container);
  renderContextHeader({ title: 'Profile', sub: 'View a member profile' });
  const wrap = el('div', { class: 'page atrium' });

  let profile;
  try {
    profile = await Api.user(id);
  } catch (ex) {
    wrap.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load this profile'));
    container.appendChild(wrap);
    return;
  }
  if (!profile) {
    wrap.appendChild(el('div', { class: 'form-error' }, 'This profile does not exist'));
    container.appendChild(wrap);
    return;
  }

  const banner = el('div', { class: 'prof-banner', style: { height: '160px' } });
  if (profile.bannerUrl) {
    banner.classList.add('has-banner');
    loadAuthedImage(profile.bannerUrl).then((url) => {
      if (url) {
        banner.style.backgroundImage = 'url("' + url + '")';
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    });
  }

  const name = (profile.displayName || profile.username) || '?';
  const avatarBox = avatar({ id: profile.id, avatarUrl: profile.avatarUrl, username: profile.username, displayName: name }, { size: 'lg', withPresence: true });

  const card = el('div', { class: 'auth-box' }, banner, el('div', { class: 'prof-avatar' }, avatarBox),
    el('div', { class: 'prof-preview-body' },
      el('strong', { class: 'prof-name' }, name),
      el('div', { class: 'muted small' }, '@' + profile.username),
      el('div', { class: 'prof-presence' }, profile.presence === 'online' ? '● online' : 'offline'),
      profile.statusText ? el('div', { class: 'prof-status' }, profile.statusText) : null,
      profile.bio ? el('div', { class: 'prof-bio' }, profile.bio) : el('div', { class: 'muted small' }, 'No bio yet.'),
      el('div', { class: 'muted small', style: { marginTop: 'var(--t-d-2)' } }, 'Member since ' + fullTime(profile.createdAt))));

  // ---- actions -----------------------------------------------------------
  const isSelf = profile.relation === 'self';
  if (!isSelf && State.me) {
    const actions = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)' } });
    const dm = el('button', { class: 'btn primary', type: 'button' }, 'Message');
    dm.addEventListener('click', async () => {
      try {
        const conv = await Api.openDm(profile.id);
        toast('Opening conversation.', 'ok');
        if (conv && conv.conversationId) location.hash = '#/dms/' + conv.conversationId;
        else location.hash = '#/dms';
        return;
      } catch (ex) { toast(ex.message || 'Could not open a DM', 'error'); }
    });
    actions.appendChild(dm);

    let friendBtn = null;
    if (profile.relation === 'friend') {
      friendBtn = el('button', { class: 'btn', type: 'button' }, 'Remove friend');
      friendBtn.addEventListener('click', async () => {
        try { await Api.removeFriend(profile.id); toast('Friend removed.', 'warn'); }
        catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
    } else if (profile.relation === 'pending-out') {
      friendBtn = el('button', { class: 'btn', type: 'button', disabled: true }, 'Request pending');
    } else if (profile.relation === 'pending-in') {
      friendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Accept request');
      friendBtn.addEventListener('click', async () => {
        try {
          await refreshFriends();
          const req = (State.friendsIn || []).find((r) => r.from && String(r.from.id) === String(profile.id));
          if (!req) { toast('That request is already gone.', 'error'); return; }
          await Api.acceptFriendRequest(req.id);
          toast('Request accepted.', 'ok');
        } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
    } else {
      friendBtn = el('button', { class: 'btn', type: 'button' }, 'Add friend');
      friendBtn.addEventListener('click', async () => {
        try {
          const res = await Api.sendFriendRequest(profile.id);
          toast(res.autoAccepted ? 'Friend added!' : 'Request sent.', 'ok');
        } catch (ex) { toast(ex.message || 'Could not send request', 'error'); }
      });
    }
    if (friendBtn) actions.appendChild(friendBtn);
    card.appendChild(actions);
  }

  wrap.appendChild(card);
  container.appendChild(wrap);
}

export default { renderProfile };