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
} from './state.js';
import { esc, el, clear, toast, relTime, confirmDialog } from './ui.js';
import { avatar, emptyState, messageRow, channelRow } from './components.js';
import { renderContextHeader, renderAllChrome, renderCommunities, renderPlaceNavigation } from './shell.js';
import Realtime from './realtime.js';

let activeChannelId = null;

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
  for (const m of (State.members || []).slice(0, 24)) {
    const row = el('div', { class: 'row' });
    row.appendChild(avatar({ id: m.user_id || m.id, username: m.username, displayName: m.display_name }, { withPresence: true }));
    const mm = el('div', { class: 'row-main' });
    mm.appendChild(el('div', { class: 'row-title' }, m.display_name || m.username));
    mm.appendChild(el('div', { class: 'row-sub' }, '@' + (m.username || '')));
    row.appendChild(mm);
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
  renderAllChrome();
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
  renderContextHeader({ title: '#' + chanName, sub: (channel && channel.topic) ? esc(channel.topic) : server.name });

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
    thread.scrollTop = thread.scrollHeight;
  }

  function buildMsg(m) {
    return messageRow(m, {
      meId: State.me && State.me.id,
      onEdit: () => editMsg(m),
      onDelete: () => deleteMsg(m),
      onDownload: (e, att) => downloadAtt(e, att),
    });
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
      feed.appendChild(messageRow(m, { meId: State.me && State.me.id, onEdit: () => editMsg(m), onDelete: () => deleteMsg(m), onDownload: downloadAtt }));
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
  renderAllChrome();
}

// ---- create channel ---------------------------------------------------------

async function renderNewChannel(container, serverId) {
  clear(container);
  try { await ensureServer(serverId); } catch { /* toast below */ }
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
  renderNewServer,
};