// Server workspace: the main Environment when inside a community.
//   /server/:id                 -> landing (channel list summary)
//   /server/:id/channel/:cid    -> channel conversation
//   /server/:id/channels/new    -> create channel
//   /server/:id/invites         -> invite management
//   /server/:id/settings        -> server settings (MANAGE_SERVER)
// Plus friend-join flow for /invite/:code handled in router.

import Api from './api.js';
import State, {
  enterServer, refreshServers, leaveServerContext, can, isAuthed, currentServerId, peerPresence,
  refreshBans, setViewRefresh, refreshServerView,
} from './state.js';
import { esc, el, clear, toast, relTime, confirmDialog, openModal } from './ui.js';
import { avatar, emptyState, messageRow, channelRow } from './components.js';
import { renderContextHeader, renderAllChrome, renderCommunities, renderPlaceNavigation } from './shell.js';
import Realtime from './realtime.js';

let activeChannelId = null;

// Community realtime wiring (subscribed once — module evaluates once).
// Structural events arrive on the server room; the handler refreshes state
// (serialized, so rapid events converge) and repaints the active view via
// its refresh hook. If WE were removed, drop context and go home.
const COMMUNITY_EVENTS = [
  'member_joined', 'member_left', 'member_kicked', 'member_banned',
  'member_unbanned', 'member_timeout', 'member_updated', 'member_roles_updated',
  'role_created', 'role_updated', 'role_deleted', 'roles_reordered',
  'channel_created', 'channel_updated', 'channel_deleted', 'channels_reordered',
  'category_created', 'category_updated', 'category_deleted', 'categories_reordered',
  'invite_created', 'invite_revoked', 'server_updated',
];
const SELF_REMOVAL = new Set(['member_left', 'member_kicked', 'member_banned']);
let communityWired = false;
function wireCommunityEvents() {
  if (communityWired) return;
  communityWired = true;
  for (const type of COMMUNITY_EVENTS) {
    Realtime.on(type, async (payload) => {
      try {
        const sid = currentServerId();
        if (!sid || !isAuthed()) return;
        const me = State.me && State.me.id;
        if (me && payload && SELF_REMOVAL.has(type) && String(payload.userId) === String(me)) {
          leaveServerContext();
          renderAllChrome();
          if (!location.hash.startsWith('#/home')) location.hash = '#/home';
          toast('You were removed from that community.', 'warn');
          return;
        }
        await refreshServerView();
        renderAllChrome();
      } catch { /* realtime refresh must never break the loop */ }
    });
  }
}
wireCommunityEvents();

function ensureServer(serverId) {
  return enterServer(serverId).catch((ex) => {
    throw ex;
  });
}

async function renderServerLanding(container, serverId) {
  clear(container);
  let server;
  try {
    const { detail } = await ensureServer(serverId);
    server = detail;
  } catch (ex) {
    renderContextHeader({ title: 'Unavailable' });
    container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this server'));
    return;
  }
  renderContextHeader({ title: server.name, sub: (server.description || 'Community') + ' · ' + (server.member_count || 0) + ' members' });
  const wrap = el('div', { class: 'page atrium' });
  const onlineCount = (State.members || []).filter((m) => peerPresence(m.user_id || m.id) === 'online').length;
  const stats = el('div', { class: 'stat-inline' });
  stats.appendChild(el('span', {}, String(server.member_count || 0) + ' members · ' + String(onlineCount) + ' online'));
  stats.appendChild(el('span', {}, String(server.channel_count || 0) + ' channels'));
  stats.appendChild(el('span', {}, String(server.role_count || 0) + ' roles'));
  if (server.message_count != null) stats.appendChild(el('span', {}, String(server.message_count) + ' messages'));
  wrap.appendChild(stats);
  wrap.appendChild(el('h2', {}, 'Channels'));
  const layout = State.channels;
  const categories = layout.categories || [];
  const channels = layout.channels || [];
  if (!channels.length) {
    wrap.appendChild(emptyState('◌', 'No channels yet', 'Create a channel to get started.'));
  } else {
    for (const cat of categories) {
      const inCat = channels.filter((ch) => String(ch.category_id) === String(cat.id));
      if (!inCat.length) continue;
      wrap.appendChild(el('div', { class: 'section-label' }, cat.name));
      for (const ch of inCat) {
        const r = el('button', {
          class: 'channel-row', type: 'button', style: { marginLeft: 0, width: '100%' },
          onClick: () => { location.hash = '#/server/' + serverId + '/channel/' + ch.id; },
        });
        r.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        r.appendChild(el('span', { class: 'ch-name' }, ch.name));
        if (ch.topic) r.appendChild(el('span', { class: 'row-sub' }, esc(ch.topic)));
        wrap.appendChild(r);
      }
    }
    const ungrouped = channels.filter((ch) => !ch.category_id);
    if (ungrouped.length) {
      for (const ch of ungrouped) {
        const r = el('button', {
          class: 'channel-row', type: 'button', style: { marginLeft: 0, width: '100%' },
          onClick: () => { location.hash = '#/server/' + serverId + '/channel/' + ch.id; },
        });
        r.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        r.appendChild(el('span', { class: 'ch-name' }, ch.name));
        wrap.appendChild(r);
      }
    }
  }
  wrap.appendChild(el('div', { class: 'section-label' }, 'Members'));
  renderMemberList(wrap, serverId);
  container.appendChild(wrap);
  setViewRefresh(() => { renderServerLanding(container, serverId).catch(() => {}); });
  renderAllChrome();
}

// Community member list with per-community nicknames. Re-renderable in place
// so a nickname change in the modal updates this section without a reroute.
function renderMemberList(wrap, serverId) {
  const old = wrap.querySelector('.member-list');
  if (old) old.remove();
  const listBox = el('div', { class: 'member-list' });
  const canNickname = can('KICK_MEMBERS') || can('*');
  for (const m of (State.members || []).slice(0, 24)) {
    const row = el('div', { class: 'row' });
    const rid = m.user_id || m.id;
    const avatarEl = avatar({ id: rid, username: m.username, displayName: m.display_name, avatarUrl: m.avatar_url }, { withPresence: true });
    avatarEl.style.cursor = 'pointer';
    avatarEl.addEventListener('click', () => { location.hash = '#/users/' + rid; });
    row.appendChild(avatarEl);
    const mm = el('div', { class: 'row-main' });
    const nameEl = el('div', { class: 'row-title', style: { cursor: 'pointer' } }, m.nickname || m.display_name || m.username);
    nameEl.addEventListener('click', () => { location.hash = '#/users/' + rid; });
    mm.appendChild(nameEl);
    const sub = m.nickname
      ? '@' + (m.username || '') + (m.display_name && m.display_name !== m.username ? ' · ' + m.display_name : '')
      : '@' + (m.username || '');
    mm.appendChild(el('div', { class: 'row-sub' }, sub));
    row.appendChild(mm);
    const mine = State.me && String(rid) === String(State.me.id);
    if (mine || canNickname) {
      const nick = el('button', { class: 'btn sm', type: 'button', title: 'Set nickname' }, 'nick');
      nick.addEventListener('click', () => openNicknameModal(serverId, m, wrap));
      row.appendChild(nick);
    }
    listBox.appendChild(row);
  }
  wrap.appendChild(listBox);
}

