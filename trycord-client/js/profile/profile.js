
import Api from '../api.js';
import State, { refreshFriends, refreshBlocks, currentServerId } from '../state.js';
import { el, clear, toast } from '../ui.js';
import { avatar, loadAuthedImage } from '../components.js';
import { renderContextHeader } from '../shell.js';
import { fullTime } from '../ui.js';
import { navigate } from '../nav.js';
import { profileViewContext } from '../context-column.js';

export async function renderProfile(container, { id } = {}) {
  clear(container);
  renderContextHeader({ title: 'Profile', sub: 'View a member profile' });
  const frame = el('div', { class: 'profile-layout' });
  const wrap = el('div', { class: 'page' }, frame);
  // The primary column holds the profile itself. It is capped so the header does
  // not stretch a name across a 3440px window, and the space to its right is a
  // real column with real content rather than empty canvas.
  const primary = el('div', { class: 'profile-primary' });
  const aside = el('aside', { class: 'profile-context', 'aria-label': 'Profile details' });
  frame.append(primary, aside);

  let profile;
  try {
    // attaches membership both viewer and target share — nothing else leaks.
    profile = await Api.user(id, currentServerId());
  } catch (ex) {
    primary.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load this profile'));
    container.appendChild(wrap);
    return;
  }
  if (!profile) {
    primary.appendChild(el('div', { class: 'form-error' }, 'This profile does not exist'));
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

  const nameLine = el('div', { class: 'member-name-line' },
    el('strong', { class: 'prof-name' }, name),
    profile.isBot ? el('span', { class: 'bot-tag' }, 'BOT') : null);
  const card = el('div', { class: 'card card--profile' }, banner, el('div', { class: 'prof-avatar' }, avatarBox),
    el('div', { class: 'prof-preview-body' },
      nameLine,
      el('div', { class: 'muted small' }, '@' + profile.username),
      el('div', { class: 'prof-presence' }, profile.presence === 'online' ? '● online' : 'offline'),
      profile.statusText ? el('div', { class: 'prof-status' }, profile.statusText) : null,
      profile.bio ? el('div', { class: 'prof-bio' }, profile.bio) : el('div', { class: 'muted small' }, 'No bio yet.'),
      el('div', { class: 'muted small', style: { marginTop: 'var(--t-d-2)' } }, 'Member since ' + fullTime(profile.createdAt))));
  if (profile.membership) {
    const mbox = el('div', { class: 'prof-community' });
    mbox.appendChild(el('div', { class: 'section-label' }, 'In this community'));
    if (profile.membership.nickname) {
      mbox.appendChild(el('div', {}, el('strong', {}, profile.membership.nickname), el('span', { class: 'muted small' }, ' (nickname)')));
    }
    if (profile.membership.joinedAt) {
      mbox.appendChild(el('div', { class: 'muted small' }, 'Joined ' + fullTime(profile.membership.joinedAt)));
    }
    const pills = el('div', { class: 'role-pills' });
    for (const r of profile.membership.roles || []) {
      const pill = el('span', { class: 'role-pill' }, r.name || 'Role');
      if (r.color) { pill.style.color = r.color; pill.style.borderColor = r.color; }
      pills.appendChild(pill);
    }
    if (!(profile.membership.roles || []).length) pills.appendChild(el('span', { class: 'role-pill muted-role' }, 'Member'));
    mbox.appendChild(pills);
    card.appendChild(mbox);
  }

  const isSelf = profile.relation === 'self';
  if (!isSelf && State.me) {
    // Message is absent while blocked and Add friend is never offered then: the
    // server refuses both with BLOCKED, so a control that can only produce an
    // error is not a control. The row is rebuilt from `blocked` rather than
    // toggled one button at a time, because blocking changes what else is
    // possible - flipping only the label left Message and Add friend sitting
    // there over a person the server now refuses both from.
    let blocked = !!profile.blockedByViewer;

    function messageButton() {
      const dm = el('button', { class: 'btn primary', type: 'button' }, 'Message');
      dm.addEventListener('click', async () => {
        try {
          const conv = await Api.openDm(profile.id);
          if (conv && conv.conversationId) navigate('/dms/' + conv.conversationId);
          else navigate('/dms');
        } catch (ex) { toast(ex.message || 'Could not open a DM', 'error'); }
      });
      return dm;
    }

    function friendButton() {
      if (profile.relation === 'friend') {
        const b = el('button', { class: 'btn', type: 'button' }, 'Remove friend');
        b.addEventListener('click', async () => {
          try { await Api.removeFriend(profile.id); toast('Friend removed.', 'warn'); }
          catch (ex) { toast(ex.message || 'Could not remove that friend.', 'error'); }
        });
        return b;
      }
      if (profile.relation === 'pending-out') {
        return el('button', { class: 'btn', type: 'button', disabled: true }, 'Request pending');
      }
      if (profile.relation === 'pending-in') {
        const b = el('button', { class: 'btn primary', type: 'button' }, 'Accept request');
        b.addEventListener('click', async () => {
          try {
            await refreshFriends();
            const req = (State.friendsIn || []).find((r) => r.from && String(r.from.id) === String(profile.id));
            if (!req) { toast('That request is already gone.', 'error'); return; }
            await Api.acceptFriendRequest(req.id);
            toast('Request accepted.', 'ok');
          } catch (ex) { toast(ex.message || 'Could not accept that request.', 'error'); }
        });
        return b;
      }
      if (blocked) return null;
      const b = el('button', { class: 'btn', type: 'button' }, 'Add friend');
      b.addEventListener('click', async () => {
        try {
          const res = await Api.sendFriendRequest(profile.id);
          toast(res.autoAccepted ? 'Friend added!' : 'Request sent.', 'ok');
        } catch (ex) { toast(ex.message || 'Could not send request', 'error'); }
      });
      return b;
    }

    const actions = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)' } });
    const blockBtn = el('button', { class: 'btn ghost', type: 'button' }, blocked ? 'Unblock' : 'Block');
    blockBtn.addEventListener('click', async () => {
      blockBtn.disabled = true;
      try {
        if (blocked) {
          await Api.unblockUser(profile.id);
          blocked = false;
          toast(name + ' can reach you again.', 'ok');
        } else {
          await Api.blockUser(profile.id);
          blocked = true;
          toast(name + ' can no longer reach you.', 'ok');
        }
        await refreshBlocks();
        paintActions();
      } catch (ex) {
        toast(ex.message || 'Could not change who can reach you.', 'error');
      } finally {
        blockBtn.disabled = false;
      }
    });

    function paintActions() {
      clear(actions);
      if (!blocked) actions.appendChild(messageButton());
      const friend = friendButton();
      if (friend) actions.appendChild(friend);
      blockBtn.textContent = blocked ? 'Unblock' : 'Block';
      actions.appendChild(blockBtn);
      if (blocked) {
        // A blocked person still has a profile page. Saying why the other
        // controls are gone is better than leaving someone to discover it by
        // pressing a button that can only fail.
        actions.appendChild(el('span', { class: 'muted small' },
          'They cannot message you or send you a friend request.'));
      }
    }
    paintActions();
    card.appendChild(actions);
  }

  primary.appendChild(card);
  wrap.appendChild(frame);
  container.appendChild(wrap);

  // The contextual column is painted after the frame is in the document so its
  // presence can widen the layout, and it reads the same profile object the card
  // did rather than fetching again: two reads of one profile is two chances to
  // show a reader two different people.
  const nodes = profileViewContext(profile, { membership: profile.membership, isSelf });
  if (nodes.length) {
    for (const n of nodes) aside.appendChild(n);
    frame.dataset.hasContext = 'yes';
  }
}

export default { renderProfile };
