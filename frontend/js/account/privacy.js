// privacy — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import Api from '../api.js';
import State, { refreshFriends } from '../state.js';
import { el, toast, confirmDialog, clearAndRebuild } from '../ui.js';
import { sectionCard, settingRow, setEmpty, dangerButton } from '../settings-ui.js';
import { navigate } from '../nav.js';

export function renderPrivacySocial(body) {
  const card = sectionCard();
  const incoming = State.friendsIn || [];
  const friends = State.friends || [];

  // 'None waiting' is an answer, and after a failed fetch it is one nobody made.
  const reqRow = settingRow({
    label: 'Friend requests',
    hint: incoming.length ? incoming.length + ' waiting for a reply'
      : State.friendsLoaded ? 'None waiting'
      : 'Could not be loaded',
    control: incoming.length
      ? el('button', {
        class: 'btn sm', type: 'button',
        onClick: () => { navigate('/friends'); },
      }, 'Review')
      : State.friendsLoaded
        ? el('span', { class: 'muted small' }, 'None')
        : el('span', { class: 'muted small' }, 'Unknown'),
  });
  card.appendChild(reqRow);

  if (incoming.length) {
    const pending = sectionCard();
    pending.appendChild(el('div', { class: 'set-card__label' }, 'Waiting on you'));
    for (const r of incoming.slice(0, 8)) {
      const who = (r.from && (r.from.displayName || r.from.username)) || 'Someone';
      const accept = dangerButton('Accept', async () => {
        accept.disabled = true;
        try { await Api.acceptFriendRequest(r.id); toast('Request accepted.', 'ok'); await refreshFriends(); renderPrivacySocial(clearAndRebuild(body)); }
        catch (e) { accept.disabled = false; toast(e.message || 'Could not accept that.', 'error'); }
      }, { variant: 'primary' });
      const decline = dangerButton('Decline', async () => {
        decline.disabled = true;
        try { await Api.declineFriendRequest(r.id); toast('Request declined.', 'warn'); await refreshFriends(); renderPrivacySocial(clearAndRebuild(body)); }
        catch (e) { decline.disabled = false; toast(e.message || 'Could not decline that.', 'error'); }
      }, { variant: 'ghost' });
      card.appendChild(settingRow({
        label: who,
        hint: r.from ? '@' + r.from.username : '',
        control: [accept, decline],
      }));
    }
    card.appendChild(pending);
  }

  if (friends.length) {
    const fr = sectionCard();
    fr.appendChild(el('div', { class: 'set-card__label' }, 'Friends (' + friends.length + ')'));
    for (const f of friends.slice(0, 25)) {
      const who = f.displayName || f.username || 'Someone';
      fr.appendChild(settingRow({
        label: who,
        hint: '@' + (f.username || ''),
        control: dangerButton('Remove', async () => {
          confirmDialog({
            title: 'Remove ' + who + '?',
            message: 'They stay on this instance and can send you another request.',
            danger: true, confirmText: 'Remove',
            onConfirm: async () => {
              try { await Api.removeFriend(f.id); toast('Friend removed.', 'warn'); await refreshFriends(); renderPrivacySocial(clearAndRebuild(body)); }
              catch (e) { toast(e.message || 'Could not remove that friend.', 'error'); }
            },
          });
        }, { variant: 'ghost' }),
      }));
    }
    card.appendChild(fr);
  }

  if (!incoming.length && !friends.length) {
    card.appendChild(State.friendsLoaded
      ? setEmpty('No requests and no friends yet. People you talk to appear here.')
      : setEmpty('Your friends could not be loaded. This is not the same as having none.'));
  }

  body.appendChild(card);
}

export default { renderPrivacySocial };