function openNicknameModal(serverId, member, wrap) {
  const name = member.nickname || member.display_name || member.username;
  const input = el('input', { class: 'input', type: 'text', maxlength: 32, placeholder: 'Nickname (2-32 chars)', value: name });
  const err = el('div', { class: 'form-error', hidden: true });
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Save');
  const clearBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Clear');
  const modal = openModal({
    title: 'Nickname',
    body: el('div', {}, err,
      el('p', { class: 'muted small' }, 'Set how @' + (member.username || '') + ' appears in this community. Empty clears it.'),
      input),
    footer: [clearBtn, save],
  });
  const saveIt = async () => {
    err.hidden = true;
    try {
      const res = await Api.setNickname(serverId, member.user_id || member.id, input.value.trim());
      toast(res && res.nickname ? 'Nickname saved.' : 'Nickname cleared.', 'ok');
      modal.close();
      await enterServer(serverId).catch(() => {});
      if (wrap) renderMemberList(wrap, serverId);
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  };
  save.addEventListener('click', saveIt);
  clearBtn.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.setNickname(serverId, member.user_id || member.id, '');
      toast('Nickname cleared.', 'ok');
      modal.close();
      await enterServer(serverId).catch(() => {});
      if (wrap) renderMemberList(wrap, serverId);
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });
}

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
  renderContextHeader({ title: '#' + chanName, sub: (channel && channel.topic) ? esc(channel.topic) : server.name, icon: '#' });

  const conv = el('div', { class: 'conversation' });
  const thread = el('div', { class: 'thread' });
  const feed = el('div', { class: 'feed' });
  thread.appendChild(feed);
  conv.appendChild(thread);

  // ---- history ----
  async function loadOlder(anchor) {
    let msgs = [];
    try { msgs = await Api.messages(channelId, { before: anchor, limit: 50 }); } catch { /* offline */ }
    if (!msgs.length) return;
    const frag = document.createDocumentFragment();
    for (const m of msgs) frag.appendChild(buildMsg(m));
    thread.insertBefore(thread.firstChild || feed, feed);
    // prepend in order
    while (frag.firstChild) feed.insertBefore(frag.firstChild, feed.firstChild);
  }

  async function reload() {
    clear(feed);
    let msgs = [];
    try { msgs = await Api.messages(channelId, { limit: 50 }); } catch (ex) {
      feed.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load messages'));
      return;
    }
    if (!msgs.length) {
      feed.appendChild(emptyState('◌', 'No messages yet', 'Start the conversation.'));
    }
    for (const m of msgs) feed.appendChild(buildMsg(m));
    groupFeed(feed);
    thread.scrollTop = thread.scrollHeight;
  }

  function buildMsg(m) {
    const node = messageRow(m, {
      meId: State.me && State.me.id,
      onEdit: () => editMsg(m),
      onDelete: () => deleteMsg(m),
      onDownload: (e, att) => downloadAtt(e, att),
    });
    stampMsgNode(node, m);
    return node;
  }

  // Continuous-conversation grouping: same author, <5 min apart, later
  // message collapses to avatar-space + body. Pure CSS class on top of
  // the existing rows; actions stay reachable via :hover/:focus-within.
  function stampMsgNode(node, m) {
    try {
      if (m && m.author_id) node.dataset.author = String(m.author_id);
      if (m && m.created_at) node.dataset.ts = String(m.created_at);
    } catch { /* grouping metadata is decorative */ }
  }

  function groupFeed(feedEl) {
    let prev = null;
    for (const node of feedEl.querySelectorAll(':scope > .msg')) {
      const a = node.dataset.author || '';
      const ts = Date.parse(node.dataset.ts || '') || 0;
      const pa = prev ? (prev.dataset.author || '') : '';
      const pts = prev ? (Date.parse(prev.dataset.ts || '') || 0) : 0;
      const grouped = !!(prev && a && pa === a && ts >= pts && (ts - pts) < 5 * 60 * 1000);
      node.classList.toggle('grouped', grouped);
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
  composer.appendChild(fileBtn);
  composer.appendChild(fileInput);
  composer.appendChild(ta);
  composer.appendChild(el('div', { class: 'composer-actions' }, sendBtn));
  conv.appendChild(composer);

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

  async function send() {
    const content = ta.value.trim();
    if (!content && !pending.length) return;
    if (!content) { toast('Add a message or file', 'warn'); return; }
    sendBtn.setAttribute('aria-busy', 'true');
    try {
      await Api.sendMessage(channelId, { content, attachmentIds: pending.length ? pending : undefined });
      ta.value = '';
      pending = [];
      resize();
      await reload();
    } catch (ex) {
      toast(ex.message || 'Cannot send', 'error');
    } finally {
      sendBtn.removeAttribute('aria-busy');
    }
  }
  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  container.appendChild(conv);
  activeChannelId = channelId;
  await reload();
  Realtime.join(channelId);

  // Live updates
  const offMsg = Realtime.on('message', (m) => {
    if (String(m.channel_id) === String(channelId)) {
      const node = messageRow(m, { meId: State.me && State.me.id, onEdit: () => editMsg(m), onDelete: () => deleteMsg(m), onDownload: downloadAtt });
      stampMsgNode(node, m);
      feed.appendChild(node);
      groupFeed(feed);
      thread.scrollTop = thread.scrollHeight;
    }
  });
  const offUpd = Realtime.on('message_updated', (m) => {
    if (String(m.channel_id) === String(channelId)) {
      const node = feed.querySelector('[data-message-id="' + m.id + '"]');
      if (node) {
        const t = node.querySelector('.msg-text');
        if (t) t.textContent = m.content;
        const head = node.querySelector('.msg-head');
        if (head && !head.querySelector('.msg-edited')) head.appendChild(el('span', { class: 'msg-edited' }, 'edited'));
      }
    }
  });
  const offDel = Realtime.on('message_deleted', (m) => {
    if (String(m.channel_id) === String(channelId)) {
      const node = feed.querySelector('[data-message-id="' + m.id + '"]');
      if (node) {
        clear(node.querySelector('.msg-body') || node);
        node.classList.add('deleted');
        node.querySelector('.msg-body').appendChild(el('div', { class: 'msg-text' }, 'Message deleted'));
      }
    }
  });

  // Clean up when the route changes
  const cleanup = () => {
    offMsg(); offUpd(); offDel();
    Realtime.leaveChannel();
    activeChannelId = null;
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

function memberTopRole(m) {
  const roles = Array.isArray(m.roles) ? m.roles : [];
  const byId = new Map((State.roles || []).map((r) => [String(r.id), r]));
  let top = null;
  for (const r of roles) {
    const full = byId.get(String(r.id)) || r;
    if (!top || Number(full.position || 0) > Number(top.position || 0)) top = full;
  }
  return top;
}

function timedOutUntil(m) {
  if (!m || !m.timeout_expires_at) return null;
  const t = new Date(m.timeout_expires_at).getTime();
  return Number.isFinite(t) && t > Date.now() ? m.timeout_expires_at : null;
}

function rolePill(r, { removable = false, onRemove = null } = {}) {
  const pill = el('span', { class: 'role-pill' + (removable ? '' : '') },
    r.color ? el('span', { class: 'role-color-dot', style: { background: r.color } }) : null,
    el('span', {}, r.name || 'Role'));
  if (r.color) { pill.style.color = r.color; pill.style.borderColor = r.color; }
  if (removable) {
    const x = el('button', { class: 'role-unassign', type: 'button', title: 'Remove role', 'aria-label': 'Remove role ' + (r.name || '') }, '×');
    x.addEventListener('click', onRemove);
    const wrap = el('span', { class: 'role-pill-wrap' }, pill, x);
    return wrap;
  }
  return pill;
}

function openBanModal(serverId, m, onDone) {
  const id = m.user_id || m.id;
  const reason = el('input', { class: 'input', type: 'text', maxlength: 500, placeholder: 'Reason (optional)' });
  const dur = el('select', { class: 'input' });
  [['', 'Permanent'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days']].forEach(([v, label]) => {
    const o = el('option', { value: v }, label);
    dur.appendChild(o);
  });
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const go = el('button', { class: 'btn danger', type: 'button' }, 'Ban member');
  const modal = openModal({
    title: 'Ban @' + (m.username || ''),
    body: el('div', {}, err,
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reason),
      el('div', { class: 'field' }, el('label', {}, 'Duration'), dur),
      el('p', { class: 'muted small' }, 'Banned users are removed immediately and cannot rejoin until unbanned or the ban expires.')),
    footer: [cancel, go],
  });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.banMember(serverId, id, { reason: reason.value.trim() || undefined, minutes: dur.value ? Number(dur.value) : undefined });
      modal.close();
      toast('Member banned.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not ban member.'; }
  });
}

