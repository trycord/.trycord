// The friends page: requests in both directions, the list, and the search that
// finds someone to add.
//
// Split out of the 655-line module for the same reason as dm-thread.js.

import Api from '../api.js';
import { errorState, loadingState } from '../view-states.js';
import State, { refreshFriends } from '../state.js';
import { attachContextMenu, copyText, el, clear, toast, relTime } from '../ui.js';
import { avatar, emptyState } from '../components.js';
import { renderContextHeader } from '../shell.js';
import { navigate } from '../nav.js';


async function renderFriends(container) {
  clear(container);
  renderContextHeader({ title: 'Friends', sub: 'People you know here' });
  const wrap = el('div', { class: 'page' });

  // On screen before the request. refreshFriends() was awaited with the page still in
  // hand, so a reader arriving here saw nothing at all for as long as it took - a blank
  // surface reads as broken, not as waiting.
  const waiting = loadingState('Loading people you know');
  wrap.appendChild(waiting);
  container.appendChild(wrap);
  await refreshFriends();
  waiting.remove();

  const addRow = el('div', { class: 'row-line' });
  // A placeholder is not a label: it disappears as soon as the field has text
  // in it, and a screen reader announces the field with nothing at all.
  const input = el('input', {
    class: 'input', type: 'search', placeholder: 'Find a user to friend\u2026',
    'aria-label': 'Search for a user to befriend',
    style: { flex: '1 1 260px' },
  });
  const addBtn = el('button', { class: 'btn', type: 'button' }, 'Add friend');
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  const resultsPane = el('div', { class: 'stack', hidden: false });
  async function doFind() {
    const q = input.value.trim();
    if (q.length < 2) return;
    let items;
    try {
      items = await Api.searchUsers(q);
    } catch (ex) {
      // "No users found" after a failed request is the worst version of this:
      // it reads as confirmation that the person you are looking for does not
      // exist, which is the one conclusion a search must never draw for you.
      clear(resultsPane);
      resultsPane.appendChild(errorState('Search is not working right now.', doFind,
        { detail: (ex && ex.message) || '' }));
      return;
    }
    clear(resultsPane);
    if (!items.length) {
      resultsPane.appendChild(emptyState('search', 'No users found', 'Try a different name.'));
      return;
    }
    for (const u of items) {
      const r = el('div', { class: 'row row--surface' });
      r.appendChild(avatar(u, { withPresence: true }));
      const m = el('div', { class: 'row-main' });
      m.appendChild(el('div', { class: 'row-title' }, u.displayName || u.username));
      m.appendChild(el('div', { class: 'row-sub' }, '@' + u.username));
      r.appendChild(m);
      const b = el('button', { class: 'btn sm', type: 'button' }, 'Add');
      b.addEventListener('click', async () => {
        try {
          const res = await Api.sendFriendRequest(u.id);
          if (res.autoAccepted) toast('Friend added!', 'ok');
          else toast('Request sent.', 'ok');
          await refreshFriends();
          renderFriendsList(wrap);
        } catch (ex) { toast(ex.message || 'Could not add', 'error'); }
      });
      r.appendChild(b);
      resultsPane.appendChild(r);
    }
  }
  addBtn.addEventListener('click', doFind);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(); });
  wrap.appendChild(resultsPane);

  const requestsRegion = el('div', { class: 'stack', dataset: { region: 'requests' } });
  wrap.appendChild(requestsRegion);
  await renderFriendsList(wrap);
  }

