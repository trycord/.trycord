import Api from './api.js';
import { loadingState } from './states.js';
import State from './state.js';
import Realtime from './realtime.js';

import { can, canInChannel, isMuted, mustVerifyToPost, refreshMutes, setChannelPermissions, setMuted, setViewRefresh } from './state.js';
import { clear, confirmDialog, copyText, el, esc, insertAtCursor, openReportDialog, relTime, showContextMenu, attachContextMenu, showEmojiPicker, toast } from './ui.js';
import { downloadAttachment, emptyState, icon, messageRow, paintReactions } from './components.js';
import { createAttachTray } from './attach-tray.js';
import { paintEmbeds, wireEmbedImages } from './embeds.js';
import { applyReplyCount, createReplyCounts, createThread } from './thread.js';
import { membersHidden, renderAllChrome, renderContextHeader, toggleMembers } from './shell.js';
import { currentActiveChannel, ensureServer, pickReaction, setActiveChannel } from './workspace-shared.js';
import { TrycordConfig } from './config.js';
import { serverPath, channelPath, absoluteChannelUrl } from './links.js';
import { navigate } from './nav.js';
import { presentationMode } from './presentation.js';

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
    container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community'));
    return;
  }

  const layout = State.channels;
  const channel = (layout.channels || []).find((c) => String(c.id) === String(channelId));
  const chanName = channel ? channel.name : 'channel';
  const memberToggle = el('button', {
    class: 'btn icon member-toggle', type: 'button',
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
  }, icon('menu'));
  // The server's own channel-scoped permission answer for this viewer. Fetched
  // per channel because an override on this channel, or on its category, is
  // invisible to the community-level list the composer used to consult.
  try {
    const ov = await Api.channelOverrides(serverId, channelId);
    setChannelPermissions(ov && Array.isArray(ov.effective) ? ov.effective : null);
  } catch { setChannelPermissions(null); /* fall back to community-level */ }
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
        btn.textContent = now ? '⊘' : '◉';
        btn.title = now ? 'Unmute this channel' : 'Mute this channel';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', now ? 'true' : 'false');
        toast(now ? 'Channel muted.' : 'Channel unmuted.', 'ok');
      } catch (ex) { toast(ex.message || 'Could not change mute.', 'error'); }
    },
  }, muted ? '⊘' : '◉');
  const searchBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Search in this community', 'aria-label': 'Search messages',
    onClick: () => toggleSearchPanel(),
  }, icon('search'));
  const pinsBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Pinned messages', 'aria-label': 'Pinned messages',
    onClick: () => { navigate(channelPath(serverId, channelId, '/pins')); },
  }, icon('star'));
  const moreBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Community actions', 'aria-label': 'Community actions',
    onClick: () => {
      const menu = document.querySelector('#place-navigation .place-header__menu');
      if (menu) menu.click();
    },
  }, icon('more'));
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
    feed.appendChild(loadingState('Loading messages'));
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
  const replyCounts = createReplyCounts();
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
      if (pinned && head && !badge) head.appendChild(el('span', { class: 'msg-pinned', title: 'Pinned message' }, icon('flag')));
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
    // Seed the reply count from history. A realtime event carries no count, so
    // without this the store would start a root at zero and its badge would sit
    // one behind for the rest of the view.
    m.reply_count = replyCounts.get(m);
    const node = messageRow(m, {
      meId,
      onEdit: () => editMsg(m),
      onDelete: () => deleteMsg(m),
      onDownload: (e, att) => downloadAtt(e, att),
      onOpenThread: () => openThread(m),
      onReact: (emoji, mine) => toggleReaction(m.id, emoji, mine),
      onHover: (action, anchor) => {
        if (action === 'react') {
          showEmojiPicker(anchor, (emoji) => toggleReaction(m.id, emoji, false));
          return;
        }
        if (presentationMode() === 'mobile') toggleInlineActions(node, anchor, m, isMine);
        else openMsgMenu(anchor, m, isMine);
      },
    });
    stampMsgNode(node, m);
    attachContextMenu(node, () => msgActions(m, isMine), {
      target: () => ({ type: 'message', id: String(m.id) }),
      // The press is kept on touch - it is the only quick way to reach a
      // message's actions on a phone - but on a phone it expands them in place
      // rather than opening a sheet over the conversation.
      onLongPress: (target) => {
        if (presentationMode() !== 'mobile') return;
        const btn = target.querySelector('.msg-hoverbar button:last-of-type');
        toggleInlineActions(target, btn, m, isMine);
      },
    });
    return node;
  }

  // and a touch sheet can never drift apart. Permission-shaped: an action the
  function msgActions(m, isMine) {
    const authorName = m.author_display || m.author_name || m.user || 'Unknown';
    const pinned = pinState.get(String(m.id)) ?? !!m.pinned;
    return [
      { label: 'Add reaction', onSelect: () => pickReaction(m.id) },
      { label: 'Reply in thread', onSelect: () => openThread(m) },
      { sep: true },
      ...(m.content ? [{ label: 'Copy text', onSelect: () => copyText(m.content, 'Message copied.') }] : []),
      { label: 'Copy message link', onSelect: () => copyText(msgLink(m), 'Message link copied.') },
      { label: 'Copy message ID', onSelect: () => copyText(String(m.id), 'Message ID copied.') },
      ...(m.author_id ? [{ label: 'View profile', desc: authorName, onSelect: () => { navigate('/users/' + m.author_id); } }] : []),
      ...((can('MANAGE_MESSAGES') || isMine) ? [{ sep: true }] : []),
      ...(isMine ? [{ label: 'Edit message', onSelect: () => editMsg(m) }] : []),
      ...(canInChannel('MANAGE_MESSAGES') ? [{ label: pinned ? 'Unpin message' : 'Pin message', onSelect: () => togglePin(m) }] : []),
      { label: 'Report message', onSelect: () => openReportModal(m) },
      ...((can('MANAGE_MESSAGES') || isMine) ? [{ label: 'Delete message', danger: true, onSelect: () => deleteMsg(m) }] : []),
    ];
  }

  // identifies it - never the text, the author or the timestamp.
  //
  // serverId is the community this conversation was opened in, not
  // currentServerId(): the latter is whatever community was entered last, so a
  // permalink copied after switching communities pointed at a channel id
  // belonging to a different one - a link that either 404s or, when slugs
  // collide across communities, resolves somewhere the author never intended.
  function msgLink(m) {
    return absoluteChannelUrl(serverId, channelId, m.id);
  }

  // Opened from the trigger, not from a point. Passing the anchor lets the menu
  // use the shared placement rule, which flips above the button when there is
  // no room below, and lets the trigger record aria-expanded for as long as the
  // menu is open. Handing it raw coordinates instead anchored nothing, so the
  // menu opened beside the button rather than under it and the button never
  // announced that it was open.
  function openMsgMenu(anchor, m, isMine) {
    showContextMenu(0, 0, msgActions(m, isMine), {
      target: { type: 'message', id: String(m.id) },
      under: anchor,
    });
  }

  // On a phone the actions belong to the message, not on top of the
  // conversation. Same items and same handlers, laid out in place underneath the
  // message they act on: nothing to dismiss, nothing to mis-tap, and the
  // surrounding messages do not move. Deliberately not a menu - no overlay, no
  // scrim, no placement - because a sheet that covers the conversation to offer
  // things about the conversation is worse than showing them.
  function toggleInlineActions(node, anchor, m, isMine) {
    const existing = node.querySelector('.msg-inline-actions');
    if (existing) { existing.remove(); anchor.setAttribute('aria-expanded', 'false'); return; }

    const panel = el('div', { class: 'msg-inline-actions', role: 'group', 'aria-label': 'Message actions' });
    for (const it of msgActions(m, isMine)) {
      if (it.sep) { panel.appendChild(el('span', { class: 'msg-inline-actions__sep' })); continue; }
      if (it.heading) { panel.appendChild(el('span', { class: 'msg-inline-actions__heading' }, it.heading)); continue; }
      // A submenu has nowhere to go in a flat list, so it is not offered here.
      // The desktop menu still has it.
      if (it.items && it.items.length) continue;
      const b = el('button', {
        type: 'button',
        class: 'msg-inline-actions__item' + (it.danger ? ' is-danger' : ''),
        disabled: it.disabled ? true : null,
        'aria-disabled': it.disabled ? 'true' : null,
      }, it.label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.remove();
        anchor.setAttribute('aria-expanded', 'false');
        if (typeof it.onSelect === 'function') it.onSelect();
      });
      panel.appendChild(b);
    }
    if (!panel.children.length) return;
    node.appendChild(panel);
    anchor.setAttribute('aria-expanded', 'true');
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
    e.preventDefault();
    try {
      await downloadAttachment(att);
    } catch (ex) { toast(ex.message || 'Cannot download', 'error'); }
  }


  const composer = el('div', { class: 'composer' });
  const fileBtn = el('button', { class: 'file-btn', type: 'button', title: 'Attach file', 'aria-label': 'Attach file' }, icon('paperclip'));
  const fileInput = el('input', { type: 'file', hidden: true, multiple: true });
  const ta = el('textarea', { placeholder: 'Message #' + chanName, rows: 1, 'aria-label': 'Message' });
  const sendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Send');
  const emojiBtn = el('button', { class: 'emoji-btn', type: 'button', title: 'Emoji', 'aria-label': 'Insert emoji' }, icon('smile'));
  emojiBtn.addEventListener('click', () => showEmojiPicker(emojiBtn, (e) => insertAtCursor(ta, e)));
  const attachments = createAttachTray({
    upload: (file, onProgress) => Api.uploadAttachmentWithProgress(channelId, file, onProgress),
    onChange: () => { sendBtn.disabled = !attachments.hasReady() && !ta.value.trim(); },
  });
  // Suppress previews for the next message. The flag travels with the send and
  // the server decides what to do with it, so this cannot drift into a control
  // that only changes how the composer looks.
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

  composer.appendChild(fileBtn);
  composer.appendChild(fileInput);
  composer.appendChild(ta);
  composer.appendChild(el('div', { class: 'composer-actions' }, previewOff, emojiBtn, sendBtn));
  // The tray is a sibling of the composer rather than a flex child of it: as a
  // child it competed with the textarea for the line and collapsed to nothing on
  // a phone.
  conv.appendChild(el('div', { class: 'composer-dock' }, attachments.node, composer));
  {
    const me = State.me;
    const locked = !canInChannel('SEND_MESSAGES') ? 'You do not have permission to send messages here.'
      : mustVerifyToPost() ? 'Verify your email to send messages.' : null;
    if (locked) {
      ta.disabled = true;
      ta.placeholder = locked;
      sendBtn.disabled = true;
      fileBtn.disabled = true;
      emojiBtn.disabled = true;
      previewOff.disabled = true;
      composer.classList.add('locked');
    }
  }

  attachments.attach({ container: conv, composer, textarea: ta, button: fileBtn, input: fileInput });

  function resize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }
  ta.addEventListener('input', () => { resize(); sendBtn.disabled = !attachments.hasReady() && !ta.value.trim(); });

  // A double submit must not produce two real messages. Mirrors the DM sendLock.
  let sending = false;
  let pendingNonce = null;
  async function send() {
    if (sending) return;
    const content = ta.value.trim();
    // Only files that finished uploading can go on the message. Sending while
    // one is still in flight would attach nothing for it and silently drop it.
    const readyIds = attachments.readyIds();
    if (!content && !readyIds.length) {
      if (attachments.isUploading()) { toast('Still uploading', 'warn'); return; }
      return;
    }
    sending = true;
    sendBtn.setAttribute('aria-busy', 'true');
    // One nonce per attempt, reused across a retry of the same attempt. If the
    // POST times out we cannot tell whether the server wrote the message, so the
    // nonce is what stops a retry from posting it twice.
    const clientNonce = pendingNonce || newNonce();
    pendingNonce = clientNonce;
    const attachmentIds = readyIds.length ? readyIds : undefined;
    try {
      const suppressEmbeds = previewOff.getAttribute('aria-pressed') === 'true';
      const saved = await Api.sendMessage(channelId, {
        content, attachmentIds, clientNonce, suppressEmbeds: suppressEmbeds || undefined,
      });
      pendingNonce = null;
      // The choice is about one message, so it does not stick to the next one.
      if (suppressEmbeds) {
        previewOff.setAttribute('aria-pressed', 'false');
        previewOff.classList.remove('is-on');
      }
      ta.value = '';
      attachments.clear();
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

  // An id already in the feed is replaced, never duplicated - which is what
  // makes this safe to call from both the REST response and the realtime echo.
  function upsertMessage(m, opts = {}) {
    // Before the row is built: a realtime event has no count of its own.
    m.reply_count = replyCounts.get(m);
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
        const mine = State.me && String(m.author_id) === String(State.me.id);
        if (presentationMode() === 'mobile') toggleInlineActions(node, anchor, m, mine);
        else openMsgMenu(anchor, m, mine);
      },
    });
    stampMsgNode(node, m);
    const prev = feed.querySelector(sel);
    if (prev) {
      prev.replaceWith(node);
    } else {
      // Realtime and history can commit out of order, especially on MySQL
      // where the pool does real concurrent writes, so position by seq when we
      // have it and append when we don't.
      const seq = typeof m.seq === 'number' ? m.seq : null;
      const anchor = seq === null ? null : findInsertionPoint(seq);
      if (anchor) feed.insertBefore(node, anchor);
      else feed.appendChild(node);
      if (opts.scroll !== false && isNearBottom(thread)) {
        thread.scrollTop = thread.scrollHeight;
      }
    }
    // A reply has just arrived for some other message: move that message's
    // badge, if it is on screen. Only for a row that was not already here -
    // replacing a row we already counted would count the same reply twice.
    if (!prev && m.thread_root_id && String(m.thread_root_id) !== String(m.id)) {
      const n = replyCounts.noted(m.thread_root_id);
      if (n !== null) applyReplyCount(m.thread_root_id, n, () => openThread(m.thread_root_id));
    }
    noteSeq(m);
    regroupAround(prev ? node : (node.previousElementSibling || node));
  }

  // One thread open at a time. Expanding a second one closes the first rather
  // than stacking: two inline blocks in one feed is unreadable on a phone, and
  // the reader opened a thread to read it, not to compare two.
  //
  // Takes the root's id rather than the message, because a badge only has a
  // count. The message is a convenience - it lets the panel show the root before
  // the request returns - and the server's copy wins anyway.
  let openThreadId = null;
  function openThread(m) {
    const id = m && m.id !== undefined ? m.id : m;
    if (openThreadId && openThreadId !== String(id)) closeThread();
    const existing = conv.querySelector('.msg-thread');
    if (existing && openThreadId === String(id)) { closeThread(); return; }
    const row = feed.querySelector('[data-message-id="' + id + '"]');
    if (!row) return;
    const view = createThread({
      kind: 'channel', scopeId: channelId, rootId: id,
      rootMessage: m && m.id !== undefined ? m : null,
      canReply: canInChannel('SEND_MESSAGES') && !mustVerifyToPost(),
    });
    openThreadId = String(id);
    row.after(view.node);
    view.node.scrollIntoView({ block: 'nearest' });
  }
  function closeThread() {
    const node = conv.querySelector('.msg-thread');
    if (node) node.remove();
    openThreadId = null;
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
  // Previews arrive after the message they belong to, so they patch the row
  // rather than appending anything new. Dropping the event would leave the card
  // absent until the next reload.
  const offEmbeds = Realtime.on('message_embeds', (p) => {
    // Scoped by channel, not "no channel means everywhere": a frame without one
    // is a bug, and matching every channel would put one message's card on
    // another's row.
    if (String(p.channel_id) === String(channelId)) {
      const node = feed.querySelector('[data-message-id="' + p.messageId + '"]');
      const tray = node && node.querySelector('.embed-tray');
      if (!tray) return;
      paintEmbeds(tray, p.embeds);
      wireEmbedImages(tray);
    }
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
            const dest = channelPath(h.server_id, h.channel_id);
            // can never disagree about where a result goes.
            const jump = () => {
              panel.remove(); searchPanel = null;
              const cur = channelPath(serverId, channelId);
              if (dest === cur) {
                const node = feed.querySelector('[data-message-id="' + h.id + '"]');
                if (node) {
                  node.scrollIntoView({ block: 'center' });
                  node.classList.add('flash');
                  setTimeout(() => node.classList.remove('flash'), 1600);
                  return;
                }
              }
              navigate(dest);
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
    offMsg(); offUpd(); offDel(); offOpen(); offPin(); offUnpin(); offReact(); offEmbeds();
    thread.removeEventListener('scroll', onScroll);
    if (searchPanel) { searchPanel.remove(); searchPanel = null; }
    Realtime.leaveChannel();
    setActiveChannel(null);
  };
  container._cleanup = cleanup;
  setViewRefresh(() => {
    const layout = State.channels || { channels: [] };
    const ch = (layout.channels || []).find((c) => String(c.id) === String(channelId));
    if (!ch) { navigate(serverPath(serverId)); return; }
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
    container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community'));
    return;
  }
  const layout = State.channels;
  const channel = (layout.channels || []).find((c) => String(c.id) === String(channelId));
  const back = el('button', { class: 'btn ghost sm', type: 'button' }, '← Back to #' + (channel ? channel.name : 'channel'));
  back.addEventListener('click', () => { navigate(channelPath(serverId, channelId)); });
  renderContextHeader({ title: 'Pinned messages', sub: '#' + (channel ? channel.name : 'channel'), icon: 'star', actions: [back] });
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
      list.appendChild(emptyState('star', 'No pinned messages', 'Pin important messages to find them here.'));
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
        navigate(channelPath(serverId, channelId));
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