function openTimeoutModal(serverId, m, onDone) {
  const id = m.user_id || m.id;
  const dur = el('select', { class: 'input' });
  [['10', '10 minutes'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days'], ['', 'Clear timeout']].forEach(([v, label]) => {
    dur.appendChild(el('option', { value: v }, label));
  });
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const go = el('button', { class: 'btn primary', type: 'button' }, 'Apply');
  const modal = openModal({
    title: 'Timeout @' + (m.username || ''),
    body: el('div', {}, err,
      el('div', { class: 'field' }, el('label', {}, 'Duration'), dur),
      el('p', { class: 'muted small' }, 'Timed-out members stay in the community but cannot post until it lapses.')),
    footer: [cancel, go],
  });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.timeoutMember(serverId, id, dur.value === '' ? null : Number(dur.value));
      modal.close();
      toast(dur.value === '' ? 'Timeout cleared.' : 'Member timed out.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not set timeout.'; }
  });
}

async function renderServerMembers(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  renderContextHeader({ title: 'Members', sub: server.name });
  const wrap = el('div', { class: 'page atrium community-manager' });
  const head = el('div', { class: 'community-manager__head' },
    el('div', {}, el('h1', {}, 'Members'), el('p', { class: 'muted' }, 'Manage the people who belong to this community.')),
    el('button', { class: 'btn', type: 'button', onClick: () => { location.hash = '#/server/' + serverId; } }, 'Back to chat'));
  wrap.appendChild(head);
  const counts = el('div', { class: 'stat-inline' });
  wrap.appendChild(counts);

  const toolbar = el('div', { class: 'community-manager__toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search members…' });
  const roleFilter = el('select', { class: 'input sm', title: 'Filter by role' });
  // Seeded before the first paint: paint() reads the value before it
  // rebuilds the live role options, and an empty value would filter all out.
  roleFilter.appendChild(el('option', { value: 'all' }, 'All roles'));
  const presFilter = el('select', { class: 'input sm', title: 'Filter by presence' });
  presFilter.appendChild(el('option', { value: 'all' }, 'All statuses'));
  presFilter.appendChild(el('option', { value: 'online' }, 'Online'));
  presFilter.appendChild(el('option', { value: 'offline' }, 'Offline'));
  const botsOnly = el('input', { type: 'checkbox' });
  const sortSel = el('select', { class: 'input sm', title: 'Sort members' });
  [['name', 'Sort: name'], ['newest', 'Sort: newest'], ['oldest', 'Sort: oldest'], ['role', 'Sort: top role']].forEach(([v, label]) => {
    sortSel.appendChild(el('option', { value: v }, label));
  });
  toolbar.append(search, roleFilter, presFilter, el('label', { class: 'switch' }, botsOnly, ' Bots only'), sortSel);
  wrap.appendChild(toolbar);

  const list = el('div', { class: 'community-list' });
  wrap.appendChild(list);
  const banSection = el('div', {});
  wrap.appendChild(banSection);

  const reload = async () => {
    await ensureServer(serverId);
    if (can('BAN_MEMBERS')) { try { await refreshBans(); } catch { /* bans stay stale-empty */ } }
    paint();
  };
  setViewRefresh(() => { reload().catch(() => {}); });

  const paint = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const roleId = roleFilter.value || 'all';
    const pres = presFilter.value;
    const bots = botsOnly.checked;
    const sort = sortSel.value;
    const online = (m) => peerPresence(m.user_id || m.id) === 'online';
    let members = (State.members || []).filter((m) => {
      if (q && ![m.username, m.display_name, m.nickname].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      if (roleId !== 'all' && !(Array.isArray(m.roles) && m.roles.some((r) => String(r.id) === roleId))) return false;
      if (pres !== 'all' && (online(m) ? 'online' : 'offline') !== pres) return false;
      if (bots && !m.is_bot) return false;
      return true;
    });
    const dispName = (m) => m.nickname || m.display_name || m.username || 'Unknown';
    const topPos = (m) => { const t = memberTopRole(m); return t ? Number(t.position || 0) : -1; };
    members = [...members].sort((a, b) => {
      if (sort === 'newest') return String(b.joined_at || '').localeCompare(String(a.joined_at || ''));
      if (sort === 'oldest') return String(a.joined_at || '').localeCompare(String(b.joined_at || ''));
      if (sort === 'role') return topPos(b) - topPos(a) || dispName(a).localeCompare(dispName(b));
      return dispName(a).localeCompare(dispName(b));
    });

    const total = (State.members || []).length;
    const onlineCount = (State.members || []).filter(online).length;
    clear(counts);
    counts.appendChild(el('span', {}, String(total) + ' total · ' + String(onlineCount) + ' online'));

    // Role filter options follow live roles.
    const curRole = roleFilter.value;
    clear(roleFilter);
    roleFilter.appendChild(el('option', { value: 'all' }, 'All roles'));
    for (const r of [...(State.roles || [])].sort((a, b) => Number(b.position || 0) - Number(a.position || 0))) {
      const o = el('option', { value: String(r.id) }, (r.name || 'Role'));
      if (String(r.id) === curRole) o.selected = true;
      roleFilter.appendChild(o);
    }
    roleFilter.value = [...roleFilter.options].some((o) => o.value === curRole) ? curRole : 'all';

    if (!members.length) {
      list.appendChild(emptyState('⌕', 'No members found', 'Try a different search or filter.'));
    }
    for (const m of members) {
      const id = m.user_id || m.id;
      const mine = String(id) === String(State.me && State.me.id);
      const row = el('article', { class: 'community-member-card' });
      row.appendChild(avatar({ id, username: m.username, displayName: m.nickname || m.display_name, avatarUrl: m.avatar_url }, { size: 'sm', withPresence: true }));
      const info = el('div', { class: 'community-member-card__info' });
      const nameLine = el('div', { class: 'member-name-line' },
        el('strong', {}, dispName(m)),
        m.is_bot ? el('span', { class: 'bot-tag' }, 'BOT') : null);
      info.appendChild(nameLine);
      const sub = '@' + (m.username || 'unknown') +
        (m.joined_at ? ' · joined ' + relTime(m.joined_at) : '') +
        (m.status_text ? ' · ' + m.status_text : '');
      info.appendChild(el('span', { class: 'muted small' }, sub));
      const to = timedOutUntil(m);
      if (to) info.appendChild(el('span', { class: 'badge warn' }, 'Timed out · ' + relTime(to)));
      const roles = Array.isArray(m.roles) ? m.roles : [];
      const roleBox = el('div', { class: 'role-pills' });
      if (m.is_owner) roleBox.appendChild(el('span', { class: 'role-pill owner' }, 'Owner'));
      for (const r of roles.slice(0, 8)) {
        roleBox.appendChild(rolePill(r, {
          removable: can('MANAGE_ROLES') && !m.is_owner,
          onRemove: async () => {
            try { await Api.unassignRole(serverId, r.id, id); await reload(); toast('Role removed.', 'ok'); }
            catch (ex) { toast(ex.message || 'Could not remove role.', 'error'); }
          },
        }));
      }
      if (!m.is_owner && !roles.length) roleBox.appendChild(el('span', { class: 'role-pill muted-role' }, 'Member'));
      info.appendChild(roleBox);
      row.appendChild(info);
      const actions = el('div', { class: 'community-member-card__actions' });
      actions.appendChild(el('button', { class: 'btn sm', type: 'button', onClick: () => { location.hash = '#/users/' + id; } }, 'Profile'));
      if (mine || can('KICK_MEMBERS')) {
        actions.appendChild(el('button', { class: 'btn sm', type: 'button', onClick: () => openNicknameModal(serverId, m, wrap) }, 'Nickname'));
      }
      if (can('MANAGE_ROLES') && !m.is_owner) {
        const assigned = new Set(roles.map((r) => String(r.id)));
        const roleSelect = el('select', { class: 'input sm', title: 'Assign role' });
        roleSelect.appendChild(el('option', { value: '' }, 'Role…'));
        for (const role of State.roles || []) {
          if (role.is_default || assigned.has(String(role.id))) continue;
          roleSelect.appendChild(el('option', { value: role.id }, role.name || 'Role'));
        }
        roleSelect.addEventListener('change', async () => {
          if (!roleSelect.value) return;
          try { await Api.assignRole(serverId, roleSelect.value, id); await reload(); toast('Role assigned.', 'ok'); }
          catch (ex) { toast(ex.message || 'Could not assign role.', 'error'); }
          finally { roleSelect.value = ''; }
        });
        actions.appendChild(roleSelect);
      }
      if (!m.is_owner && !mine && can('KICK_MEMBERS')) {
        actions.appendChild(el('button', { class: 'btn danger sm', type: 'button', onClick: () => {
          confirmDialog({
            title: 'Remove member?', message: '@' + (m.username || '') + ' will leave this community immediately.',
            danger: true, confirmText: 'Remove',
            onConfirm: async () => {
              try { await Api.kickMember(serverId, id); await reload(); toast('Member removed.', 'ok'); }
              catch (ex) { toast(ex.message || 'Could not remove member.', 'error'); }
            },
          });
        } }, 'Kick'));
      }
      if (!m.is_owner && !mine && can('BAN_MEMBERS')) {
        actions.appendChild(el('button', { class: 'btn danger sm', type: 'button', onClick: () => openBanModal(serverId, m, reload) }, 'Ban'));
        actions.appendChild(el('button', { class: 'btn sm', type: 'button', onClick: () => openTimeoutModal(serverId, m, reload) }, 'Timeout'));
      }
      row.appendChild(actions);
      list.appendChild(row);
    }

    clear(banSection);
    if (can('BAN_MEMBERS')) {
      banSection.appendChild(el('div', { class: 'section-label' }, 'Banned (' + (State.bans || []).length + ')'));
      if (!(State.bans || []).length) {
        banSection.appendChild(el('p', { class: 'muted small' }, 'No active bans.'));
      }
      const blist = el('div', { class: 'community-list' });
      for (const b of State.bans || []) {
        const row = el('article', { class: 'community-member-card' });
        const info = el('div', { class: 'community-member-card__info' });
        info.appendChild(el('strong', {}, b.displayName || b.username || 'Unknown'));
        info.appendChild(el('span', { class: 'muted small' },
          '@' + (b.username || '?') +
          (b.reason ? ' · ' + b.reason : '') +
          (b.expiresAt ? ' · expires ' + relTime(b.expiresAt) : ' · permanent') +
          (b.actorName ? ' · by ' + b.actorName : '')));
        row.appendChild(info);
        const unban = el('button', { class: 'btn sm', type: 'button' }, 'Unban');
        unban.addEventListener('click', async () => {
          try { await Api.unbanMember(serverId, b.userId); await reload(); toast('Ban lifted.', 'ok'); }
          catch (ex) { toast(ex.message || 'Could not lift ban.', 'error'); }
        });
        row.appendChild(el('div', { class: 'community-member-card__actions' }, unban));
        blist.appendChild(row);
      }
      banSection.appendChild(blist);
    }
  };
  const repaint = () => paint();
  search.addEventListener('input', repaint);
  roleFilter.addEventListener('change', repaint);
  presFilter.addEventListener('change', repaint);
  botsOnly.addEventListener('change', repaint);
  sortSel.addEventListener('change', repaint);
  await reload();
  container.appendChild(wrap);
}

