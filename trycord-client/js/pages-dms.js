// Direct messages + friends. DM chat uses the dm conversation API with
// WS dm events; friends uses the friends routes.

import Api from './api.js';
import State, { refreshDms, refreshFriends, isAuthed } from './state.js';
import { esc, el, clear, toast, relTime } from './ui.js';
import { avatar, emptyState } from './components.js';
import { renderContextHeader } from './shell.js';
import Realtime from './realtime.js';

let activeDmId = null;
// Live DM subscriptions for the open thread. Dropped on every thread
// switch/unmount (F3): without this each render stacked 3 permanent
// handlers that all consumed every later dm event.
let dmSubs = [];
function dropDmSubs() {
  for (const off of dmSubs) { try { off(); } catch { /* ignore */ } }
  dmSubs = [];
}

async function renderDmList(container) {
  clear(container);
  renderContextHeader({ title: 'Direct messages', sub: 'People you talk to' });
  const wrap = el('div', { class: 'page atrium' });
  let dms = State.dms;
  try { dms = await refreshDms(); } catch { /* non-fatal */ }

  if (!dms || !dms.length) {
    wrap.appendChild(emptyState('✉', 'No conversations yet',
      'Start a chat from a user\'s profile or send a friend a message.'));
  } else {
    for (const dm of dms) {
      const r = el('button', {
        class: 'row', type: 'button',
        dataset: { dmId: dm.id },
        onClick: () => { location.hash = '#/dms/' + dm.id; },
      });
      r.appendChild(avatar(dm.peer, { withPresence: true }));
      const m = el('div', { class: 'row-main' });
      const t = el('span', { class: 'row-title' }, dm.peer.displayName || dm.peer.username);
      m.appendChild(t);
      m.appendChild(el('div', { class: 'row-sub' },
        dm.lastMessage ? esc(dm.lastMessage.content.slice(0, 100)) : 'Say hello'));
      r.appendChild(m);
      r.appendChild(el('span', { class: 'row-meta' },
        (dm.lastMessage ? relTime(dm.lastMessage.createdAt) : '') +
        (dm.unreadCount ? ' · ' + dm.unreadCount + ' unread' : '')));
      wrap.appendChild(r);
    }
  }
  container.appendChild(wrap);
}

