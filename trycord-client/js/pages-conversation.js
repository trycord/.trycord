// A text channel: history, composer, attachments, reactions, pins.
//
// Split out of the former pages-workspace.js. This is the single largest view
// in the client and it owns only the conversation surface.
import Api from './api.js';
import State from './state.js';
import Realtime from './realtime.js';

import { can, currentServerId, isMuted, mustVerifyToPost, refreshMutes, setMuted, setViewRefresh } from './state.js';
import { clear, confirmDialog, copyText, el, esc, insertAtCursor, openReportDialog, relTime, showContextMenu, attachContextMenu, showEmojiPicker, toast } from './ui.js';
import { emptyState, messageRow, paintReactions } from './components.js';
import { membersHidden, renderAllChrome, renderContextHeader, toggleMembers } from './shell.js';
import { currentActiveChannel, ensureServer, pickReaction, setActiveChannel } from './workspace-shared.js';
import { TrycordConfig } from './config.js';

async function renderChannel(container, serverId, channelId) {
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
  // Mute state for the header bell (one cheap read per channel open).
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
      // Reuses the sidebar community menu — one menu, two entry points.
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

  // How many messages one page of history is. The initial load takes one
  // page; older pages are fetched on demand (see loadOlder). Must match the
  // server's clamp in trycord-server/src/routes/messages.js.
  const HISTORY_PAGE = 50;

  // Channel intro block: always tops the feed (scrolls away with
  // history), doubled as the empty state when there is nothing yet.
  function channelIntro(withCta) {
    const box = el('div', { class: 'channel-intro' }, el('div', { class: 'channel-intro__mark' }, '#'));
    box.setAttribute('data-intro', '1');
    box.appendChild(el('h2', { class: 'channel-intro__title' }, 'Welcome to #' + chanName));
    box.appendChild(el('p', { class: 'channel-intro__sub' },
      (channel && channel.topic) ? channel.topic : 'This is the beginning of the conversation.'));
    if (withCta) box.appendChild(el('p', { class: 'channel-intro__cta' }, 'Send the first message below.'));
    return box;
  }

  // ---- history ----
  // Highest and lowest seq currently painted. These are the cursors for
  // both directions: `after` fills a reconnect gap, `before` pages back.
  let highSeq = 0;
  let lowSeq = 0;
  let historyExhausted = false;
  let loadingOlder = false;

  const noteSeq = (m) => {
    if (!m || typeof m.seq !== 'number') return;
    if (m.seq > highSeq) highSeq = m.seq;
    if (!lowSeq || m.seq < lowSeq) lowSeq = m.seq;
  };

  // Prepend one older page. Anchor-based: capture the scroll height before
  // inserting, then restore the offset afterwards, so the message the user
  // was reading stays put instead of the viewport jumping.
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
        // A short page means we have reached the beginning of the channel.
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
        // Keep the reader anchored to the same message.
        threadEl.scrollTop = prevTop + (threadEl.scrollHeight - prevHeight);
      }
      if (fresh.length < HISTORY_PAGE) historyExhausted = true;
    } catch {
      /* offline: keep what we have, allow a retry on the next scroll */
    } finally {
      loadingOlder = false;
    }
  }

  // Fill a gap after a reconnect: ask only for what is newer than the highest
  // message we have. This is the difference between "recovered" and
  // "silently missing N messages" after any network interruption.
  async function catchUp() {
    if (!highSeq) return;
    try {
      const missed = await Api.messages(channelId, { after: highSeq, limit: HISTORY_PAGE });
      if (!Array.isArray(missed) || !missed.length) return;
      for (const m of missed) upsertMessage(m, { scroll: false });
    } catch { /* offline: the next reconnect will try again */ }
  }

  // Live messages that arrive while a reload is in flight. The reload
  // clears the feed after its fetch resolves, and the snapshot was taken
  // before those messages were committed, so anything that arrived during
  // the await used to be appended and then wiped - a permanent hole in the
  // conversation. Buffer them here and replay after the snapshot paints.
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
    // A newer reload started while this one was fetching: let it win, or the
    // two would paint in whatever order the network happened to answer.
    if (seq !== reloadSeq) return;
    loadingHistory = false;
    highSeq = 0;
    lowSeq = 0;
    historyExhausted = false;
    clear(feed);
    feed.appendChild(channelIntro(msgs.length === 0));
    for (const m of msgs) { noteSeq(m); feed.appendChild(buildMsg(m)); }
    groupFeed(feed);
    // Replay whatever streamed in behind the snapshot, so no message that
    // arrived during the fetch is lost.
    const late = [...pendingLive.values()];
    pendingLive.clear();
    for (const m of late) upsertMessage(m, { scroll: false });
    thread.scrollTop = thread.scrollHeight;
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
  // Per-view pin state (id -> bool), seeded from payloads and kept fresh
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
  // Patch a rendered row in place from pin/reaction events (which carry
  // summaries, not full messages). Falls back to a no-op when the row is
  // not on screen; reload() remains the authority on reconnect.
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
        // Broadcast summaries are actor-relative: re-derive `mine` for us.
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
    // The menu is built from `m` alone and bound to this node, so it cannot act
    // on a different message: the action closures capture this exact object, and
    // the node guard refuses to fire at all if the message has been removed from
    // the list between opening the menu and clicking it.
    attachContextMenu(node, () => msgActions(m, isMine), {
      target: () => ({ type: 'message', id: String(m.id) }),
    });
    return node;
  }

  // Every message action, in one place, so the right-click menu, the hover bar
  // and a touch sheet can never drift apart. Permission-shaped: an action the
  // viewer cannot perform is not offered. The server re-checks on the request.
  //
  // No "Reply" entry: messages have no parent reference anywhere in the schema,
  // so offering it would be a button that cannot work. Replies are a real
  // feature to build, not a menu row to invent.
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

  // A link that reopens this exact message. The id is the only part that
  // identifies it - never the text, the author or the timestamp.
  function msgLink(m) {
    return location.origin + '/#/server/' + currentServerId() + '/channel/' + channelId + '?m=' + encodeURIComponent(m.id);
  }

  function openMsgMenu(x, y, m, isMine) {
    showContextMenu(x, y, msgActions(m, isMine), {
      target: { type: 'message', id: String(m.id) },
    });
  }

  // Continuous-conversation grouping: same author, <5 min apart, later
  // message collapses to avatar-space + body. Pure CSS class on top of
  // the existing rows; actions stay reachable via :hover/:focus-within.
  // Idempotency key for a send attempt. crypto.randomUUID is available in
  // every context this app runs in (https and the packaged file:// app);
  // the fallback keeps it working if that ever stops being true.
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
      // Canonical order, read back by findInsertionPoint() so a message
      // that arrives out of order is placed correctly instead of appended.
      if (m && typeof m.seq === 'number') node.dataset.seq = String(m.seq);
    } catch { /* grouping metadata is decorative */ }
  }

  // Grouping is a whole-feed sweep that used to run on every single
  // incoming message: N nodes, two Date.parse() string conversions per
  // node, one classList.toggle per node. That made the cost of receiving
  // one message grow linearly with how long you had been sitting in the
  // channel, and Date.parse is roughly an order of magnitude more
  // expensive than the arithmetic comparison it feeds.
  //
  // Grouping is purely local: a message's group state depends only on it
  // and on its immediate neighbours. So after an insert or replace we
  // recompute the touched node and the two adjacent to it, which is
  // O(1) and produces byte-identical classes to the full sweep.
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

  // Recompute a node plus its immediate neighbours. Used after any insert
  // or replace, where only the local window can have changed.
  function regroupAround(node) {
    applyGrouping(node);
    if (node && node.previousElementSibling) applyGrouping(node.previousElementSibling);
    const next = node && node.nextElementSibling;
    if (next) applyGrouping(next);
  }

  // Full sweep, for initial render and pagination only.
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

  // ---- composer ----
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
  // Locked composer states mirror the server gates (which remain
  // authoritative): no SEND_MESSAGES, or unverified email.
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

  // In-flight send lock (F3): double-Enter while the POST is pending
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
    // One nonce per submission attempt, held until the send definitively
    // succeeds. If the POST times out we do not know whether the server
    // committed it, so the user's next attempt reuses this key and the server
    // resolves it to the original message instead of writing a second one.
    // A fresh nonce is minted only after a confirmed success.
    const clientNonce = pendingNonce || newNonce();
    pendingNonce = clientNonce;
    const attachmentIds = pending.length ? pending.slice() : undefined;
    try {
      const saved = await Api.sendMessage(channelId, { content, attachmentIds, clientNonce });
      pendingNonce = null;
      ta.value = '';
      pending = [];
      resize();
      // Paint the confirmed message directly instead of refetching the whole
      // page: the server already returned the authoritative row, including
      // its seq. reload() was a full clear+refetch after every send.
      if (saved && saved.id) {
        upsertMessage(saved, { scroll: true });
      } else {
        await reload();
      }
    } catch (ex) {
      // Keep the nonce and the composer text: retrying must be safe.
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

  // Live updates. Every insert/update is reconciled by authoritative
  // message id: the sender's own POST already appears via reload(), and
  // the server broadcast reaches the sender too — blind appends would
  // render each own message twice (F2). Reconnect replays are also
  // absorbed: an id already in the feed is replaced, never duplicated.
  function upsertMessage(m, opts = {}) {
    // A history load is mid-flight. Painting now would be undone by its
    // clear(), so hold the message and let reload() replay it against the
    // fresh snapshot instead of losing it.
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
      // Insert at the position the server's sequence dictates, not blindly
      // at the bottom. Broadcast order is not message order: two writers can
      // commit out of order (especially on MySQL, where the pool does real
      // I/O between the write and the broadcast), and a reconnect catch-up
      // deliberately delivers strictly-newer messages that may have been
      // authored before something already on screen. Appending those would
      // permanently show the conversation out of order until the next
      // full reload.
      const seq = typeof m.seq === 'number' ? m.seq : null;
      const anchor = seq === null ? null : findInsertionPoint(seq);
      if (anchor) feed.insertBefore(node, anchor);
      else feed.appendChild(node);
      if (opts.scroll !== false && isNearBottom(thread)) {
        thread.scrollTop = thread.scrollHeight;
      }
    }
    noteSeq(m);
    // Local regroup only - see regroupAround. This used to be
    // groupFeed(feed), an O(N) sweep per received message.
    regroupAround(prev ? node : (node.previousElementSibling || node));
  }

  // First painted message whose seq is greater than the one being inserted.
  // The feed is kept in ascending seq order, so this is a short walk from the
  // end rather than a scan of the whole conversation.
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

  // Reconnect resync (F4): the gateway re-joins this channel on `open`,
  // then reload() pulls everything missed while offline. reload() is
  // authoritative (clear + refetch), and live events reconcile by id, so
  // the resync cannot duplicate state.
  // On reconnect: refresh the page of history, then fill anything newer than
  // what we already hold. The refresh alone is not enough - it re-fetches the
  // newest page, so a burst larger than one page that arrived while offline
  // would still leave a hole at the top of the conversation.
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

  // Search panel (reference ⌕ pattern): debounced community search with
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
            // One jump routine, used by both the click and the menu, so the two
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
            // A hit is a message, so it gets the same per-message actions the
            // message row itself offers, plus the ones that only make sense for
            // a result you have not navigated to yet: copy the text or the link
            // without leaving the search.
            attachContextMenu(row, () => [
              { label: 'Jump to message', onSelect: jump },
              { sep: true },
              { label: 'Copy message text', onSelect: () => copyText(String(h.content || ''), 'Message copied.') },
              { label: 'Copy message link', onSelect: () => copyText(
                TrycordConfig.backendUrl().replace(/\/+$/, '') + '/' + dest.replace(/^#\//, ''), 'Message link copied.') },
              { sep: true },
              { label: 'Report message', danger: true, onSelect: () => openReportDialog({
                kind: 'message', messageId: h.id, reason: 'Other',
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

  // Clean up when the route changes
  // Page in older history when the reader reaches the top of the thread.
  // Guarded so a fast scroll cannot fire a burst of overlapping requests, and
  // removed in cleanup() so a closed view leaves nothing attached to the
  // document.
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
  // Structural realtime events refresh state first (refreshServerView);
  // this hook then reconciles the open conversation: retitle on rename,
  // leave the view if the channel is gone.
  setViewRefresh(() => {
    const layout = State.channels || { channels: [] };
    const ch = (layout.channels || []).find((c) => String(c.id) === String(channelId));
    if (!ch) { location.hash = '#/server/' + serverId; return; }
    renderContextHeader({ title: '#' + (ch.name || 'channel'), sub: ch.topic ? esc(ch.topic) : server.name, icon: '#' });
  });
  renderAllChrome();
}

// ---- community management surfaces ----------------------------------------

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

// Interim menu page: with the mobile drawer removed, small screens need
// a single surface reaching servers, channels, friends, notifications
// and admin. Plain list reusing existing rows; replaced wholesale when
// the new drawer lands.

export { renderChannel, renderChannelPins };