async function renderServerRoles(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  renderContextHeader({ title: 'Roles', sub: server.name });
  const wrap = el('div', { class: 'page atrium community-manager' });
  wrap.appendChild(el('div', { class: 'community-manager__head' },
    el('div', {}, el('h1', {}, 'Roles'), el('p', { class: 'muted' }, 'Define visible roles and the permissions they grant.')),
    el('button', { class: 'btn', type: 'button', onClick: () => { location.hash = '#/server/' + serverId; } }, 'Back to chat')));
  if (!can('MANAGE_ROLES')) {
    wrap.appendChild(el('div', { class: 'form-error' }, 'You need Manage Roles permission to edit roles.'));
    const list = el('div', { class: 'community-list' });
    for (const r of State.roles || []) list.appendChild(el('div', { class: 'community-role-card' }, el('strong', {}, r.name || 'Role'), el('span', { class: 'muted small' }, String((r.permissions || []).length) + ' permissions')));
    wrap.appendChild(list); container.appendChild(wrap); return;
  }
  const permsInfo = await Api.serverPermissions(serverId).catch(() => ({ all: [] }));
  const allPerms = Array.isArray(permsInfo.all) ? permsInfo.all : [];
  const list = el('div', { class: 'community-list' });
  const formWrap = el('div', { class: 'community-role-editor' });
  const name = el('input', { class: 'input', type: 'text', maxlength: 32, placeholder: 'Role name' });
  const colorNew = el('input', { type: 'color', class: 'input', value: '#ff8a24', title: 'Role color' });
  const permGrid = el('div', { class: 'permission-grid' });
  const checks = new Map();
  for (const perm of allPerms) {
    const input = el('input', { type: 'checkbox' });
    checks.set(perm, input);
    permGrid.appendChild(el('label', { class: 'permission-item' }, input, el('span', {}, perm)));
  }
  const create = el('button', { class: 'btn primary', type: 'button' }, 'Create role');
  formWrap.append(
    el('div', { class: 'field' }, el('label', {}, 'Role name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Color'), colorNew),
    el('div', { class: 'section-label' }, 'Permissions'), permGrid, create);
  wrap.appendChild(formWrap); wrap.appendChild(el('div', { class: 'section-label' }, 'Existing roles (top first)')); wrap.appendChild(list);

  const reload = async () => { await ensureServer(serverId); paint(); };
  setViewRefresh(() => { reload().catch(() => {}); });

  const sortedRoles = () => [...(State.roles || [])].sort((a, b) => Number(b.position || 0) - Number(a.position || 0));
  const memberCount = (roleId) => (State.members || []).filter((m) => (m.roles || []).some((r) => String(r.id) === String(roleId))).length;

  const paint = () => {
    clear(list);
    const ordered = sortedRoles();
    ordered.forEach((role, idx) => {
      const row = el('article', { class: 'community-role-card' });
      const main = el('div', { class: 'community-role-card__main' });
      const pill = el('span', { class: 'role-pill' },
        role.color ? el('span', { class: 'role-color-dot', style: { background: role.color } }) : null,
        el('span', {}, role.name || 'Role'));
      if (role.color) { pill.style.color = role.color; pill.style.borderColor = role.color; }
      main.appendChild(pill);
      main.appendChild(el('span', { class: 'muted small' },
        memberCount(role.id) + ' members · ' + String((role.permissions || []).length) + ' permissions' +
        (role.is_default ? ' · default' : '')));
      row.appendChild(main);
      if (!role.is_default) {
        const actions = el('div', { class: 'community-member-card__actions' });
        const edit = el('button', { class: 'btn sm', type: 'button' }, 'Edit');
        edit.addEventListener('click', () => openRoleEditor(serverId, role, allPerms, reload));
        const up = el('button', { class: 'btn sm', type: 'button', title: 'Move up', disabled: idx === 0 }, '▲');
        up.addEventListener('click', async () => {
          const ids = ordered.map((r) => String(r.id));
          [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
          try { await Api.reorderRoles(serverId, ids); await reload(); }
          catch (ex) { toast(ex.message || 'Could not reorder roles.', 'error'); }
        });
        const down = el('button', { class: 'btn sm', type: 'button', title: 'Move down', disabled: idx === ordered.length - 1 }, '▼');
        down.addEventListener('click', async () => {
          const ids = ordered.map((r) => String(r.id));
          [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
          try { await Api.reorderRoles(serverId, ids); await reload(); }
          catch (ex) { toast(ex.message || 'Could not reorder roles.', 'error'); }
        });
        const del = el('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
        del.addEventListener('click', () => {
          confirmDialog({
            title: 'Delete role?', message: (role.name || 'Role') + ' will be removed. Members keep their other roles.',
            danger: true, confirmText: 'Delete',
            onConfirm: async () => {
              try { await Api.deleteRole(serverId, role.id); await reload(); toast('Role deleted.', 'ok'); }
              catch (ex) { toast(ex.message || 'Could not delete role.', 'error'); }
            },
          });
        });
        actions.append(edit, up, down, del);
        row.appendChild(actions);
      }
      list.appendChild(row);
    });
  };
  create.addEventListener('click', async () => {
    const roleName = name.value.trim();
    if (!roleName) { toast('Enter a role name.', 'warn'); return; }
    const permissions = [...checks.entries()].filter(([, input]) => input.checked).map(([key]) => key);
    try {
      await Api.createRole(serverId, { name: roleName, permissions, color: colorNew.value });
      name.value = ''; checks.forEach((i) => { i.checked = false; });
      await reload(); toast('Role created.', 'ok');
    } catch (ex) { toast(ex.message || 'Could not create role.', 'error'); }
  });
  paint(); container.appendChild(wrap);
}

function openRoleEditor(serverId, role, allPerms, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: 32, value: role.name || '' });
  const colorRow = el('div', { class: 'row-line' });
  const color = el('input', { type: 'color', class: 'input', value: /^#[0-9a-f]{6}$/i.test(role.color || '') ? role.color : '#ff8a24' });
  const clearColor = el('button', { class: 'btn ghost sm', type: 'button' }, 'No color');
  let useColor = !!role.color;
  const paintColor = () => { color.disabled = !useColor; clearColor.textContent = useColor ? 'No color' : 'Use color'; };
  clearColor.addEventListener('click', () => { useColor = !useColor; paintColor(); });
  paintColor();
  colorRow.append(color, clearColor);
  const permGrid = el('div', { class: 'permission-grid' });
  const checks = new Map();
  const current = new Set(role.permissions || []);
  for (const perm of allPerms) {
    const input = el('input', { type: 'checkbox' });
    input.checked = current.has(perm);
    checks.set(perm, input);
    permGrid.appendChild(el('label', { class: 'permission-item' }, input, el('span', {}, perm)));
  }
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Save role');
  const modal = openModal({
    title: 'Edit role',
    body: el('div', {}, err,
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Color'), colorRow),
      el('div', { class: 'section-label' }, 'Permissions'), permGrid),
    footer: [cancel, save],
  });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.updateRole(serverId, role.id, {
        name: name.value.trim(),
        permissions: [...checks.entries()].filter(([, i]) => i.checked).map(([k]) => k),
        color: useColor ? color.value : null,
      });
      modal.close();
      toast('Role updated.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not update role.'; }
  });
}

async function renderServerCategories(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  renderContextHeader({ title: 'Categories', sub: server.name });
  const wrap = el('div', { class: 'page atrium community-manager' });
  wrap.appendChild(el('div', { class: 'community-manager__head' },
    el('div', {}, el('h1', {}, 'Channel categories'), el('p', { class: 'muted' }, 'Organize channels into clean sections.')),
    el('button', { class: 'btn', type: 'button', onClick: () => { location.hash = '#/server/' + serverId; } }, 'Back to chat')));
  if (!can('MANAGE_CHANNELS')) { wrap.appendChild(el('div', { class: 'form-error' }, 'You need Manage Channels permission to edit categories.')); container.appendChild(wrap); return; }
  const createRow = el('div', { class: 'community-manager__toolbar' });
  const input = el('input', { class: 'input', type: 'text', maxlength: 64, placeholder: 'New category name' });
  const add = el('button', { class: 'btn primary', type: 'button' }, 'Add category');
  createRow.append(input, add); wrap.appendChild(createRow);
  const list = el('div', { class: 'community-list' }); wrap.appendChild(list);
  const reload = async () => { await ensureServer(serverId); paint(); };
  setViewRefresh(() => { reload().catch(() => {}); });
  const paint = () => {
    clear(list);
    const cats = [...(State.channels.categories || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const allChannels = [...(State.channels.channels || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    if (!cats.length && !allChannels.length) {
      list.appendChild(emptyState('≡', 'No categories', 'Channels without a category appear under Text channels.'));
    }
    cats.forEach((cat, idx) => {
      const channels = allChannels.filter((c) => String(c.category_id) === String(cat.id));
      const row = el('article', { class: 'community-category-card' });
      const main = el('div', { class: 'community-category-card__main' });
      main.appendChild(el('strong', {}, cat.name || 'Category'));
      main.appendChild(el('span', { class: 'muted small' }, channels.length + ' channel' + (channels.length === 1 ? '' : 's')));
      row.appendChild(main);
      const actions = el('div', { class: 'community-member-card__actions' });
      const rename = el('button', { class: 'btn sm', type: 'button' }, 'Rename');
      rename.addEventListener('click', () => openCategoryRename(serverId, cat, reload));
      const up = el('button', { class: 'btn sm', type: 'button', title: 'Move up', disabled: idx === 0 }, '▲');
      up.addEventListener('click', async () => {
        const ids = cats.map((c) => String(c.id));
        [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
        try { await Api.reorderCategories(serverId, ids); await reload(); }
        catch (ex) { toast(ex.message || 'Could not reorder categories.', 'error'); }
      });
      const down = el('button', { class: 'btn sm', type: 'button', title: 'Move down', disabled: idx === cats.length - 1 }, '▼');
      down.addEventListener('click', async () => {
        const ids = cats.map((c) => String(c.id));
        [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
        try { await Api.reorderCategories(serverId, ids); await reload(); }
        catch (ex) { toast(ex.message || 'Could not reorder categories.', 'error'); }
      });
      const del = el('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
      del.addEventListener('click', () => {
        confirmDialog({
          title: 'Delete category?',
          message: (cat.name || 'Category') + ' will be removed. Its ' + channels.length + ' channel(s) become uncategorized — channels are never deleted with it.',
          danger: true, confirmText: 'Delete',
          onConfirm: async () => {
            try { await Api.deleteCategory(serverId, cat.id); await reload(); toast('Category deleted.', 'ok'); }
            catch (ex) { toast(ex.message || 'Could not delete category.', 'error'); }
          },
        });
      });
      actions.append(rename, up, down, del);
      row.appendChild(actions);
      list.appendChild(row);
      for (const ch of channels) {
        const chRow = el('div', { class: 'community-channel-row' });
        chRow.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        chRow.appendChild(el('span', { class: 'ch-name' }, ch.name || 'channel'));
        if (ch.topic) chRow.appendChild(el('span', { class: 'row-sub' }, ch.topic));
        chRow.appendChild(el('span', { class: 'spacer' }));
        const edit = el('button', { class: 'btn sm', type: 'button' }, 'Edit');
        edit.addEventListener('click', () => openChannelEditor(serverId, ch, cats, reload));
        const chDel = el('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
        chDel.addEventListener('click', () => {
          confirmDialog({
            title: 'Delete channel?',
            message: '#' + (ch.name || 'channel') + ' and its messages will be permanently deleted.',
            danger: true, confirmText: 'Delete',
            onConfirm: async () => {
              try { await Api.deleteChannel(serverId, ch.id); await reload(); toast('Channel deleted.', 'ok'); }
              catch (ex) { toast(ex.message || 'Could not delete channel.', 'error'); }
            },
          });
        });
        chRow.append(edit, chDel);
        list.appendChild(chRow);
      }
    });
    const ungrouped = allChannels.filter((c) => !c.category_id);
    if (ungrouped.length) {
      list.appendChild(el('div', { class: 'section-label' }, 'Text channels'));
      for (const ch of ungrouped) {
        const chRow = el('div', { class: 'community-channel-row' });
        chRow.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        chRow.appendChild(el('span', { class: 'ch-name' }, ch.name || 'channel'));
        if (ch.topic) chRow.appendChild(el('span', { class: 'row-sub' }, ch.topic));
        chRow.appendChild(el('span', { class: 'spacer' }));
        const edit = el('button', { class: 'btn sm', type: 'button' }, 'Edit');
        edit.addEventListener('click', () => openChannelEditor(serverId, ch, cats, reload));
        const chDel = el('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
        chDel.addEventListener('click', () => {
          confirmDialog({
            title: 'Delete channel?',
            message: '#' + (ch.name || 'channel') + ' and its messages will be permanently deleted.',
            danger: true, confirmText: 'Delete',
            onConfirm: async () => {
              try { await Api.deleteChannel(serverId, ch.id); await reload(); toast('Channel deleted.', 'ok'); }
              catch (ex) { toast(ex.message || 'Could not delete channel.', 'error'); }
            },
          });
        });
        chRow.append(edit, chDel);
        list.appendChild(chRow);
      }
    }
  };
  add.addEventListener('click', async () => {
    const n = input.value.trim(); if (!n) return;
    try { await Api.createCategory(serverId, { name: n }); input.value = ''; await reload(); toast('Category created.', 'ok'); }
    catch (ex) { toast(ex.message || 'Could not create category.', 'error'); }
  });
  paint(); container.appendChild(wrap);
}

function openCategoryRename(serverId, cat, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: 32, value: cat.name || '' });
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Rename');
  const modal = openModal({
    title: 'Rename category',
    body: el('div', {}, err, el('div', { class: 'field' }, el('label', {}, 'Name'), name)),
    footer: [cancel, save],
  });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.renameCategory(serverId, cat.id, name.value.trim());
      modal.close();
      toast('Category renamed.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not rename category.'; }
  });
}

function openChannelEditor(serverId, ch, cats, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: 32, value: ch.name || '' });
  const topic = el('input', { class: 'input', type: 'text', maxlength: 200, value: ch.topic || '' });
  const catSel = el('select', { class: 'input' });
  catSel.appendChild(el('option', { value: '' }, 'No category'));
  for (const c of cats) {
    const o = el('option', { value: String(c.id) }, c.name || 'Category');
    if (String(ch.category_id) === String(c.id)) o.selected = true;
    catSel.appendChild(o);
  }
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Save channel');
  const modal = openModal({
    title: 'Edit channel',
    body: el('div', {}, err,
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Topic'), topic),
      el('div', { class: 'field' }, el('label', {}, 'Category'), catSel)),
    footer: [cancel, save],
  });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.updateChannel(serverId, ch.id, {
        name: name.value.trim(), topic: topic.value.trim(), categoryId: catSel.value || null,
      });
      modal.close();
      toast('Channel updated.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not update channel.'; }
  });
}

// ---- create channel ---------------------------------------------------------

async function renderNewChannel(container, serverId) {
  clear(container);
  try { await ensureServer(serverId); } catch { /* toast below */ }
  if (!can('MANAGE_CHANNELS')) {
    renderContextHeader({ title: 'New channel' });
    container.appendChild(el('div', { class: 'form-error' }, 'You need permission to manage channels in this community.'));
    return;
  }
  renderContextHeader({ title: 'New channel' });
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  const err = el('div', { class: 'form-error', hidden: true });
  const name = el('input', { class: 'input', type: 'text', placeholder: 'channel-name', maxlength: 32, required: true });
  const topic = el('input', { class: 'input', type: 'text', placeholder: 'Topic (optional)', maxlength: 200 });
  const catSelect = el('select', { class: 'select' });
  catSelect.appendChild(el('option', { value: '' }, 'No category'));
  for (const c of (State.channels.categories || [])) catSelect.appendChild(el('option', { value: c.id }, c.name));
  const createBtn = el('button', { class: 'btn primary block', type: 'submit' }, 'Create channel');

  const form = el('form', {}, err,
    el('div', { class: 'field' }, el('label', {}, 'Channel name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Topic'), topic),
    el('div', { class: 'field' }, el('label', {}, 'Category'), catSelect),
    createBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const ch = await Api.createChannel(serverId, {
        name: name.value.trim(),
        topic: topic.value.trim() || undefined,
        categoryId: catSelect.value || undefined,
      });
      toast('Channel created.', 'ok');
      location.hash = '#/server/' + serverId + '/channel/' + ch.id;
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });

  card.appendChild(el('h1', {}, 'Create a channel'));
  card.appendChild(el('p', { class: 'auth-sub' }, 'Channels are how your community talks.'));
  card.appendChild(form);
  wrap.appendChild(card);
  container.appendChild(wrap);
}

// ---- invites ----------------------------------------------------------------

async function renderInvites(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message)); return; }
  if (!can('MANAGE_INVITES')) {
    renderContextHeader({ title: 'Invites', sub: server.name });
    container.appendChild(el('div', { class: 'form-error' }, 'You need permission to manage invites in this community.'));
    return;
  }
  renderContextHeader({ title: 'Invites', sub: server.name });
  const wrap = el('div', { class: 'page atrium' });

  const createBtn = el('button', { class: 'btn primary', type: 'button' }, 'Create invite');
  const maxUses = el('input', { class: 'input', type: 'number', min: 1, max: 100, value: '1', style: { width: '70px' }, title: 'Max uses' });
  const hours = el('input', { class: 'input', type: 'number', min: 1, max: 720, value: '48', style: { width: '80px' }, title: 'Hours valid' });
  const createRow = el('div', { class: 'row-line' },
    el('span', { class: 'muted small' }, 'Uses'), maxUses,
    el('span', { class: 'muted small' }, 'Hours'), hours, createBtn);
  wrap.appendChild(createRow);

  const listPane = el('div', { class: 'stack' });
  wrap.appendChild(listPane);

  async function reload() {
    clear(listPane);
    let invites = [];
    try { invites = await Api.invites(serverId); } catch { /* ignore */ }
    if (!invites.length) {
      listPane.appendChild(emptyState('◇', 'No invites yet', 'Create one above to share a link.'));
      return;
    }
    for (const inv of invites) {
      const row = el('div', { class: 'row' });
      const m = el('div', { class: 'row-main' });
      const link = location.origin + '/#/invite/' + inv.code;
      m.appendChild(el('div', { class: 'row-title mono' }, inv.code));
      m.appendChild(el('div', { class: 'row-sub' },
        inv.uses + ' uses' +
        (inv.max_uses ? '/' + inv.max_uses : '') +
        (inv.expires_at ? ' · expires ' + relTime(inv.expires_at) : '') +
        (inv.revoked ? ' · REVOKED' : '')));
      row.appendChild(m);
      const copyBtn = el('button', { class: 'btn sm', type: 'button' }, 'Copy link');
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(link); toast('Invite link copied.', 'ok'); }
        catch { toast(link, 'info'); }
      });
      const delBtn = el('button', { class: 'btn danger sm', type: 'button' }, 'Revoke');
      delBtn.addEventListener('click', async () => {
        try { await Api.deleteInvite(serverId, inv.id); await reload(); } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
      row.appendChild(copyBtn);
      row.appendChild(delBtn);
      listPane.appendChild(row);
    }
  }

  createBtn.addEventListener('click', async () => {
    try {
      await Api.createInvite(serverId, { maxUses: parseInt(maxUses.value, 10) || null, expiresInHours: parseInt(hours.value, 10) || 48 });
      await reload();
      toast('Invite created.', 'ok');
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });

  container.appendChild(wrap);
  await reload();
}