async function renderFriendsList(wrap) {
  const friendActions = (kind, person) => {
    const act = async (fn, okMsg, errMsg, level) => {
      try { await fn(); if (okMsg) toast(okMsg, level || 'ok'); await refreshFriends(); renderFriendsList(wrap); }
      catch (ex) { toast(ex.message || errMsg, 'error'); }
    };
    const items = [];
    if (kind === 'incoming') {
      items.push({ label: 'Accept request', onSelect: () => act(() => Api.acceptFriendRequest(person.reqId), 'Request accepted.', 'Failed') });
      items.push({ label: 'Decline request', danger: true, onSelect: () => act(() => Api.declineFriendRequest(person.reqId), 'Request declined.', 'Failed', 'warn') });
    } else if (kind === 'outgoing') {
      items.push({ label: 'Cancel request', onSelect: () => act(() => Api.cancelFriendRequest(person.reqId), 'Request cancelled.', 'Failed', 'warn') });
    } else {
      items.push({ label: 'Message', onSelect: async () => {
        try { const { id } = await Api.openDm(person.id); navigate('/dms/' + id); }
        catch (ex) { toast(ex.message || 'Cannot open', 'error'); }
      } });
      items.push({ label: 'View profile', onSelect: () => { navigate('/users/' + person.id); } });
      items.push({ sep: true });
      items.push({ label: 'Remove friend', danger: true, onSelect: () => act(() => Api.removeFriend(person.id), 'Friend removed.', 'Failed', 'warn') });
    }
    if (person.username) {
      items.push({ sep: true });
      items.push({ label: 'Copy user ID', onSelect: () => copyText(String(person.id), 'User ID copied.') });
    }
    return items;
  };

  const reqsBox = wrap.querySelector('[data-region="requests"]');
  if (!reqsBox) return;
  clear(reqsBox);
  if (State.friendsIn.length) {
    reqsBox.appendChild(el('div', { class: 'section-label' }, 'Incoming requests'));
    for (const r of State.friendsIn) {
      const row = el('div', { class: 'row row--surface' });
      attachContextMenu(row, () => friendActions('incoming', { id: r.from.id, username: r.from.username, reqId: r.id }), {
        target: () => ({ type: 'friend-request', id: String(r.id) }),
      });
      row.appendChild(avatar(r.from, { withPresence: false }));
      const m = el('div', { class: 'row-main' });
      m.appendChild(el('div', { class: 'row-title' }, r.from.displayName || r.from.username));
      row.appendChild(m);
      const accept = el('button', { class: 'btn primary sm', type: 'button' }, 'Accept');
      const decline = el('button', { class: 'btn ghost sm', type: 'button' }, 'Decline');
      accept.addEventListener('click', async () => {
        try { await Api.acceptFriendRequest(r.id); toast('Request accepted.', 'ok'); await refreshFriends(); renderFriendsList(wrap); } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
      decline.addEventListener('click', async () => {
        try { await Api.declineFriendRequest(r.id); toast('Request declined.', 'warn'); await refreshFriends(); renderFriendsList(wrap); } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
      reqsBox.appendChild(row);
      row.appendChild(accept);
      row.appendChild(decline);
    }
  }
  if (State.friendsOut.length) {
    reqsBox.appendChild(el('div', { class: 'section-label' }, 'Outgoing requests'));
    for (const r of State.friendsOut) {
      const row = el('div', { class: 'row row--surface' });
      attachContextMenu(row, () => friendActions('outgoing', { id: r.to.id, username: r.to.username, reqId: r.id }), {
        target: () => ({ type: 'friend-request', id: String(r.id) }),
      });
      row.appendChild(avatar(r.to, { withPresence: false }));
      const m = el('div', { class: 'row-main' });
      m.appendChild(el('div', { class: 'row-title' }, r.to.displayName || r.to.username));
      row.appendChild(m);
      const canc = el('button', { class: 'btn ghost sm', type: 'button' }, 'Cancel');
      canc.addEventListener('click', async () => {
        try { await Api.cancelFriendRequest(r.id); toast('Request cancelled.', 'warn'); await refreshFriends(); renderFriendsList(wrap); } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
      reqsBox.appendChild(row);
      row.appendChild(canc);
    }
  }
  if (State.friends.length) {
    reqsBox.appendChild(el('div', { class: 'section-label' }, 'Friends'));
    for (const f of State.friends) {
      const row = el('div', { class: 'row row--surface' });
      attachContextMenu(row, () => friendActions('friend', { id: f.id, username: f.username }), {
        target: () => ({ type: 'friend', id: String(f.id) }),
      });
      row.appendChild(avatar(f, { withPresence: true }));
      const m = el('div', { class: 'row-main' });
      m.appendChild(el('div', { class: 'row-title' }, f.displayName || f.username));
      m.appendChild(el('div', { class: 'row-sub' },
        '@' + f.username + ' · friend since ' + relTime(f.friendsSince)));
      row.appendChild(m);
      const dmBtn = el('button', { class: 'btn sm', type: 'button' }, 'Message');
      const rmBtn = el('button', { class: 'btn ghost sm', type: 'button', style: { color: 'var(--t-err)' } }, 'Remove');
      dmBtn.addEventListener('click', async () => {
        try {
          const { id } = await Api.openDm(f.id);
          navigate('/dms/' + id);
        } catch (ex) { toast(ex.message || 'Cannot open', 'error'); }
      });
      rmBtn.addEventListener('click', async () => {
        try { await Api.removeFriend(f.id); toast('Friend removed.', 'warn'); await refreshFriends(); renderFriendsList(wrap); } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
      reqsBox.appendChild(row);
      row.appendChild(dmBtn);
      row.appendChild(rmBtn);
    }
  } else if (!State.friendsIn.length && !State.friendsOut.length) {
    reqsBox.appendChild(emptyState('users', 'No friends yet', 'Search for someone above and send them a request.'));
  }
}

export { renderFriends };