async function renderDmThread(container, dmId) {
  // Tear down the previous thread first: its handlers close over a
  // detached feed and must never consume another event.
  leaveDm();
  activeDmId = dmId;
  clear(container);
  let detail;
  try {
    detail = await Api.dm(dmId);
  } catch (ex) {
    clear(container);
    renderContextHeader({ title: 'Direct message' });
    container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Conversation unavailable'));
    return;
  }
  const peer = detail.peer;
  renderContextHeader({ title: peer.displayName || peer.username, sub: '@' + peer.username });

  const conv = el('div', { class: 'conversation' });
  const thread = el('div', { class: 'thread' });
  const feed = el('div', { class: 'feed' });
  thread.appendChild(feed);
  conv.appendChild(thread);

  // load history
  async function reload() {
    let msgs = [];
    try { msgs = await Api.dmMessages(dmId, { limit: 50 }); } catch { /* offline */ }
    clear(feed);
    if (!msgs.length) {
      feed.appendChild(emptyState('◌', 'No messages yet', 'Say something kind.'));
    }
    for (const m of msgs) {
      appendDmMessage(m, feed, dmId);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function appendDmMessage(m, toFeed) {
    // Authoritative-id dedup (F2): the sender's POST is already in the
    // feed via reload(), and the server fans dm:message back to the
    // sender's own sockets too. Never render an id twice.
    const target = toFeed || feed;
    if (m && m.id && target.querySelector('[data-message-id="' + m.id + '"]')) return null;
    const mine = String(m.authorId) === String(State.me && State.me.id);
    const row = el('div', { class: 'msg' + (mine ? ' mine' : ''), dataset: { messageId: m.id } });
    row.appendChild(avatar({ id: m.authorId, username: m.authorName }, { withPresence: false }));
    const body = el('div', { class: 'msg-body' });
    const head = el('div', { class: 'msg-head' });
    head.appendChild(el('span', { class: 'msg-author' }, m.authorName));
    head.appendChild(el('span', { class: 'msg-time' }, relTime(m.createdAt)));
    if (m.editedAt) head.appendChild(el('span', { class: 'msg-edited' }, 'edited'));
    const actions = el('span', { class: 'msg-actions' });
    if (mine) {
      actions.appendChild(el('button', { type: 'button', title: 'Delete', onClick: () => removeDm(dmId, m.id, m) }, '🗑'));
      actions.appendChild(el('button', { type: 'button', title: 'Edit', onClick: () => editDm(dmId, m) }, '✎'));
    }
    head.appendChild(actions);
    body.appendChild(head);
    body.appendChild(el('div', { class: 'msg-text' }, esc(m.content)));
    row.appendChild(body);
    target.appendChild(row);
    return row;
  }

  async function removeDm(cid, mid) {
    try {
      await Api.deleteDm(cid, mid);
    } catch (ex) { toast(ex.message || 'Cannot delete', 'error'); }
  }

  async function editDm(cid, m) {
    const textarea = el('textarea', { class: 'textarea', style: { minHeight: '60px' } }, m.content);
    const saveBtn = el('button', { class: 'btn primary sm', type: 'button' }, 'Save');
    const modal = el('div', { class: 'modal-root' });
    const box = el('div', { class: 'modal' });
    box.appendChild(el('h3', {}, 'Edit message'));
    box.appendChild(textarea);
    box.appendChild(el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-3)' } },
      el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.remove() }, 'Cancel'), saveBtn));
    modal.appendChild(box);
    container.appendChild(modal);
    saveBtn.addEventListener('click', async () => {
      try {
        await Api.updateDm(cid, m.id, textarea.value.trim());
        modal.remove();
      } catch (ex) { toast(ex.message || 'Cannot edit', 'error'); }
    });
  }

  // composer
  const composer = el('div', { class: 'composer' });
  const ta = el('textarea', { placeholder: 'Message ' + (peer.displayName || peer.username) + '…', rows: 1 });
  const sendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Send');
  composer.appendChild(ta);
  composer.appendChild(el('div', { class: 'composer-actions' }, sendBtn));
  conv.appendChild(composer);

  function send() {
    const content = ta.value.trim();
    if (!content) return;
    sendBtn.setAttribute('aria-busy', 'true');
    threadedSend(content);
  }
  let sendLock = false;
  async function threadedSend(content) {
    if (sendLock) return;
    sendLock = true;
    try {
      await Api.sendDm(dmId, content);
      ta.value = '';
      ta.style.height = 'auto';
      await reload();
    } catch (ex) {
      toast(ex.message || 'Could not send', 'error');
    } finally {
      sendLock = false;
      sendBtn.removeAttribute('aria-busy');
    }
  }

  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    Realtime.typing(dmId);
  });

  container.appendChild(conv);
  await reload();
  Realtime.joinDm(dmId);
  dmSubs = [
    Realtime.on('dm:message', (m) => {
      if (String(m.conversationId) === String(dmId)) appendDmMessage(m);
    }),
    Realtime.on('dm:message_deleted', (m) => {
      if (String(m.conversationId) === String(dmId)) {
        const node = feed.querySelector('[data-message-id="' + m.id + '"]');
        if (node) node.remove();
      }
    }),
    Realtime.on('dm:message_updated', (m) => {
      if (String(m.conversationId) === String(dmId)) {
        const node = feed.querySelector('[data-message-id="' + m.id + '"]');
        if (node) {
          const t = node.querySelector('.msg-text');
          if (t) t.textContent = m.content;
        }
      }
    }),
    // Reconnect resync (F4): reload() is authoritative (clear + refetch),
    // so catching up after offline time cannot duplicate state.
    Realtime.on('open', () => {
      if (String(activeDmId) === String(dmId)) reload().catch(() => {});
    }),
  ];
  Api.dmRead(dmId).catch(() => {});
}

export function leaveDm() {
  dropDmSubs();
  if (activeDmId) Realtime.leaveDm();
  activeDmId = null;
}

// ---- friends ---------------------------------------------------------------

async function renderFriends(container) {
  clear(container);
  renderContextHeader({ title: 'Friends', sub: 'People you know here' });
  const wrap = el('div', { class: 'page atrium' });
  await refreshFriends();

  const addRow = el('div', { class: 'row-line' });
  const input = el('input', { class: 'input', type: 'search', placeholder: 'Find a user to friend…', style: { flex: '1 1 260px' } });
  const addBtn = el('button', { class: 'btn', type: 'button' }, 'Add friend');
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  const resultsPane = el('div', { class: 'stack', hidden: false });
  async function doFind() {
    const q = input.value.trim();
    if (q.length < 2) return;
    let items = [];
    try { items = await Api.searchUsers(q); } catch { /* non-fatal */ }
    clear(resultsPane);
    if (!items.length) {
      resultsPane.appendChild(emptyState('⌕', 'No users found', 'Try a different name.'));
      return;
    }
    for (const u of items) {
      const r = el('div', { class: 'row' });
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
  container.appendChild(wrap);
}

async function renderFriendsList(wrap) {
  const reqsBox = wrap.querySelector('[data-region="requests"]');
  if (!reqsBox) return;
  clear(reqsBox);
  if (State.friendsIn.length) {
    reqsBox.appendChild(el('div', { class: 'section-label' }, 'Incoming requests'));
    for (const r of State.friendsIn) {
      const row = el('div', { class: 'row' });
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
      const row = el('div', { class: 'row' });
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
      const row = el('div', { class: 'row' });
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
          location.hash = '#/dms/' + id;
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
    reqsBox.appendChild(emptyState('☺', 'No friends yet', 'Search for someone above and send them a request.'));
  }
}

export async function renderDms(container, { id } = {}) {
  renderContextHeader({});
  if (!id) return renderDmList(container);
  return renderDmThread(container, id);
}

export async function renderFriendsPage(container) {
  return renderFriends(container);
}

export default { renderDms, renderFriendsPage, leaveDm };