// ---- server settings --------------------------------------------------------

async function renderServerSettings(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message)); return; }
  if (!can('MANAGE_SERVER')) {
    renderContextHeader({ title: 'Settings', sub: server.name });
    container.appendChild(el('div', { class: 'form-error' }, 'You need permission to manage this community\'s settings.'));
    return;
  }
  renderContextHeader({ title: 'Settings', sub: server.name });
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  const err = el('div', { class: 'form-error', hidden: true });
  const ok = el('div', { class: 'form-success', hidden: true });
  const name = el('input', { class: 'input', type: 'text', value: server.name || '', maxlength: 64 });
  const desc = el('textarea', { class: 'textarea', maxlength: 400, placeholder: 'Description' }, server.description || '');
  const isPublic = el('input', { type: 'checkbox', checked: !!server.is_public });
  const isDisc = el('input', { type: 'checkbox', checked: !!server.is_discoverable });
  const saveBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Save changes');

  const form = el('form', {}, err, ok,
    el('div', { class: 'field' }, el('label', {}, 'Name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Description'), desc),
    el('div', { class: 'field' }, el('label', { class: 'switch' }, isPublic, ' Public (joinable by link)')),
    el('div', { class: 'field' }, el('label', { class: 'switch' }, isDisc, ' Discoverable in browse')),
    saveBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await Api.updateServer(serverId, {
        name: name.value.trim(),
        description: desc.value.trim(),
        isPublic: isPublic.checked,
        isDiscoverable: isDisc.checked,
      });
      await refreshServers();
      await ensureServer(serverId);
      ok.hidden = false;
      toast('Settings saved.', 'ok');
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });

  card.appendChild(form);

  const management = el('div', { class: 'community-manager__toolbar', style: { marginTop: 'var(--t-d-5)', flexWrap: 'wrap' } });
  management.appendChild(el('button', { class: 'btn', type: 'button', onClick: () => { location.hash = '#/server/' + serverId + '/members'; } }, 'Members'));
  management.appendChild(el('button', { class: 'btn', type: 'button', onClick: () => { location.hash = '#/server/' + serverId + '/roles'; } }, 'Roles'));
  management.appendChild(el('button', { class: 'btn', type: 'button', onClick: () => { location.hash = '#/server/' + serverId + '/categories'; } }, 'Categories'));
  management.appendChild(el('button', { class: 'btn', type: 'button', onClick: () => { location.hash = '#/server/' + serverId + '/invites'; } }, 'Invites'));
  card.appendChild(management);

  const danger = el('div', { class: 'hr' });
  card.appendChild(danger);
  const leaveBtn = el('button', { class: 'btn danger block', type: 'button' }, 'Leave server');
  leaveBtn.addEventListener('click', async () => {
    if (server.is_owner) { toast('You own this server. Transfer or delete it first.', 'warn'); return; }
    confirmDialog({
      title: 'Leave ' + server.name + '?', message: 'You can rejoin later with a new invite.', danger: true, confirmText: 'Leave',
      onConfirm: async () => {
        try {
          await Api.leaveServer(serverId);
          await refreshServers();
          leaveServerContext();
          location.hash = '#/home';
        } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      },
    });
  });
  card.appendChild(leaveBtn);

  if (server.is_owner) {
    card.appendChild(el('div', { class: 'hr' }));
    const delInput = el('input', { class: 'input', type: 'text', placeholder: 'Type server name to confirm' });
    const delBtn = el('button', { class: 'btn danger block', type: 'button', style: { marginTop: 'var(--t-d-3)' } }, 'Delete server');
    card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Danger zone — delete server'), delInput, delBtn));
    delBtn.addEventListener('click', async () => {
      if (delInput.value.trim() !== server.name) { toast('Type the exact server name to confirm.', 'warn'); return; }
      confirmDialog({
        title: 'Delete ' + server.name + '?',
        message: 'This permanently deletes the server, its channels, messages and members. This cannot be undone.',
        danger: true, confirmText: 'Delete forever',
        onConfirm: async () => {
          try {
            await Api.deleteServer(serverId);
            await refreshServers();
            leaveServerContext();
            toast('Server deleted.', 'warn');
            location.hash = '#/home';
          } catch (ex) { toast(ex.message || 'Failed', 'error'); }
        },
      });
    });
  }

  wrap.appendChild(card);
  container.appendChild(wrap);
}

