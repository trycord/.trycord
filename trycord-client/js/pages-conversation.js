import Api from './api.js';
import State from './state.js';
import Realtime from './realtime.js';

import { can, currentServerId, isMuted, mustVerifyToPost, refreshMutes, setMuted, setViewRefresh } from './state.js';
import { clear, confirmDialog, copyText, el, esc, insertAtCursor, openReportDialog, relTime, showContextMenu, attachContextMenu, showEmojiPicker, toast } from './ui.js';
import { emptyState, messageRow, paintReactions } from './components.js';
import { membersHidden, renderAllChrome, renderContextHeader, toggleMembers } from './shell.js';
import { currentActiveChannel, ensureServer, pickReaction, setActiveChannel } from './workspace-shared.js';
import { TrycordConfig } from './config.js';

async function renderChannel(container, serverId, channelId, opts = {}) {
  clear(container);
  let server;
  try {
    if (String(State.lastServerId) !== String(serverId)) {
      const { detail } = await ensureServer(serverId);
      server = detail;
    } else if (State.serverDetail) {
      server = State.serverDetail;
    } else {
      const { detail } = await ensureServer(serverId);
      server = detail;
    }
  } catch (ex) {
    renderContextHeader({ title: 'Unavailable' });
    container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this server'));
    return;
  }

  const layout = State.channels;
  const channel = (layout.channels || []).find((c) => String(c.id) === String(channelId));
  const chanName = channel ? channel.name : 'channel';
  const memberToggle = el('button', {
    class: 'btn icon', type: 'button',
    title: membersHidden() ? 'Show member list' : 'Hide member list',
    'aria-label': membersHidden() ? 'Show member list' : 'Hide member list',
    'aria-pressed': membersHidden() ? 'false' : 'true',
    onClick: (e) => {
      toggleMembers();
      const hidden = membersHidden();
      const btn = e.currentTarget;
      btn.title = hidden ? 'Show member list' : 'Hide member list';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', hidden ? 'false' : 'true');
    },
  }, '☰');
  let muted = isMuted(channelId);
  try { await refreshMutes(); muted = isMuted(channelId); } catch { /* keep last known */ }
  const bellBtn = el('button', {
    class: 'btn icon', type: 'button',
    title: muted ? 'Unmute this channel' : 'Mute this channel',
    'aria-label': muted ? 'Unmute this channel' : 'Mute this channel',
    'aria-pressed': muted ? 'true' : 'false',
    onClick: async (e) => {
      const btn = e.currentTarget;
      try {
        if (isMuted(channelId)) {
          await Api.unmuteChannel(channelId);
          setMuted(channelId, false);
        } else {
          await Api.muteChannel(channelId);
          setMuted(channelId, true);
        }
        const now = isMuted(channelId);
        renderAllChrome();
        btn.textContent = now ? '🔕' : '🔔';
        btn.title = now ? 'Unmute this channel' : 'Mute this channel';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', now ? 'true' : 'false');
        toast(now ? 'Channel muted.' : 'Channel unmuted.', 'ok');
      } catch (ex) { toast(ex.message || 'Could not change mute.', 'error'); }
    },
  }, muted ? '🔕' : '🔔');
  const searchBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Search in this community', 'aria-label': 'Search messages',
    onClick: () => toggleSearchPanel(),
  }, '⌕');
  const pinsBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Pinned messages', 'aria-label': 'Pinned messages',
    onClick: () => { location.hash = '#/server/' + serverId + '/channel/' + channelId + '/pins'; },
  }, '☆');
  const moreBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Community actions', 'aria-label': 'Community actions',
    onClick: () => {
      const menu = document.querySelector('#place-navigation .place-header__menu');
      if (menu) menu.click();
    },
  }, '⋯');
  renderContextHeader({ title: '#' + chanName, sub: (channel && channel.topic) ? esc(channel.topic) : server.name, icon: '#', actions: [searchBtn, pinsBtn, bellBtn, moreBtn, memberToggle] });

  const conv = el('div', { class: 'conversation' });
  const thread = el('div', { class: 'thread' });
  const feed = el('div', { class: 'feed' });
  thread.appendChild(feed);
  conv.appendChild(thread);

  const HISTORY_PAGE = 50;

  function channelIntro(withCta) {
    const box = el('div', { class: 'channel-intro' }, el('div', { class: 'channel-intro__mark' }, '#'));
    box.setAttribute('data-intro', '1');
    box.appendChild(el('h2', { class: 'channel-intro__title' }, 'Welcome to #' + chanName));
    box.appendChild(el('p', { class: 'channel-intro__sub' },
      (channel && channel.topic) ? channel.topic : 'This is the beginning of the conversation.'));
    if (withCta) box.appendChild(el('p', { class: 'channel-intro__cta' }, 'Send the first message below.'));
    return box;
  }

  let highSeq = 0;
  let lowSeq = 0;
  let historyExhausted = false;
  let loadingOlder = false;

  const noteSeq = (m) => {
    if (!m || typeof m.seq !== 'number') return;
    if (m.seq > highSeq) highSeq = m.seq;
    if (!lowSeq || m.seq < lowSeq) lowSeq = m.seq;
  };

  async function loadOlder() {
    if (loadingOlder || historyExhausted) return;
    if (!lowSeq) return;
    loadingOlder = true;
    const threadEl = thread;
    const prevHeight = threadEl.scrollHeight;
    const prevTop = threadEl.scrollTop;
    try {
      const msgs = await Api.messages(channelId, { before: lowSeq, limit: HISTORY_PAGE });
      if (!Array.isArray(msgs) || !msgs.length) {
        historyExhausted = true;
        return;
      }
      const existing = new Set(
        [...feed.querySelectorAll('.msg')].map((n) => n.dataset.messageId)
      );
      const fresh = msgs.filter((m) => m.id && !existing.has(m.id));
      if (fresh.length) {
        const frag = document.createDocumentFragment();
        for (const m of fresh) { noteSeq(m); frag.appendChild(buildMsg(m)); }
        // Below the intro block, never above it.
        const at = feed.querySelector('[data-intro]')?.nextSibling || feed.firstChild;
        while (frag.firstChild) feed.insertBefore(frag.firstChild, at);
        groupFeed(feed);
        threadEl.scrollTop = prevTop + (threadEl.scrollHeight - prevHeight);
      }
      if (fresh.length < HISTORY_PAGE) historyExhausted = true;
    } catch {
    } finally {
      loadingOlder = false;
    }
  }

  async function catchUp() {
    if (!highSeq) return;
    try {
      const missed = await Api.messages(channelId, { after: highSeq, limit: HISTORY_PAGE });
      if (!Array.isArray(missed) || !missed.length) return;
      for (const m of missed) upsertMessage(m, { scroll: false });
    } catch { /* offline: the next reconnect will try again */ }
  }

  let loadingHistory = false;
  const pendingLive = new Map();
  let reloadSeq = 0;

  async function reload() {
    const seq = ++reloadSeq;
    loadingHistory = true;
    pendingLive.clear();
    clear(feed);
    feed.appendChild(el('div', { class: 'feed-loading' }, 'Loading messages…'));
    let msgs = [];
    try {
      msgs = await Api.messages(channelId, { limit: HISTORY_PAGE });
    } catch (ex) {
      if (seq !== reloadSeq) return;
      loadingHistory = false;
      clear(feed);
      feed.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load messages'));
      const retry = el('button', { class: 'btn sm', type: 'button' }, 'Try again');
      retry.addEventListener('click', () => reload().catch(() => {}));
      feed.appendChild(retry);
      return;
    }
    if (seq !== reloadSeq) return;
    loadingHistory = false;
    highSeq = 0;
    lowSeq = 0;
    historyExhausted = false;
    clear(feed);
    feed.appendChild(channelIntro(msgs.length === 0));
    for (const m of msgs) { noteSeq(m); feed.appendChild(buildMsg(m)); }
    groupFeed(feed);
    const late = [...pendingLive.values()];
    pendingLive.clear();
    for (const m of late) upsertMessage(m, { scroll: false });
    if (opts.focusMessage) {
      focusMessage(opts.focusMessage);
    } else {
      thread.scrollTop = thread.scrollHeight;
    }
  }

  function focusMessage(id) {
    const target = feed.querySelector('[data-message-id="' + CSS.escape(String(id)) + '"]');
    if (!target) {
      toast('That message is older than the loaded history.', 'warn');
      thread.scrollTop = thread.scrollHeight;
      return;
    }
    target.scrollIntoView({ block: 'center' });
    target.classList.add('msg--linked');
    setTimeout(() => target.classList.remove('msg--linked'), 2400);
  }

  function openReportModal(m) {
    const authorName = m.author_display || m.author_name || m.user || 'Unknown';
    openReportDialog({
      targetType: 'message',
      targetId: m.id,
      title: 'Report message',
      subtitle: 'From ' + authorName + '. Moderators will review it.',
      onSubmit: ({ category, extra }) => Api.reportContent('message', m.id, category, extra || undefined),
    });
  }
  // by pin/unpin broadcasts so menus and badges never go stale.
  const pinState = new Map();
  async function toggleReaction(messageId, emoji, mine) {
    try {
      if (mine) await Api.removeReaction(channelId, messageId, emoji);
      else await Api.addReaction(channelId, messageId, emoji);
    } catch (ex) { toast(ex.message || 'Could not react.', 'error'); }
  }
  async function togglePin(m) {
    const pinned = pinState.get(String(m.id)) ?? !!m.pinned;
    try {
      if (pinned) await Api.unpinMessage(serverId, channelId, m.id);
      else await Api.pinMessage(serverId, channelId, m.id);
    } catch (ex) { toast(ex.message || 'Could not change pin.', 'error'); }
  }
  function patchEngagement(id, { reactions: list, pinned }) {
    const node = feed.querySelector('[data-message-id="' + id + '"]');
    if (!node) return;
    if (pinned !== undefined) {
      pinState.set(String(id), !!pinned);
      const head = node.querySelector('.msg-head');
      const badge = node.querySelector('.msg-pinned');
      if (pinned && head && !badge) head.appendChild(el('span', { class: 'msg-pinned', title: 'Pinned message' }, '📌'));
      if (!pinned && badge) badge.remove();
    }
    if (list !== undefined) {
      const bar = node.querySelector('.msg-reactions');
      const meId = State.me && State.me.id;
      if (bar) {
        paintReactions(bar, (list || []).map((r) => ({
          ...r,
          mine: !!(r.users && meId && r.users.map(String).includes(String(meId))),
        })), (emoji, mine) => toggleReaction(id, emoji, mine));
      }
    }
  }
  function buildMsg(m) {
    const meId = State.me && State.me.id;
    const isMine = meId !== undefined && String(m.author_id) === String(meId);
    if (m.pinned) pinState.set(String(m.id), true);
    const node = messageRow(m, {
      meId,
      onEdit: () => editMsg(m),
      onDelete: () => deleteMsg(m),
      onDownload: (e, att) => downloadAtt(e, att),
      onReact: (emoji, mine) => toggleReaction(m.id, emoji, mine),
      onHover: (action, anchor) => {
        if (action === 'react') {
          showEmojiPicker(anchor, (emoji) => toggleReaction(m.id, emoji, false));
          return;
        }
        const r = anchor.getBoundingClientRect();
        openMsgMenu(r.left, r.bottom + 4, m, isMine);
      },
    });
    stampMsgNode(node, m);
    attachContextMenu(node, () => msgActions(m, isMine), {
      target: () => ({ type: 'message', id: String(m.id) }),
    });
    return node;
  }

  // and a touch sheet can never drift apart. Permission-shaped: an action the
  function msgActions(m, isMine) {
    const authorName = m.author_display || m.author_name || m.user || 'Unknown';
    const pinned = pinState.get(String(m.id)) ?? !!m.pinned;
    return [
      { label: 'Add reaction', onSelect: () => pickReaction(m.id) },
      { sep: true },
      ...(m.content ? [{ label: 'Copy text', onSelect: () => copyText(m.content, 'Message copied.') }] : []),
      { label: 'Copy message link', onSelect: () => copyText(msgLink(m), 'Message link copied.') },
      { label: 'Copy message ID', onSelect: () => copyText(String(m.id), 'Message ID copied.') },
      ...(m.author_id ? [{ label: 'View profile', desc: authorName, onSelect: () => { location.hash = '#/users/' + m.author_id; } }] : []),
      ...((can('MANAGE_MESSAGES') || isMine) ? [{ sep: true }] : []),
      ...(isMine ? [{ label: 'Edit message', onSelect: () => editMsg(m) }] : []),
      ...(can('MANAGE_MESSAGES') ? [{ label: pinned ? 'Unpin message' : 'Pin message', onSelect: () => togglePin(m) }] : []),
      { label: 'Report message', onSelect: () => openReportModal(m) },
      ...((can('MANAGE_MESSAGES') || isMine) ? [{ label: 'Delete message', danger: true, onSelect: () => deleteMsg(m) }] : []),
    ];
  }

  // identifies it - never the text, the author or the timestamp.
  function msgLink(m) {
    return location.origin + '/#/server/' + currentServerId() + '/channel/' + channelId + '?m=' + encodeURIComponent(m.id);
  }

  function openMsgMenu(x, y, m, isMine) {
    showContextMenu(x, y, msgActions(m, isMine), {
      target: { type: 'message', id: String(m.id) },
    });
  }

  function newNonce() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
    } catch { /* fall through */ }
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function stampMsgNode(node, m) {
    try {
      if (m && m.author_id) node.dataset.author = String(m.author_id);
      if (m && m.created_at) node.dataset.ts = String(m.created_at);
      if (m && typeof m.seq === 'number') node.dataset.seq = String(m.seq);
    } catch { /* grouping metadata is decorative */ }
  }

  const GROUP_WINDOW_MS = 5 * 60 * 1000;

  function groupState(node, prev) {
    if (!node || !prev) return false;
    const a = node.dataset.author || '';
    if (!a) return false;
    const pa = prev.dataset.author || '';
    if (a !== pa) return false;
    const ts = Date.parse(node.dataset.ts || '') || 0;
    const pts = Date.parse(prev.dataset.ts || '') || 0;
    return ts >= pts && (ts - pts) < GROUP_WINDOW_MS;
  }

  function applyGrouping(node) {
    if (!node) return;
    const prev = node.previousElementSibling;
    node.classList.toggle('grouped', groupState(node, prev));
  }

  function regroupAround(node) {
    applyGrouping(node);
    if (node && node.previousElementSibling) applyGrouping(node.previousElementSibling);
    const next = node && node.nextElementSibling;
    if (next) applyGrouping(next);
  }

  function groupFeed(feedEl) {
    let prev = null;
    for (const node of feedEl.querySelectorAll(':scope > .msg')) {
      node.classList.toggle('grouped', groupState(node, prev));
      prev = node;
    }
  }

  function editMsg(m) {
    const ta = el('textarea', { class: 'textarea', style: { minHeight: '70px' } }, m.content);
    const save = el('button', { class: 'btn primary sm', type: 'button' }, 'Save');
    const cancel = el('button', { class: 'btn ghost sm', type: 'button' }, 'Cancel');
    const box = el('div', { class: 'modal' },
      el('h3', {}, 'Edit message'), ta,
      el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-3)' } }, cancel, save));
    const backdrop = el('div', { class: 'backdrop' }, box);
    container.appendChild(backdrop);
    cancel.addEventListener('click', () => backdrop.remove());
    save.addEventListener('click', async () => {
      try {
        await Api.updateMessage(channelId, m.id, { content: ta.value.trim() });
        backdrop.remove();
        await reload();
      } catch (ex) { toast(ex.message || 'Cannot edit', 'error'); }
    });
    ta.focus();
  }

  async function deleteMsg(m) {
    confirmDialog({
      title: 'Delete message?', message: 'This cannot be undone.', danger: true, confirmText: 'Delete',
      onConfirm: async () => {
        try { await Api.deleteMessage(channelId, m.id); } catch (ex) { toast(ex.message || 'Cannot delete', 'error'); }
      },
    });
  }

  async function downloadAtt(e, att) {
    // Authenticated download; raw blob so the file actually saves.
    e.preventDefault();
    try {
      const res = await Api.fetchAttachment(att.id);
      const blob = new Blob([res.buffer]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = att.filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (ex) { toast(ex.message || 'Cannot download', 'error'); }
  }

  const composer = el('div', { class: 'composer' });
  const fileBtn = el('button', { class: 'file-btn', type: 'button', title: 'Attach file', 'aria-label': 'Attach file' }, '📎');
  const fileInput = el('input', { type: 'file', hidden: true, multiple: true });
  const ta = el('textarea', { placeholder: 'Message #' + chanName, rows: 1, 'aria-label': 'Message' });
  const sendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Send');
  const emojiBtn = el('button', { class: 'emoji-btn', type: 'button', title: 'Emoji', 'aria-label': 'Insert emoji' }, '☺');
  emojiBtn.addEventListener('click', () => showEmojiPicker(emojiBtn, (e) => insertAtCursor(ta, e)));
  composer.appendChild(fileBtn);
  composer.appendChild(fileInput);
  composer.appendChild(ta);
  composer.appendChild(el('div', { class: 'composer-actions' }, emojiBtn, sendBtn));
  conv.appendChild(composer);
  {
    const me = State.me;
    const locked = !can('SEND_MESSAGES') ? 'You do not have permission to send messages here.'
      : mustVerifyToPost() ? 'Verify your email to send messages.' : null;
    if (locked) {
      ta.disabled = true;
      ta.placeholder = locked;
      sendBtn.disabled = true;
      fileBtn.disabled = true;
      emojiBtn.disabled = true;
      composer.classList.add('locked');
    }
  }

  let pending = [];
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    for (const f of files) {
      if (f.size > 8 * 1024 * 1024) { toast('File too large: ' + f.name, 'error'); continue; }
      try {
        const res = await Api.uploadAttachment(channelId, f);
        pending.push(res.attachment.id);
        toast('Uploaded ' + f.name, 'ok');
      } catch (ex) { toast(ex.message || 'Upload failed', 'error'); }
    }
    fileInput.value = '';
  });

  function resize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }
  ta.addEventListener('input', resize);

  // must not produce two real messages. Mirrors the DM sendLock.
  let sending = false;
  let pendingNonce = null;
  async function send() {
    if (sending) return;
    const content = ta.value.trim();
    if (!content && !pending.length) return;
    if (!content) { toast('Add a message or file', 'warn'); return; }
    sending = true;
    sendBtn.setAttribute('aria-busy', 'true');
    // succeeds. If the POST times out we do not know whether the server
    // resolves it to the original message instead of writing a second one.
    const clientNonce = pendingNonce || newNonce();
    pendingNonce = clientNonce;
    const attachmentIds = pending.length ? pending.slice() : undefined;
    try {
      const saved = await Api.sendMessage(channelId, { content, attachmentIds, clientNonce });
      pendingNonce = null;
      ta.value = '';
      pending = [];
      resize();
      if (saved && saved.id) {
        upsertMessage(saved, { scroll: true });
      } else {
        await reload();
      }
    } catch (ex) {
      toast(ex.message || 'Cannot send', 'error');
    } finally {
      sending = false;
      sendBtn.removeAttribute('aria-busy');
    }
  }
  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  container.appendChild(conv);
  setActiveChannel(channelId);
  await reload();
  Realtime.join(channelId);

  // absorbed: an id already in the feed is replaced, never duplicated.
  function upsertMessage(m, opts = {}) {
    if (loadingHistory) {
      if (m && m.id) pendingLive.set(String(m.id), m);
      return;
    }
    const sel = '[data-message-id="' + m.id + '"]';
    if (m.pinned) pinState.set(String(m.id), true);
    const node = messageRow(m, {
      meId: State.me && State.me.id,
      onEdit: () => editMsg(m), onDelete: () => deleteMsg(m), onDownload: downloadAtt,
      onReact: (emoji, mine) => toggleReaction(m.id, emoji, mine),
      onHover: (action, anchor) => {
        if (action === 'react') {
          showEmojiPicker(anchor, (emoji) => toggleReaction(m.id, emoji, false));
          return;
        }
        const r = anchor.getBoundingClientRect();
        openMsgMenu(r.left, r.bottom + 4, m, State.me && String(m.author_id) === String(State.me.id));
      },
    });
    stampMsgNode(node, m);
    const prev = feed.querySelector(sel);
    if (prev) {
      prev.replaceWith(node);
    } else {
      // commit out of order (especially on MySQL, where the pool does real
      // deliberately delivers strictly-newer messages that may have been
      const seq = typeof m.seq === 'number' ? m.seq : null;
      const anchor = seq === null ? null : findInsertionPoint(seq);
      if (anchor) feed.insertBefore(node, anchor);
      else feed.appendChild(node);
      if (opts.scroll !== false && isNearBottom(thread)) {
        thread.scrollTop = thread.scrollHeight;
      }
    }
    noteSeq(m);
    regroupAround(prev ? node : (node.previousElementSibling || node));
  }

  function findInsertionPoint(seq) {
    const nodes = feed.querySelectorAll(':scope > .msg');
    for (let i = nodes.length - 1; i >= 0; i--) {
      const s = Number(nodes[i].dataset.seq);
      if (Number.isFinite(s) && s > seq) return nodes[i];
    }
    return null;
  }

  function isNearBottom(el, slack = 120) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
  }
  const offMsg = Realtime.on('message', (m) => {
    if (String(m.channel_id) === String(channelId)) upsertMessage(m);
  });
  const offUpd = Realtime.on('message_updated', (m) => {
    if (String(m.channel_id) === String(channelId)) upsertMessage(m);
  });
  const offDel = Realtime.on('message_deleted', (m) => {
    if (String(m.channel_id) === String(channelId)) {
      const node = feed.querySelector('[data-message-id="' + m.id + '"]');
      if (node) {
        const body = node.querySelector('.msg-body');
        if (!body) return;
        clear(body);
        node.classList.add('deleted');
        body.appendChild(el('div', { class: 'msg-text' }, 'Message deleted'));
      }
    }
  });

  const offOpen = Realtime.on('open', () => {
    if (String(currentActiveChannel()) !== String(channelId)) return;
    reload().then(() => catchUp()).catch(() => {});
  });

  const offPin = Realtime.on('message_pinned', (m) => {
    if (String(m.channel_id) === String(channelId)) patchEngagement(m.id, { pinned: true });
  });
  const offUnpin = Realtime.on('message_unpinned', (m) => {
    if (String(m.channel_id) === String(channelId)) patchEngagement(m.id, { pinned: false });
  });
  const offReact = Realtime.on('message_reaction', (m) => {
    if (String(m.channel_id) === String(channelId)) patchEngagement(m.id, { reactions: m.reactions });
  });

  // jump-to-message. Lives and dies with this view; Escape closes.
  let searchPanel = null;
  function toggleSearchPanel() {
    if (searchPanel) { searchPanel.remove(); searchPanel = null; return; }
    const panel = el('div', { class: 'search-panel', role: 'dialog', 'aria-label': 'Search messages' });
    const input = el('input', { class: 'input', type: 'search', placeholder: 'Search in ' + (server.name || 'this community') + '…', 'aria-label': 'Search messages' });
    const status = el('div', { class: 'muted small', 'aria-live': 'polite' }, 'Type at least 2 characters.');
    const results = el('div', { class: 'search-results' });
    const closeBtn = el('button', { class: 'btn ghost sm', type: 'button' }, 'Close');
    closeBtn.addEventListener('click', () => { panel.remove(); searchPanel = null; });
    panel.append(input, status, results, closeBtn);
    conv.appendChild(panel);
    searchPanel = panel;
    input.focus();
    let timer = null;
    let seq = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) {
        clear(results);
        status.textContent = 'Type at least 2 characters.';
        return;
      }
      status.textContent = 'Searching…';
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const hits = await Api.search(q, { serverId, limit: 25 });
          if (mine !== seq || !searchPanel) return;
          clear(results);
          if (!hits.length) { status.textContent = 'No messages found.'; return; }
          status.textContent = hits.length + ' result' + (hits.length === 1 ? '' : 's') + '.';
          for (const h of hits) {
            const dest = '#/server/' + h.server_id + '/channel/' + h.channel_id;
            // can never disagree about where a result goes.
            const jump = () => {
              panel.remove(); searchPanel = null;
              const cur = '#/server/' + serverId + '/channel/' + channelId;
              if (dest === cur) {
                const node = feed.querySelector('[data-message-id="' + h.id + '"]');
                if (node) {
                  node.scrollIntoView({ block: 'center' });
                  node.classList.add('flash');
                  setTimeout(() => node.classList.remove('flash'), 1600);
                  return;
                }
              }
              location.hash = dest;
            };
            const row = el('button', { class: 'search-hit', type: 'button' });
            attachContextMenu(row, () => [
              { label: 'Jump to message', onSelect: jump },
              { sep: true },
              { label: 'Copy message text', onSelect: () => copyText(String(h.content || ''), 'Message copied.') },
              { label: 'Copy message link', onSelect: () => copyText(
                TrycordConfig.backendUrl().replace(/\/+$/, '') + '/' + dest.replace(/^#\//, ''), 'Message link copied.') },
              { sep: true },
              { label: 'Report message', danger: true, onSelect: () => openReportDialog({
                targetType: 'message',
                targetId: h.id,
                title: 'Report message',
                onSubmit: ({ category, extra }) => Api.reportContent('message', h.id, category, extra || undefined),
              }) },
            ], { target: () => ({ type: 'message', id: String(h.id) }) });
            row.appendChild(el('div', { class: 'search-hit__meta' },
              '#' + (h.channel_name || 'channel') + ' · ' + (h.author_display || h.author_name || 'Unknown') + ' · ' + relTime(h.created_at)));
            row.appendChild(el('div', { class: 'search-hit__text' }, String(h.content || '').slice(0, 160)));
            row.addEventListener('click', jump);
            results.appendChild(row);
          }
        } catch (ex) {
          if (mine !== seq || !searchPanel) return;
          status.textContent = ex.message || 'Search failed.';
        }
      }, 300);
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { panel.remove(); searchPanel = null; }
    });
  }

  const onScroll = () => {
    if (thread.scrollTop <= 80) loadOlder().catch(() => {});
  };
  thread.addEventListener('scroll', onScroll, { passive: true });

  const cleanup = () => {
    offMsg(); offUpd(); offDel(); offOpen(); offPin(); offUnpin(); offReact();
    thread.removeEventListener('scroll', onScroll);
    if (searchPanel) { searchPanel.remove(); searchPanel = null; }
    Realtime.leaveChannel();
    setActiveChannel(null);
  };
  container._cleanup = cleanup;
  setViewRefresh(() => {
    const layout = State.channels || { channels: [] };
    const ch = (layout.channels || []).find((c) => String(c.id) === String(channelId));
    if (!ch) { location.hash = '#/server/' + serverId; return; }
    renderContextHeader({ title: '#' + (ch.name || 'channel'), sub: ch.topic ? esc(ch.topic) : server.name, icon: '#' });
  });
  renderAllChrome();
}


