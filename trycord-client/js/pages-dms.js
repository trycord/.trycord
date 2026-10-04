
import Api from './api.js';
import { loadingState } from './states.js';
import State, { refreshDms, refreshFriends, isAuthed, mustVerifyToPost } from './state.js';
import {
  attachContextMenu, confirmDialog, copyText, esc, el, clear, toast, relTime,
  showEmojiPicker, insertAtCursor, openModal, openReportDialog,
} from './ui.js';
import { avatar, downloadAttachment, emptyState, icon, messageRow } from './components.js';
import { createAttachTray } from './attach-tray.js';
import { paintEmbeds, wireEmbedImages } from './embeds.js';
import { applyReplyCount, createReplyCounts, createThread } from './thread.js';
import { renderContextHeader } from './shell.js';
import Realtime from './realtime.js';
import { navigate } from './nav.js';

let activeDmId = null;
let dmSubs = [];
function dropDmSubs() {
  for (const off of dmSubs) { try { off(); } catch { /* ignore */ } }
  dmSubs = [];
}

async function renderDmList(container) {
  clear(container);
  renderContextHeader({ title: 'Direct messages', sub: 'People you talk to' });
  const wrap = el('div', { class: 'page' });
  let dms = State.dms;
  try { dms = await refreshDms(); } catch { /* non-fatal */ }

  if (!dms || !dms.length) {
    wrap.appendChild(emptyState('mail', 'No conversations yet',
      'Start a chat from a user\'s profile or send a friend a message.'));
  } else {
    for (const dm of dms) {
      const r = el('button', {
        class: 'row row--surface', type: 'button',
        dataset: { dmId: dm.id },
        onClick: () => { navigate('/dms/' + dm.id); },
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

  function dmIntro(withCta) {
    const box = el('div', { class: 'channel-intro' }, el('div', { class: 'channel-intro__mark' }, icon('mail')));
    box.appendChild(el('h2', { class: 'channel-intro__title' }, peer.displayName || peer.username));
    box.appendChild(el('p', { class: 'channel-intro__sub' }, 'This is the beginning of your conversation.'));
    if (withCta) box.appendChild(el('p', { class: 'channel-intro__cta' }, 'Say something kind below.'));
    return box;
  }

  // id or a timestamp would both be ambiguous at a boundary.
  let highSeq = 0;
  let lowSeq = 0;
  let loadingOlder = false;
  const noteSeq = (m) => {
    const s = m && m.seq;
    if (s === null || s === undefined) return;
    const n = Number(s);
    if (!Number.isFinite(n)) return;
    if (n > highSeq) highSeq = n;
    if (!lowSeq || n < lowSeq) lowSeq = n;
  };

  // boundary can never skip or repeat a message the way an id/timestamp tuple
  async function loadOlder() {
    if (loadingOlder) return;
    if (!lowSeq) return;   // no anchor yet: nothing older is reachable
    loadingOlder = true;
    const btn = feed.querySelector('.dm-load-older');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      const older = await Api.dmMessages(dmId, { before: lowSeq, limit: 50 });
      if (!Array.isArray(older) || !older.length) {
        if (btn) btn.remove();
        return;
      }
      const first = feed.querySelector('.msg');
      const heightBefore = thread.scrollHeight;
      const frag = document.createDocumentFragment();
      for (const m of older) appendDmMessage(m, frag, dmId);
      if (first) feed.insertBefore(frag, first);
      else feed.appendChild(frag);
      thread.scrollTop += thread.scrollHeight - heightBefore;
      if (btn) btn.remove();
    } catch (ex) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load older messages'; }
      toast((ex && ex.message) || 'Could not load older messages', 'error');
    } finally {
      loadingOlder = false;
    }
  }

  async function reload() {
    clear(feed);
    feed.appendChild(loadingState('Loading messages'));
    let msgs = [];
    try { msgs = await Api.dmMessages(dmId, { limit: 50 }); } catch (ex) {
      clear(feed);
      feed.appendChild(el('div', { class: 'form-error' }, (ex && ex.message) || 'Cannot load messages'));
      const retry = el('button', { class: 'btn sm', type: 'button' }, 'Try again');
      retry.addEventListener('click', () => reload().catch(() => {}));
      feed.appendChild(retry);
      return;
    }
    clear(feed);
    feed.appendChild(dmIntro(msgs.length === 0));
    highSeq = 0;
    lowSeq = 0;
    if (lowSeqAnchorable(msgs)) {
      const olderBtn = el('button', { class: 'btn sm dm-load-older', type: 'button' }, 'Load older messages');
      olderBtn.addEventListener('click', () => { loadOlder().catch(() => {}); });
      feed.appendChild(olderBtn);
    }
    for (const m of msgs) {
      appendDmMessage(m, feed, dmId);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function lowSeqAnchorable(msgs) {
    return Array.isArray(msgs) && msgs.length >= 50 && msgs.every((m) => m && m.seq !== null && m.seq !== undefined);
  }

  async function catchUp() {
    if (!highSeq) return reload();
    try {
      const missed = await Api.dmMessages(dmId, { after: highSeq, limit: 50 });
      if (!Array.isArray(missed) || !missed.length) return;
      const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
      for (const m of missed) appendDmMessage(m, feed, dmId);
      if (stick) thread.scrollTop = thread.scrollHeight;
    } catch {
      await reload();
    }
  }

  const replyCounts = createReplyCounts();

  function appendDmMessage(m, toFeed) {
    const target = toFeed || feed;
    if (m && m.id && target.querySelector('[data-message-id="' + m.id + '"]')) return null;
    const mine = String(m.authorId) === String(State.me && State.me.id);
    const row = messageRow({
      id: m.id,
      author_id: m.authorId,
      author_name: m.authorName,
      content: m.content,
      created_at: m.createdAt,
      edited_at: m.editedAt,
      // messageRow is the channel row and reads the wire names, so the camelCase
      // a DM message arrives with is mapped here rather than taught two shapes.
      reply_count: replyCounts.get({ id: m.id, replyCount: m.replyCount }),
      attachments: m.attachments || [],
      embeds: m.embeds || [],
    }, {
      meId: State.me && State.me.id,
      onDelete: mine ? () => removeDm(dmId, m.id) : null,
      onEdit: mine ? () => editDm(dmId, m) : null,
      onOpenThread: () => openDmThread(m),
      onDownload: (e, att) => { e.preventDefault(); downloadAttachment(att).catch((ex) => toast(ex.message || 'Cannot download', 'error')); },
    });
    // A direct message had no context menu at all. The community conversation
    // attaches one to every row; the DM view only ever attached its menus to
    // friend rows, so right-clicking a message did nothing and the edit and
    // delete handlers handed to messageRow above were unreachable. That is what
    // made context menus look like they had disappeared from the application:
    // the surfaces that still had them were the ones the crash was not on.
    //
    // The menu is ui.js's shared implementation. Only the actions are
    // DM-specific, because a direct message belongs to no channel and no
    // community role applies to it - every entry here is a request the DM routes
    // already serve.
    attachContextMenu(row, () => dmMessageActions(m, mine), {
      target: () => ({ type: 'message', id: String(m.id) }),
    });
    // A reply has just arrived for some other message: move that message's
    // badge, if it is on screen. A history read carries a count of its own and
    // a live push does not, and that is the whole test - counting the history
    // page would add every reply in it to the badge again.
    if (m.replyCount === undefined && m.threadRootId && String(m.threadRootId) !== String(m.id)) {
      const n = replyCounts.noted(m.threadRootId);
      if (n !== null) applyReplyCount(m.threadRootId, n, () => openDmThread(m.threadRootId));
    }
    target.appendChild(row);
    noteSeq(m);
    return row;
  }

  // One thread open at a time, for the same reason as the channel view: two
  // inline blocks in one feed is unreadable on a phone.
  let openDmThreadId = null;
  function openDmThread(m) {
    const id = m && m.id !== undefined ? m.id : m;
    if (openDmThreadId && openDmThreadId !== String(id)) closeDmThread();
    if (openDmThreadId === String(id)) { closeDmThread(); return; }
    const row = feed.querySelector('[data-message-id="' + id + '"]');
    if (!row) return;
    const view = createThread({
      kind: 'dm', scopeId: dmId, rootId: id,
      rootMessage: m && m.id !== undefined ? m : null,
      canReply: !mustVerifyToPost(),
    });
    openDmThreadId = String(id);
    row.after(view.node);
    view.node.scrollIntoView({ block: 'nearest' });
  }
  function closeDmThread() {
    const node = conv.querySelector('.msg-thread');
    if (node) node.remove();
    openDmThreadId = null;
  }

  // Actions for one direct message.
  //
  // No pin: a DM is in no channel. No moderation entry: there is no community
  // whose permission would grant one, and being able to delete your own message
  // is not authority over anyone else's.
  function dmMessageActions(m, mine) {
    const items = [{ label: 'Reply in thread', onSelect: () => openDmThread(m) }];
    if (m.content) {
      items.push({ label: 'Copy text', onSelect: () => copyText(m.content, 'Message copied.') });
    }
    items.push({ label: 'Copy message ID', onSelect: () => copyText(String(m.id), 'Message ID copied.') });
    if (!mine && m.authorId) {
      items.push({ sep: true });
      items.push({
        label: 'View profile',
        desc: m.authorName || 'this person',
        onSelect: () => navigate('/users/' + m.authorId),
      });
      items.push({
        label: 'Report message',
        onSelect: () => openReportDialog({
          targetType: 'message',
          targetId: m.id,
          title: 'Report message',
          subtitle: 'Reports go to this instance’s moderators.',
          onSubmit: ({ category, extra }) => Api.reportContent('message', m.id, category, extra || undefined),
        }),
      });
    } else if (mine) {
      items.push({ sep: true });
      items.push({ label: 'Edit message', onSelect: () => editDm(dmId, m) });
      items.push({
        label: 'Delete message',
        danger: true,
        onSelect: () => confirmDialog({
          title: 'Delete this message?',
          message: 'It is removed for everyone in this conversation.',
          danger: true,
          confirmText: 'Delete',
          onConfirm: () => removeDm(dmId, m.id),
        }),
      });
    }
    return items;
  }

  async function removeDm(cid, mid) {
    try {
      await Api.deleteDm(cid, mid);
    } catch (ex) { toast(ex.message || 'Cannot delete', 'error'); }
  }

  async function editDm(cid, m) {
    const textarea = el('textarea', { class: 'textarea', style: { minHeight: '60px' } }, m.content);
    const saveBtn = el('button', { class: 'btn primary sm', type: 'button' }, 'Save');
    const cancelBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    const modal = openModal({
      title: 'Edit message',
      body: textarea,
      footer: el('div', { class: 'row-line' }, cancelBtn, saveBtn),
    });
    cancelBtn.addEventListener('click', () => modal.close());
    saveBtn.addEventListener('click', async () => {
      try {
        await Api.updateDm(cid, m.id, textarea.value.trim());
        modal.close();
      } catch (ex) { toast(ex.message || 'Cannot edit', 'error'); }
    });
  }

  const composer = el('div', { class: 'composer' });
  const ta = el('textarea', { placeholder: 'Message ' + (peer.displayName || peer.username) + '…', rows: 1 });
  const sendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Send');
  const emojiBtn = el('button', { class: 'emoji-btn', type: 'button', title: 'Emoji', 'aria-label': 'Insert emoji' }, icon('smile'));
  const fileBtn = el('button', { class: 'file-btn', type: 'button', title: 'Attach file', 'aria-label': 'Attach file' }, icon('paperclip'));
  const fileInput = el('input', { type: 'file', hidden: true, multiple: true });
  emojiBtn.addEventListener('click', () => showEmojiPicker(emojiBtn, (e) => insertAtCursor(ta, e)));
  // The same tray the channel composer uses, with the DM upload endpoint.
  const attachments = createAttachTray({
    upload: (file, onProgress) => Api.uploadDmAttachment(dmId, file, onProgress),
    onChange: () => { sendBtn.disabled = !attachments.hasReady() && !ta.value.trim(); },
  });
  composer.appendChild(fileBtn);
  composer.appendChild(fileInput);
  composer.appendChild(ta);
  // The same per-message opt-out the channel composer has. One control, same
  // meaning, same server-side enforcement.
  const previewOff = el('button', {
    class: 'preview-toggle', type: 'button',
    title: 'Do not generate link previews for this message',
    'aria-label': 'Do not generate link previews for this message',
    'aria-pressed': 'false',
  }, icon('globe'));
  previewOff.addEventListener('click', () => {
    const on = previewOff.getAttribute('aria-pressed') !== 'true';
    previewOff.setAttribute('aria-pressed', on ? 'true' : 'false');
    previewOff.classList.toggle('is-on', on);
    previewOff.title = on ? 'Link previews are off for the next message'
      : 'Do not generate link previews for this message';
  });
  composer.appendChild(el('div', { class: 'composer-actions' }, previewOff, emojiBtn, sendBtn));
  conv.appendChild(el('div', { class: 'composer-dock' }, attachments.node, composer));
  {
    const me = State.me;
    if (mustVerifyToPost()) {
      ta.disabled = true;
      ta.placeholder = 'Verify your email to send messages.';
      sendBtn.disabled = true;
      emojiBtn.disabled = true;
      fileBtn.disabled = true;
      composer.classList.add('locked');
    }
  }
  attachments.attach({ container: conv, composer, textarea: ta, button: fileBtn, input: fileInput });

  function send() {
    const content = ta.value.trim();
    // A file on its own is a message here too, as it is in a channel.
    const readyIds = attachments.readyIds();
    if (!content && !readyIds.length) {
      if (attachments.isUploading()) { toast('Still uploading', 'warn'); return; }
      return;
    }
    sendBtn.setAttribute('aria-busy', 'true');
    threadedSend(content, readyIds);
  }
  let sendLock = false;
  // confirmed success, and the composer text is deliberately left in place on
  let pendingNonce = null;
  function newNonce() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  async function threadedSend(content, attachmentIds) {
    if (sendLock) return;
    sendLock = true;
    const nonce = pendingNonce || newNonce();
    pendingNonce = nonce;
    try {
      const suppressEmbeds = previewOff.getAttribute('aria-pressed') === 'true';
      await Api.sendDm(dmId, content, nonce, attachmentIds, suppressEmbeds);
      pendingNonce = null;
      if (suppressEmbeds) {
        previewOff.setAttribute('aria-pressed', 'false');
        previewOff.classList.remove('is-on');
      }
      ta.value = '';
      attachments.clear();
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
    Realtime.on('dm:message_embeds', (p) => {
      // Scoped by conversation, for the same reason the channel handler is
      // scoped by channel: a frame without one is a bug, and matching every
      // conversation would put one message's card on another's row.
      if (String(p.conversationId) !== String(dmId)) return;
      const node = feed.querySelector('[data-message-id="' + p.messageId + '"]');
      const tray = node && node.querySelector('.embed-tray');
      if (!tray) return;
      paintEmbeds(tray, p.embeds);
      wireEmbedImages(tray);
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
    Realtime.on('open', () => {
      if (String(activeDmId) === String(dmId)) catchUp().catch(() => {});
    }),
  ];
  Api.dmRead(dmId).catch(() => {});
}

export function leaveDm() {
  dropDmSubs();
  if (activeDmId) Realtime.leaveDm();
  activeDmId = null;
}


async function renderFriends(container) {
  clear(container);
  renderContextHeader({ title: 'Friends', sub: 'People you know here' });
  const wrap = el('div', { class: 'page' });
  await refreshFriends();

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
    let items = [];
    try { items = await Api.searchUsers(q); } catch { /* non-fatal */ }
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
  container.appendChild(wrap);
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

export async function renderDms(container, { id } = {}) {
  renderContextHeader({});
  if (!id) return renderDmList(container);
  return renderDmThread(container, id);
}

export async function renderFriendsPage(container) {
  return renderFriends(container);
}

export default { renderDms, renderFriendsPage, leaveDm };