// ---- new server -------------------------------------------------------------

async function renderNewServer(container, serverId) {
  clear(container);
  if (serverId) container.classList.add('hide-nav'); // not used by desktop chrome
  renderContextHeader({ title: 'Create a server' });
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  const err = el('div', { class: 'form-error', hidden: true });
  const name = el('input', { class: 'input', type: 'text', placeholder: 'My community', maxlength: 64, required: true });
  const desc = el('textarea', { class: 'textarea', placeholder: 'What is your community about? (optional)', maxlength: 400 });
  const joinCode = el('input', { class: 'input', type: 'text', placeholder: 'Public code (letters + numbers, optional)', maxlength: 32 });
  const isPublic = el('input', { type: 'checkbox', checked: true });
  const isDisc = el('input', { type: 'checkbox', checked: true });
  const createBtn = el('button', { class: 'btn primary block', type: 'submit' }, 'Create server');

  const form = el('form', {}, err,
    el('div', { class: 'field' }, el('label', {}, 'Server name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Description'), desc),
    el('div', { class: 'field' }, el('label', {}, 'Join code'), joinCode,
      el('span', { class: 'hint' }, 'Leave blank to auto-generate one.')),
    el('div', { class: 'field' }, el('label', { class: 'switch' }, isPublic, ' Public — joinable by code or invite link')),
    el('div', { class: 'field' }, el('label', { class: 'switch' }, isDisc, ' Discoverable in the browse feed')),
    createBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    createBtn.setAttribute('aria-busy', 'true');
    try {
      const res = await Api.createServer({
        name: name.value.trim(),
        description: desc.value.trim() || undefined,
        joinCode: joinCode.value.trim() || undefined,
        isPublic: isPublic.checked,
        isDiscoverable: isDisc.checked,
      });
      toast('Server created!', 'ok');
      await refreshServers();
      const sid = res.serverId;
      location.hash = '#/server/' + sid + '/channel/' + res.channelId;
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Failed';
    } finally {
      createBtn.removeAttribute('aria-busy');
    }
  });

  card.appendChild(el('h1', {}, 'Create a server'));
  card.appendChild(el('p', { class: 'auth-sub' }, 'A permanent place for your community to gather.'));
  card.appendChild(form);
  wrap.appendChild(card);
  container.appendChild(wrap);
}

export default {
  renderServerLanding,
  renderChannel,
  renderNewChannel,
  renderInvites,
  renderServerSettings,
  renderServerMembers,
  renderServerRoles,
  renderServerCategories,
  renderNewServer,
};