async function renderChannelPins(container, serverId, channelId) {
  clear(container);
  let server = State.serverDetail;
  try {
    if (String(State.lastServerId) !== String(serverId) || !server) {
      const { detail } = await ensureServer(serverId);
      server = detail;
    }
  } catch (ex) {
    renderContextHeader({ title: 'Unavailable' });
    container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this server'));
    return;
  }
  const layout = State.channels;
  const channel = (layout.channels || []).find((c) => String(c.id) === String(channelId));
  const back = el('button', { class: 'btn ghost sm', type: 'button' }, '← Back to #' + (channel ? channel.name : 'channel'));
  back.addEventListener('click', () => { location.hash = '#/server/' + serverId + '/channel/' + channelId; });
  renderContextHeader({ title: 'Pinned messages', sub: '#' + (channel ? channel.name : 'channel'), icon: '☆', actions: [back] });
  const wrap = el('div', { class: 'page atrium' });
  const list = el('div', { class: 'stack' });
  wrap.appendChild(list);
  container.appendChild(wrap);
  const paint = async () => {
    clear(list);
    let pins = [];
    try {
      pins = await Api.listPins(serverId, channelId);
    } catch (ex) {
      list.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load pins'));
      return;
    }
    if (!pins.length) {
      list.appendChild(emptyState('☆', 'No pinned messages', 'Pin important messages to find them here.'));
      return;
    }
    for (const m of pins) {
      const node = messageRow(m, {
        meId: State.me && State.me.id,
        onReact: (emoji, mine) => togglePinReaction(channelId, m.id, emoji, mine),
      });
      node.style.cursor = 'pointer';
      node.title = 'Jump to message';
      node.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        location.hash = '#/server/' + serverId + '/channel/' + channelId;
      });
      list.appendChild(node);
    }
  };
  const offPin = Realtime.on('message_pinned', (m) => {
    if (String(m.channel_id) === String(channelId)) paint().catch(() => {});
  });
  const offUnpin = Realtime.on('message_unpinned', (m) => {
    if (String(m.channel_id) === String(channelId)) paint().catch(() => {});
  });
  container._cleanup = () => { offPin(); offUnpin(); Realtime.leaveChannel(); };
  Realtime.join(channelId);
  setViewRefresh(() => { paint().catch(() => {}); });
  await paint();
  renderAllChrome();
}

async function togglePinReaction(channelId, messageId, emoji, mine) {
  try {
    if (mine) await Api.removeReaction(channelId, messageId, emoji);
    else await Api.addReaction(channelId, messageId, emoji);
  } catch (ex) { toast(ex.message || 'Could not react.', 'error'); }
}


export { renderChannel, renderChannelPins };
