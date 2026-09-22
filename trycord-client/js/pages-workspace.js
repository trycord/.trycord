/* Server workspace: header + tabs (overview, chat, members, roles,
   invites, settings) gated by backend permissions. Server state always
   comes from the API; the client never invents it. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  var cleanupFn = null;
  function cleanup() {
    if (cleanupFn) {
      try { cleanupFn(); } catch (e) { /* closing */ }
      cleanupFn = null;
    }
    var panel = TrycordShell.el('member-panel');
    if (panel) panel.hidden = true;
  }

  function can(serverId, perm) {
    return window.TrycordState && TrycordState.can(serverId, perm);
  }

  function tabsFor(detail) {
    var tabs = [
      ['overview', 'Overview'],
      ['chat', 'Chat'],
      ['members', 'Members'],
    ];
    if (can(detail.id, 'MANAGE_ROLES')) tabs.push(['roles', 'Roles']);
    if (can(detail.id, 'MANAGE_INVITES')) tabs.push(['invites', 'Invites']);
    if (can(detail.id, 'MANAGE_SERVER')) tabs.push(['settings', 'Settings']);
    return tabs;
  }

  async function workspace(root, serverId, tab, deepChannelId) {
    var detail;
    try {
      detail = await TrycordApi.serverDetail(serverId);
    } catch (e) {
      C.setTopbar('Server', '', '', 'i-grid');
      C.hideServerNav();
      root.innerHTML = Ui.errorState(e.message, 'Back to servers');
      var rb = root.querySelector('[data-retry]');
      if (rb) rb.onclick = () => { location.hash = '#/servers'; };
      return;
    }
    TrycordState.setPerms(detail.id, { is_owner: !!detail.is_owner, permissions: detail.permissions || [] });
    TrycordState.touchRecent(detail.id);

    var tabs = tabsFor(detail);
    tab = tab || 'overview';
    if (!tabs.some((t) => t[0] === tab)) tab = 'overview';

    // Persistent context nav: header + channels.
    renderNav(detail, tab === 'chat' ? deepChannelId : null);
    C.setTopbar(detail.name, tab === 'overview' ? (detail.description || 'Server overview.') : tabLabel(tabs, tab),
      '<button type="button" class="icon-btn" data-srv-menu title="Server actions" aria-label="Server actions" aria-haspopup="menu"><svg aria-hidden="true"><use href="#i-dots"/></svg></button>' +
      C.favStar(detail.id, TrycordState.isFav(detail.id)),
      'i-grid');
    var menuBtn = TrycordShell.q('#topbar-actions [data-srv-menu]');
    if (menuBtn) {
      menuBtn.onclick = (e) => {
        var r = menuBtn.getBoundingClientRect();
        serverMenu(r.left, r.bottom + 4, detail);
      };
    }
    var favBtn = TrycordShell.q('#topbar-actions [data-fav]');
    if (favBtn) {
      favBtn.onclick = (e) => {
        e.stopPropagation();
        var nowFav = TrycordState.toggleFav(detail.id);
        C.renderRail('#/servers');
        renderNav(detail, tab === 'chat' ? deepChannelId : null);
      };
    }

    if (tab === 'overview') return renderOverview(root, detail);
    if (tab === 'chat') return renderChat(root, detail, deepChannelId);
    if (tab === 'members') return renderMembers(root, detail);
    if (tab === 'roles') return renderRoles(root, detail);
    if (tab === 'invites') return renderInvites(root, detail);
    if (tab === 'settings') return renderSettings(root, detail);
  }

  function tabLabel(tabs, tab) {
    var found = tabs.filter((t) => t[0] === tab)[0];
    return found ? found[1] : '';
  }

  function tabBar(detail, active) {
    return '<div class="tabs" role="tablist" style="margin-bottom:var(--tc-space-5);">' +
      tabsFor(detail).map((t) =>
        '<a role="tab" class="tab' + (t[0] === active ? ' active' : '') + '" aria-selected="' + (t[0] === active) + '"' +
        ' href="#/server/' + encodeURIComponent(detail.id) + '/' + t[0] + '">' + Ui.esc(t[1]) + '</a>'
      ).join('') + '</div>';
  }

  // ---------- context nav ----------

  function renderNav(detail, activeChannelId) {
    var manageChannels = can(detail.id, 'MANAGE_CHANNELS');
    TrycordApi.categories(detail.id).then((cats) => TrycordApi.channels(detail.id).then((channels) => {
      var byCat = {};
      var uncategorized = [];
      channels.forEach((ch) => {
        if (ch.category_id && cats.some((c) => c.id === ch.category_id)) {
          (byCat[ch.category_id] = byCat[ch.category_id] || []).push(ch);
        } else uncategorized.push(ch);
      });
      var html =
        '<div class="srv-head"><span>' + Ui.avatarHtml(detail.name, '') + '</span>' +
        '<div class="titles"><h2>' + Ui.esc(detail.name) + '</h2>' +
        '<div class="sub">' + (detail.member_count || 0) + ' members' +
        (detail.is_public ? ' · Public' : ' · Private') + '</div></div></div>';
      function chanBtn(ch) {
        var on = String(activeChannelId || '') === String(ch.id);
        return '<div class="chan" data-chan="' + Ui.esc(ch.id) + '">' +
          '<button type="button" class="chan-btn' + (on ? ' active' : '') + '" data-open-chan="' + Ui.esc(ch.id) + '"' +
          (on ? ' aria-current="page"' : '') + '>' +
          '<svg aria-hidden="true"><use href="#i-hash"/></svg>' +
          '<span class="lbl">' + Ui.esc(ch.name) + '</span></button>' +
          (manageChannels ? '<button type="button" class="icon-btn chan-del chan-x" data-del-chan="' + Ui.esc(ch.id) + '" title="Delete channel" aria-label="Delete channel ' + Ui.esc(ch.name) + '">×</button>' : '') +
          '</div>';
      }
      if (uncategorized.length) {
        html += '<div class="cat-block">' + uncategorized.map(chanBtn).join('') + '</div>';
      }
      cats.forEach((cat) => {
        html += '<div class="cat-block"><button type="button" class="cat-head" data-cat="' + Ui.esc(cat.id) + '" aria-expanded="true">' +
          '<svg aria-hidden="true"><use href="#i-chev"/></svg><span class="grow">' + Ui.esc(cat.name) + '</span>' +
          (manageChannels ? '<span class="icon-btn" style="width:1.4rem;height:1.4rem;" data-add-chan="' + Ui.esc(cat.id) + '" title="New channel" role="button" tabindex="0">+</span>' : '') +
          '</button><div data-cat-body="' + Ui.esc(cat.id) + '">' + (byCat[cat.id] || []).map(chanBtn).join('') + '</div></div>';
      });
      if (manageChannels) {
        html += '<div class="srv-actions" style="padding:var(--tc-space-1) var(--tc-space-2);">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-new-chan>New channel</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-new-cat>New category</button></div>';
      }
      C.renderServerNav(html, true);
      wireNav(detail);
    })).catch(() => {
      C.renderServerNav(
        '<div class="srv-head"><div class="titles"><h2>' + Ui.esc(detail.name) + '</h2></div></div>' +
        '<p class="text-muted text-sm" style="padding:0 var(--tc-space-2);">Couldn\'t load channels.</p>', true);
    });
  }

  function wireNav(detail) {
    var body = TrycordShell.el('server-nav-body');
    if (!body) return;
    body.querySelectorAll('[data-open-chan]').forEach((b) => {
      b.onclick = () => { location.hash = '#/server/' + encodeURIComponent(detail.id) + '/chat/' + encodeURIComponent(b.dataset.openChan); };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        chanMenu(b, e.clientX, e.clientY, detail);
      };
    });
    Ui.bindLongPress(body, '[data-open-chan]', (el, x, y) => chanMenu(el, x, y, detail));
    body.querySelectorAll('[data-del-chan]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); deleteChannel(detail, b.dataset.delChan); };
    });
    body.querySelectorAll('.cat-head').forEach((h) => {
      h.onclick = (e) => {
        if (e.target.closest('[data-add-chan]')) return;
        var id = h.dataset.cat;
        var pane = body.querySelector('[data-cat-body="' + id + '"]');
        var closed = h.classList.toggle('closed');
        h.setAttribute('aria-expanded', String(!closed));
        if (pane) pane.hidden = closed;
      };
    });
    body.querySelectorAll('[data-add-chan]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); channelModal(detail, b.dataset.addChan); };
    });
    var nc = body.querySelector('[data-new-chan]');
    if (nc) nc.onclick = () => channelModal(detail, null);
    var ncat = body.querySelector('[data-new-cat]');
    if (ncat) ncat.onclick = () => categoryModal(detail);
  }

  function chanMenu(b, x, y, detail) {
    Ui.contextMenu(x, y, [
      { label: 'Open channel', icon: 'i-hash', onClick: () => { location.hash = '#/server/' + encodeURIComponent(detail.id) + '/chat/' + encodeURIComponent(b.dataset.openChan); } },
      { label: 'Copy channel name', icon: 'i-copy', onClick: () => C.copyText(b.querySelector('.lbl').textContent, 'Channel name copied.') },
      { label: 'Delete channel', icon: 'i-trash', danger: true, hidden: !can(detail.id, 'MANAGE_CHANNELS'), onClick: () => deleteChannel(detail, b.dataset.openChan) },
    ]);
  }

  async function deleteChannel(detail, channelId) {
    var yes = await Ui.confirmDialog({ title: 'Delete channel?', message: 'Messages in this channel are deleted too. This cannot be undone.', confirmText: 'Delete' });
    if (!yes) return;
    try {
      await TrycordApi.deleteChannel(detail.id, channelId);
      Ui.toast('Channel deleted.', 'success');
      renderNav(detail, null);
      if ((location.hash || '').indexOf('/chat/' + channelId) !== -1) location.hash = '#/server/' + encodeURIComponent(detail.id) + '/chat';
      else window.TrycordRouter.route();
    } catch (e) { Ui.toast(e.message, 'error'); }
  }

  function channelModal(detail, categoryId) {
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="form-group"><label class="form-label" for="chn-name">Channel name</label>' +
      '<input type="text" id="chn-name" class="form-input" maxlength="64" placeholder="e.g. general" /></div>' +
      '<div class="form-group"><label class="form-label" for="chn-topic">Topic (optional)</label>' +
      '<input type="text" id="chn-topic" class="form-input" maxlength="200" placeholder="What is this channel about?" /></div>';
    Ui.openModal({
      title: 'New channel', body,
      actions: [{ id: 'cancel', label: 'Cancel' }, {
        id: 'create', label: 'Create channel', primary: true,
        onClick: (close) => {
          var nameEl = body.querySelector('#chn-name');
          var name = nameEl.value.trim().replace(/^#+/, '');
          if (!name) { Ui.fieldError(nameEl, 'Give the channel a name.'); return; }
          TrycordApi.createChannel(detail.id, { name, topic: body.querySelector('#chn-topic').value.trim(), categoryId: categoryId || undefined })
            .then(() => { close(); Ui.toast('Channel created.', 'success'); renderNav(detail, null); window.TrycordRouter.route(); })
            .catch((e) => Ui.toast(e.message, 'error'));
        },
      }],
    });
    setTimeout(() => { var i = body.querySelector('#chn-name'); if (i) i.focus(); }, 0);
  }

  function categoryModal(detail) {
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="form-group"><label class="form-label" for="cat-name">Category name</label>' +
      '<input type="text" id="cat-name" class="form-input" maxlength="64" placeholder="e.g. Text channels" /></div>';
    Ui.openModal({
      title: 'New category', body,
      actions: [{ id: 'cancel', label: 'Cancel' }, {
        id: 'create', label: 'Create category', primary: true,
        onClick: (close) => {
          var nameEl = body.querySelector('#cat-name');
          var name = nameEl.value.trim();
          if (!name) { Ui.fieldError(nameEl, 'Give the category a name.'); return; }
          TrycordApi.createCategory(detail.id, { name })
            .then(() => { close(); Ui.toast('Category created.', 'success'); renderNav(detail, null); })
            .catch((e) => Ui.toast(e.message, 'error'));
        },
      }],
    });
    setTimeout(() => { var i = body.querySelector('#cat-name'); if (i) i.focus(); }, 0);
  }

  function serverMenu(x, y, detail) {
    var items = [
      { label: 'Copy server ID', icon: 'i-copy', onClick: () => C.copyText(detail.id, 'Server ID copied.') },
    ];
    if (detail.join_code) {
      items.push({ label: 'Copy invite code', icon: 'i-copy', onClick: () => C.copyText(detail.join_code, 'Invite code copied.') });
    }
    if (can(detail.id, 'MANAGE_SERVER')) {
      items.push({ label: 'Server settings', icon: 'i-cog', onClick: () => { location.hash = '#/server/' + encodeURIComponent(detail.id) + '/settings'; } });
    }
    items.push({ label: detail.is_owner ? 'Delete server' : 'Leave server', icon: 'i-out', danger: true, onClick: () => leaveOrDelete(detail) });
    Ui.contextMenu(x, y, items);
  }

  async function leaveOrDelete(detail) {
    var yes = await Ui.confirmDialog({
      title: detail.is_owner ? 'Delete server?' : 'Leave server?',
      message: detail.is_owner ? 'The server, its channels, and all messages are permanently deleted.' : 'You will need a new invite to rejoin.',
      confirmText: detail.is_owner ? 'Delete' : 'Leave',
    });
    if (!yes) return;
    try {
      if (detail.is_owner) await TrycordApi.deleteServer(detail.id);
      else await TrycordApi.leaveServer(detail.id);
      await Trycord.refreshServers();
      Ui.toast(detail.is_owner ? 'Server deleted.' : 'Left the server.', 'success');
      location.hash = '#/servers';
    } catch (e) { Ui.toast(e.message, 'error'); }
  }

  // ---------- overview ----------

  async function renderOverview(root, detail) {
    C.setTopbar(detail.name, detail.description || 'Server overview.',
      '<a class="btn btn-primary btn-sm" href="#/server/' + encodeURIComponent(detail.id) + '/chat">Open chat</a>', 'i-grid');
    var activity = [];
    try { activity = await TrycordApi.activity(20); } catch (e) { /* optional */ }
    var mine = activity.filter((a) => String(a.server_id) === String(detail.id)).slice(0, 5);
    root.innerHTML = tabBar(detail, 'overview') +
      '<div class="tc-cluster" style="margin-bottom:var(--tc-space-5);">' +
      stat(detail.member_count, 'Members') + stat(detail.channel_count, 'Channels') +
      stat(detail.message_count, 'Messages') + stat(Ui.fullDate(detail.created_at).split(',')[0], 'Created') +
      '</div>' +
      '<h2 class="tc-h2" style="margin-bottom:var(--tc-space-3);">Recent activity</h2>' +
      (mine.length
        ? '<ul class="msg-list" style="padding:0;">' + mine.map((a) =>
          '<li class="msg"><span class="gutter">' + Ui.avatarHtml(a.author_display || a.author_name, '') + '</span>' +
          '<div class="body"><div class="head"><span class="author">' + Ui.esc(a.author_display || a.author_name) + '</span>' +
          '<span class="time">in #' + Ui.esc(a.channel_name) + ' · ' + Ui.esc(Ui.timeAgo(a.created_at)) + '</span></div>' +
          '<div class="text">' + Ui.esc(a.content) + '</div></div></li>').join('') + '</ul>'
        : Ui.emptyState({ icon: Ui.icons.clock, title: 'Nothing here yet.', hint: 'Activity in this server will show up here.' }));
    function stat(num, lbl) {
      return '<div class="stat" style="flex:1;min-width:9rem;"><div class="num">' + Ui.esc(String(num === undefined || num === null ? '–' : num)) + '</div><div class="lbl">' + Ui.esc(lbl) + '</div></div>';
    }
  }

  // ---------- chat ----------

  async function renderChat(root, detail, deepChannelId) {
    var channels = [];
    var cats = [];
    try {
      cats = await TrycordApi.categories(detail.id);
      channels = await TrycordApi.channels(detail.id);
    } catch (e) {
      root.innerHTML = tabBar(detail, 'chat') + Ui.errorState(e.message, 'Retry');
      var rb = root.querySelector('[data-retry]');
      if (rb) rb.onclick = () => renderChat(root, detail, deepChannelId);
      return;
    }
    if (!channels.length) {
      C.setTopbar(detail.name, 'No channels yet.', '', 'i-hash');
      root.innerHTML = tabBar(detail, 'chat') +
        Ui.emptyState({
          icon: Ui.icons.channel, title: 'No channels yet.',
          hint: can(detail.id, 'MANAGE_CHANNELS') ? 'Create the first channel to start talking.' : 'Ask a moderator to create a channel.',
          actions: can(detail.id, 'MANAGE_CHANNELS') ? '<button type="button" class="btn btn-primary" data-new-chan2>New channel</button>' : '',
        });
      var nc = root.querySelector('[data-new-chan2]');
      if (nc) nc.onclick = () => channelModal(detail, null);
      return;
    }
    var ch = channels.find((c) => String(c.id) === String(deepChannelId)) || channels[0];
    C.setTopbar(ch.name, ch.topic || ('Channel in ' + detail.name),
      '<button type="button" class="icon-btn" data-members title="Members" aria-label="Members"><svg aria-hidden="true"><use href="#i-users"/></svg></button>', 'i-hash');
    var mb = TrycordShell.q('#topbar-actions [data-members]');
    if (mb) mb.onclick = () => { location.hash = '#/server/' + encodeURIComponent(detail.id) + '/members'; };

    root.innerHTML = tabBar(detail, 'chat') +
      '<ul class="msg-list" id="msg-list" aria-label="Messages"></ul>' +
      '<div class="typing-row" id="chat-typing" aria-live="polite"></div>' +
      '<form class="composer" id="composer">' +
      '<div class="attachment-row" id="attachment-row" hidden></div>' +
      '<div class="composer-box">' +
      '<button type="button" class="icon-btn composer-attach" id="attach-btn" aria-label="Attach a file" title="Attach a file (max 8 MB)"><svg aria-hidden="true"><use href="#i-paperclip"/></svg></button>' +
      '<textarea id="msg-input" rows="1" placeholder="Message #' + Ui.esc(ch.name) + '" aria-label="Message text"></textarea>' +
      '<button type="submit" class="composer-send" id="msg-send" aria-label="Send message"><svg aria-hidden="true"><use href="#i-send"/></svg></button>' +
      '</div>' +
      '<div class="composer-hint">Enter to send · Shift+Enter for a new line</div>' +
      '</form>' +
      navigator.maxTouchPoints && navigator.maxTouchPoints > 0
        ? '<div class="keyboard-inset" id="keyboard-inset" aria-hidden="true"></div>'
        : '';

    var listEl = root.querySelector('#msg-list');
    var input = root.querySelector('#msg-input');
    var renderedIds = {};
    var rendered = [];
    var hasMore = true;
    var loadingMore = false;
    var manager = can(detail.id, 'MANAGE_MESSAGES');
    var me = TrycordState.user;

    (function keyboardInset() {
      var inset = root.querySelector('#keyboard-inset');
      if (!inset || !window.visualViewport) return;
      var height, raf = 0;
      function update() {
        var vv = window.visualViewport;
        var h = Math.max(0, Math.min(vv.height * 0.5, window.innerHeight - vv.height));
        if (h === height) return;
        height = h;
        inset.style.height = h ? h + 'px' : '';
      }
      function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); }
      window.visualViewport.addEventListener('resize', schedule);
      window.visualViewport.addEventListener('scroll', schedule);
      window.addEventListener('resize', schedule);
      schedule();
    })();

    function groupable(prev, m) {
      if (!prev || String(prev.author_id) !== String(m.author_id)) return false;
      var dt = new Date(m.created_at) - new Date(prev.created_at);
      return dt >= 0 && dt < 5 * 60 * 1000;
    }

    function paint(forceBottom, keepPos) {
      var prevHeight = keepPos ? listEl.scrollHeight : 0;
      var prevTop = keepPos ? listEl.scrollTop : 0;
      listEl.innerHTML = rendered.map((m, i) => C.renderMessage({
        id: m.id, content: m.content, createdAt: m.created_at,
        editedAt: m.edited_at || null,
        authorId: m.author_id, authorName: m.author_display || m.author_name,
        attachments: m.attachments || [],
      }, {
        grouped: i > 0 && groupable(rendered[i - 1], m),
        canDelete: String(m.author_id) === String(me.id) || manager,
        canEdit: String(m.author_id) === String(me.id),
      })).join('');
      C.wireMessageList(listEl, {
        onDelete: (mid) => {
          TrycordApi.deleteMessage(ch.id, mid).catch((e) => Ui.toast(e.message, 'error'));
        },
        onEdit: (mid) => editMessage(mid),
      });
      if (forceBottom) listEl.scrollTop = listEl.scrollHeight;
      else if (keepPos) listEl.scrollTop = listEl.scrollHeight - prevHeight + prevTop;
    }

    function addMessages(arr, toBottom) {
      var added = false;
      arr.forEach((m) => {
        if (renderedIds[m.id]) return;
        renderedIds[m.id] = true;
        rendered.push(m);
        added = true;
      });
      if (!added) return;
      rendered.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
      var nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 160;
      paint(toBottom || nearBottom, added && !toBottom && !nearBottom);
    }

    // Realtime or PATCH-response driven content replacement. Never
    // reorders, never refetches: the entry keeps its position.
    function applyUpdatedMessage(ev) {
      var idx = -1;
      rendered.forEach((m, i) => { if (String(m.id) === String(ev.id)) idx = i; });
      if (idx === -1) return false;
      rendered[idx] = Object.assign({}, rendered[idx], { content: ev.content, edited_at: ev.edited_at || null });
      paint(false, false);
      return true;
    }

    function editMessage(mid) {
      var m = rendered.find((x) => String(x.id) === String(mid));
      if (!m || String(m.author_id) !== String(me.id)) return;
      C.openEditModal(m.content, (text) =>
        TrycordApi.patchMessage(ch.id, mid, text).then((out) => {
          applyUpdatedMessage({ id: mid, content: out.content, edited_at: out.edited_at || null });
        })
      );
    }

    // Channel-specific loading state: never show the previous channel's
    // messages under this channel's header. Replaced by content, empty,
    // or error below.
    listEl.innerHTML = '<li style="list-style:none;" aria-hidden="true">' + Ui.skeletons(6) + '</li>';

    try {
      var first = await TrycordApi.messages(ch.id, 50);
      if (first.length >= 50) hasMore = true; else hasMore = false;
      if (!first.length) {
        listEl.innerHTML = '<li style="list-style:none;"><div style="max-width:26rem;margin:var(--tc-space-8) auto;text-align:center;">' +
          '<div class="empty-state-icon" aria-hidden="true">#</div>' +
          '<h3 class="empty-state-title">Welcome to #' + Ui.esc(ch.name) + '</h3>' +
          '<p class="empty-state-text">This is the beginning of the conversation. Start something worth talking about.</p></div></li>';
      } else {
        addMessages(first, true);
      }
    } catch (e) {
      listEl.innerHTML = '<li style="list-style:none;">' + Ui.errorState(e.message, 'Retry') + '</li>';
      var rb2 = listEl.querySelector('[data-retry]');
      if (rb2) rb2.onclick = () => renderChat(root, detail, ch.id);
      return;
    }

    listEl.addEventListener('scroll', () => {
      if (listEl.scrollTop > 140 || loadingMore || !hasMore || !rendered.length) return;
      loadingMore = true;
      var oldest = rendered[0];
      TrycordApi.messages(ch.id, 50, oldest.id).then((older) => {
        if (!Array.isArray(older) || older.length < 50) hasMore = false;
        var fresh = (Array.isArray(older) ? older : []).filter((m) => !renderedIds[m.id]);
        fresh.forEach((m) => { renderedIds[m.id] = true; });
        rendered = fresh.concat(rendered);
        paint(false, true);
      }).catch(() => {}).finally(() => { loadingMore = false; });
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 192) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        root.querySelector('#composer').requestSubmit();
      }
    });
    var sendBtn = root.querySelector('#msg-send');
    var attachBtn = root.querySelector('#attach-btn');
    var attachRow = root.querySelector('#attachment-row');
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json';
    fileInput.hidden = true;
    root.querySelector('#composer').appendChild(fileInput);

    // Files staged for the next message. Upload happens on send (never on
    // select) so removing a chip can't strand orphaned uploads on the server.
    var pending = [];
    function fmtBytes(n) {
      n = parseInt(n, 10) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function renderChips() {
      if (!pending.length) { attachRow.hidden = true; attachRow.innerHTML = ''; return; }
      attachRow.hidden = false;
      attachRow.innerHTML = pending.map((f, i) =>
        '<span class="attach-chip' + (f.status === 'failed' ? ' is-error' : '') + '">' +
        '<svg class="attach-chip-ic" aria-hidden="true"><use href="#i-paperclip"/></svg>' +
        '<span class="attach-chip-name" title="' + Ui.esc(f.file.name) + '">' + Ui.esc(f.file.name) + '</span>' +
        '<span class="attach-chip-meta">' + (f.status === 'uploading' ? 'Uploading…'
          : f.status === 'failed' ? 'Upload failed'
            : fmtBytes(f.file.size)) + '</span>' +
        (f.status === 'uploading' ? ''
          : '<button type="button" class="icon-btn" data-remove="' + i + '" aria-label="Remove ' + Ui.esc(f.file.name) + '"><svg aria-hidden="true"><use href="#i-x"/></svg></button>') +
        '</span>'
      ).join('');
      attachRow.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = () => {
          var idx = parseInt(b.dataset.remove, 10);
          if (pending[idx] && pending[idx].status !== 'uploading') {
            pending.splice(idx, 1);
            renderChips();
          }
        };
      });
    }
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      var files = Array.prototype.slice.call(fileInput.files || []);
      files.forEach((f) => {
        if (f.size > 8 * 1024 * 1024) {
          Ui.toast('"' + f.name + '" is larger than 8 MB.', 'error');
          return;
        }
        pending.push({ file: f, status: 'ready' });
      });
      fileInput.value = '';
      renderChips();
    };

    root.querySelector('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      var text = input.value.trim();
      var files = pending.slice();
      if (!text && !files.length) return;
      Ui.setLoading(sendBtn, true, '…');
      files.forEach((f) => { f.status = 'uploading'; });
      renderChips();
      // Upload every staged file, then send one message carrying all ids.
      var uploadsReady = files.map((f) =>
        TrycordApi.uploadAttachment(ch.id, f.file)
          .then((a) => { f.status = 'ready'; f.id = a && a.id; })
          .catch((err) => { f.status = 'failed'; throw err; })
      );
      Promise.all(uploadsReady)
        .then(() => {
          var ids = files.filter((f) => f.id).map((f) => f.id);
          return TrycordApi.postMessage(ch.id, text, ids);
        })
        .then((m) => {
          input.value = '';
          input.style.height = 'auto';
          pending = [];
          renderChips();
          addMessages([Object.assign(m, { author_display: m.author_display || (me.displayName || me.username), author_name: me.username })], true);
        })
        .catch((err) => {
          renderChips();
          Ui.toast(err.message, 'error');
        })
        .finally(() => Ui.setLoading(sendBtn, false));
    });

    listEl.oncontextmenu = (e) => {
      var li = e.target.closest('[data-mid]');
      if (!li) return;
      e.preventDefault();
      var m = rendered.find((x) => String(x.id) === String(li.dataset.mid));
      if (!m) return;
      var mine = String(m.author_id) === String(me.id);
      Ui.contextMenu(e.clientX, e.clientY, [
        { label: 'Copy text', icon: 'i-copy', onClick: () => C.copyText(li.querySelector('.text').textContent, 'Message copied.') },
        { label: 'Edit message', icon: 'i-pen', hidden: !mine, onClick: () => editMessage(m.id) },
        { label: 'Delete message', icon: 'i-trash', danger: true, hidden: !(mine || manager), onClick: () => TrycordApi.deleteMessage(ch.id, m.id).catch((err) => Ui.toast(err.message, 'error')) },
      ]);
    };

    cleanupFn = C.connectSocket({
      onOpen: (sock) => {
        try { sock.send(JSON.stringify({ type: 'join', channelId: ch.id })); } catch (e) {}
      },
      onStatus: (st) => {
        if (st !== 'connected') Trycord.setOnline(false);
        else Trycord.setOnline(true);
      },
      onEvent: (ev) => {
        if (ev.type === 'message' && String(ev.channel_id) === String(ch.id)) {
          // Wire shape (snake_case) -> view shape used by this page.
          addMessages([{
            id: ev.id, content: ev.content, created_at: ev.created_at,
            author_id: ev.author_id, author_display: ev.user, author_name: ev.user,
            attachments: ev.attachments || [],
          }], false);
        } else if (ev.type === 'message_deleted' && String(ev.channel_id) === String(ch.id)) {
          delete renderedIds[ev.id];
          rendered = rendered.filter((m) => String(m.id) !== String(ev.id));
          paint(false, false);
        } else if (ev.type === 'message_updated' && String(ev.channel_id) === String(ch.id)) {
          applyUpdatedMessage(ev);
        } else {
          C.handleSignal(ev, {});
        }
      },
    });
  }

  // ---------- members ----------

  async function renderMembers(root, detail) {
    C.setTopbar(detail.name, 'Member list.', '', 'i-users');
    var members = [];
    var allRoles = [];
    try {
      members = await TrycordApi.serverMembers(detail.id);
      if (can(detail.id, 'MANAGE_ROLES')) allRoles = await TrycordApi.roles(detail.id);
    } catch (e) {
      root.innerHTML = tabBar(detail, 'members') + Ui.errorState(e.message, 'Retry');
      var rb = root.querySelector('[data-retry]');
      if (rb) rb.onclick = () => renderMembers(root, detail);
      return;
    }
    var online = [];
    try {
      var pres = await TrycordApi.presence(members.map((m) => m.id));
      members.forEach((m) => { m.presence = (pres && pres[m.id]) || 'offline'; });
    } catch (e) { /* presence optional */ }
    online = members.filter((m) => m.presence === 'online');
    var offline = members.filter((m) => m.presence !== 'online');
    function row(m) {
      var self = TrycordState.user && String(m.id) === String(TrycordState.user.id);
      var canMod = can(detail.id, 'KICK_MEMBERS') && !self && !m.is_owner;
      return '<div class="member-row" data-user="' + Ui.esc(m.id) + '">' +
        C.presenceAvatar(m.display_name || m.username, '', m.presence) +
        '<span class="who"><span class="name">' + Ui.esc(m.display_name || m.username) +
        (m.is_owner ? ' ' + Ui.badge('Owner', 'owner') : '') + '</span>' +
        '<span class="sub">@' + Ui.esc(m.username) +
        (m.roles && m.roles.length ? ' · ' + Ui.esc(m.roles.map((r) => r.name).join(', ')) : '') + '</span></span>' +
        (can(detail.id, 'MANAGE_ROLES') && !self ? '<button type="button" class="btn btn-ghost btn-sm" data-roles>Roles</button>' : '') +
        (canMod ? '<button type="button" class="btn btn-ghost btn-sm" data-kick>Kick</button>' : '') + '</div>';
    }
    root.innerHTML = tabBar(detail, 'members') +
      '<div class="nav-label">Online — ' + online.length + '</div>' +
      (online.length ? online.map(row).join('') : '<p class="text-muted text-sm">Nobody\'s online right now.</p>') +
      '<div class="nav-label">Offline — ' + offline.length + '</div>' +
      (offline.length ? offline.map(row).join('') : '<p class="text-muted text-sm">Nobody here yet.</p>');
    root.querySelectorAll('.member-row[data-user]').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('button')) return;
        C.openProfileModal(el.dataset.user);
      };
    });
    root.querySelectorAll('[data-roles]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        var m = members.find((x) => String(x.id) === String(b.closest('[data-user]').dataset.user));
        if (m) roleAssignModal(detail, m, allRoles, () => renderMembers(root, detail));
      };
    });
    root.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        var id = b.closest('[data-user]').dataset.user;
        var yes = await Ui.confirmDialog({ title: 'Kick member?', message: 'They can rejoin with a new invite.', confirmText: 'Kick' });
        if (!yes) return;
        TrycordApi.kickMember(detail.id, id)
          .then(() => { Ui.toast('Member kicked.', 'success'); renderMembers(root, detail); })
          .catch((err) => Ui.toast(err.message, 'error'));
      };
    });
  }

  function roleAssignModal(detail, member, allRoles, onDone) {
    var body = document.createElement('div');
    body.innerHTML = '<p class="text-muted text-sm">Roles for <b>' + Ui.esc(member.display_name || member.username) + ':</p>' +
      (allRoles.length ? allRoles.map((r) => {
        var has = member.roles.some((x) => String(x.id) === String(r.id));
        return '<label class="form-check" style="margin-bottom:var(--tc-space-2);"><input type="checkbox" class="form-check-input" data-role="' + Ui.esc(r.id) + '"' + (has ? ' checked' : '') + ' />' +
          '<span class="form-check-label">' + Ui.esc(r.name) + (r.is_default ? ' (default)' : '') + '</span></label>';
      }).join('') : '<p class="text-muted text-sm">No roles in this server yet.</p>');
    Ui.openModal({
      title: 'Member roles', body,
      actions: [{ id: 'done', label: 'Done', primary: true }],
      onClose: () => {},
    });
    body.querySelectorAll('[data-role]').forEach((box) => {
      box.onchange = () => {
        var rid = box.dataset.role;
        var had = member.roles.some((x) => String(x.id) === String(rid));
        var p = box.checked && !had
          ? TrycordApi.assignRole(detail.id, rid, member.id)
          : !box.checked && had
            ? TrycordApi.unassignRole(detail.id, rid, member.id)
            : Promise.resolve();
        p.then(() => {
          if (box.checked && !had) member.roles.push(allRoles.find((r) => String(r.id) === String(rid)));
          if (!box.checked && had) member.roles = member.roles.filter((x) => String(x.id) !== String(rid));
          if (onDone) onDone();
          Ui.toast('Roles updated.', 'success');
        }).catch((e) => {
          box.checked = had;
          Ui.toast(e.message, 'error');
        });
      };
    });
  }

  // ---------- roles ----------

  async function renderRoles(root, detail) {
    C.setTopbar(detail.name, 'Roles and permissions.', '', 'i-shield');
    var roles = [];
    var allPerms = [];
    try {
      roles = await TrycordApi.roles(detail.id);
      allPerms = ((await TrycordApi.serverPerms(detail.id)) || {}).all || [];
    } catch (e) {
      root.innerHTML = tabBar(detail, 'roles') + Ui.errorState(e.message, 'Retry');
      var rb = root.querySelector('[data-retry]');
      if (rb) rb.onclick = () => renderRoles(root, detail);
      return;
    }
    root.innerHTML = tabBar(detail, 'roles') +
      '<div style="display:flex;gap:var(--tc-space-2);margin-bottom:var(--tc-space-4);">' +
      '<button type="button" class="btn btn-primary btn-sm" data-new-role>New role</button></div>' +
      '<div class="tc-stack">' + roles.map((r) =>
        '<section aria-label="Role ' + Ui.esc(r.name) + '">' +
        '<div class="set-row"><div class="grow"><strong>' + Ui.esc(r.name) + '</strong>' +
        '<small>' + (r.is_default ? 'Default role · ' : '') + (r.permissions || []).length + ' permissions</small></div>' +
        (r.is_default ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-del-role="' + Ui.esc(r.id) + '">Delete</button>') + '</div>' +
        '<div class="tc-cluster" style="padding:0 0 var(--tc-space-3);">' + allPerms.map((p) => {
          var on = (r.permissions || []).indexOf(p) !== -1;
          return '<label class="form-check"><input type="checkbox" class="form-check-input" data-role="' + Ui.esc(r.id) + '" data-perm="' + Ui.esc(p) + '"' + (on ? ' checked' : '') + ' />' +
            '<span class="form-check-label">' + Ui.esc(p) + '</span></label>';
        }).join('') + '</div></section>'
      ).join('') + '</div>';
    var nr = root.querySelector('[data-new-role]');
    if (nr) {
      nr.onclick = () => {
        var body = document.createElement('div');
        body.innerHTML = '<div class="form-group"><label class="form-label" for="role-name">Role name</label>' +
          '<input type="text" id="role-name" class="form-input" maxlength="32" /></div>';
        Ui.openModal({
          title: 'New role', body,
          actions: [{ id: 'cancel', label: 'Cancel' }, {
            id: 'create', label: 'Create role', primary: true,
            onClick: (close) => {
              var name = body.querySelector('#role-name').value.trim();
              if (!name) return;
              TrycordApi.createRole(detail.id, { name })
                .then(() => { close(); Ui.toast('Role created.', 'success'); renderRoles(root, detail); })
                .catch((e) => Ui.toast(e.message, 'error'));
            },
          }],
        });
      };
    }
    root.querySelectorAll('[data-del-role]').forEach((b) => {
      b.onclick = async () => {
        var yes = await Ui.confirmDialog({ title: 'Delete role?', message: 'Members lose this role immediately.', confirmText: 'Delete' });
        if (!yes) return;
        TrycordApi.deleteRole(detail.id, b.dataset.delRole)
          .then(() => { Ui.toast('Role deleted.', 'success'); renderRoles(root, detail); })
          .catch((e) => Ui.toast(e.message, 'error'));
      };
    });
    root.querySelectorAll('[data-perm]').forEach((box) => {
      box.onchange = () => {
        var roleId = box.dataset.role;
        var checked = Array.prototype.slice.call(root.querySelectorAll('[data-role="' + roleId + '"][data-perm]'))
          .filter((b) => b.checked)
          .map((b) => b.dataset.perm);
        TrycordApi.patchRole(detail.id, roleId, { permissions: checked })
          .then(() => Ui.toast('Role saved.', 'success'))
          .catch((e) => { box.checked = !box.checked; Ui.toast(e.message, 'error'); });
      };
    });
  }

  // ---------- invites ----------

  async function renderInvites(root, detail) {
    C.setTopbar(detail.name, 'Invite people.', '', 'i-mail');
    var list = [];
    try {
      list = await TrycordApi.invites(detail.id);
    } catch (e) {
      root.innerHTML = tabBar(detail, 'invites') + Ui.errorState(e.message, 'Retry');
      var rb = root.querySelector('[data-retry]');
      if (rb) rb.onclick = () => renderInvites(root, detail);
      return;
    }
    root.innerHTML = tabBar(detail, 'invites') +
      '<form id="inv-form" style="display:flex;gap:var(--tc-space-2);flex-wrap:wrap;align-items:flex-end;margin-bottom:var(--tc-space-4);">' +
      '<div class="form-group" style="margin:0;"><label class="form-label" for="inv-uses">Max uses (blank = unlimited)</label>' +
      '<input type="number" id="inv-uses" class="form-input" min="1" max="100" style="width:10rem;" /></div>' +
      '<button class="btn btn-primary btn-sm" type="submit">New invite</button></form>' +
      '<div id="inv-list">' + (list.length ? list.map((inv) =>
        '<div class="member-row"><span class="code-chip">' + Ui.esc(inv.code) + '</span>' +
        '<span class="who"><span class="sub">' + Ui.esc(inv.uses || 0) + (inv.max_uses ? '/' + Ui.esc(inv.max_uses) : '') + ' uses' +
        (inv.expires_at ? ' · expires ' + Ui.esc(Ui.timeAgo(inv.expires_at)) : '') + (inv.revoked ? ' · revoked' : '') + '</span></span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-copy-inv="' + Ui.esc(inv.code) + '">Copy</button>' +
        (inv.revoked ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-revoke-inv="' + Ui.esc(inv.id) + '">Revoke</button>') + '</div>'
      ).join('') : '<p class="text-muted">No invites yet. Create one above.</p>') + '</div>';
    root.querySelector('#inv-form').addEventListener('submit', (e) => {
      e.preventDefault();
      var uses = parseInt(root.querySelector('#inv-uses').value, 10);
      TrycordApi.createInvite(detail.id, { maxUses: isNaN(uses) ? undefined : uses })
        .then(() => { Ui.toast('Invite created.', 'success'); renderInvites(root, detail); })
        .catch((err) => Ui.toast(err.message, 'error'));
    });
    root.querySelectorAll('[data-copy-inv]').forEach((b) => {
      b.onclick = () => C.copyText(b.dataset.copyInv, 'Invite code copied.');
    });
    root.querySelectorAll('[data-revoke-inv]').forEach((b) => {
      b.onclick = () => TrycordApi.revokeInvite(detail.id, b.dataset.revokeInv)
        .then(() => { Ui.toast('Invite revoked.', 'success'); renderInvites(root, detail); })
        .catch((e) => Ui.toast(e.message, 'error'));
    });
  }

  // ---------- settings ----------

  async function renderSettings(root, detail) {
    C.setTopbar(detail.name, 'Server settings.', '', 'i-cog');
    root.innerHTML = tabBar(detail, 'settings') +
      '<div class="set-wrap" style="max-width:52rem;"><div class="set-panel">' +
      '<form id="srv-form"><div class="form-group"><label class="form-label" for="srv-name">Server name</label>' +
      '<input type="text" id="srv-name" class="form-input" maxlength="64" value="' + Ui.esc(detail.name) + '" /></div>' +
      '<div class="form-group"><label class="form-label" for="srv-desc">Description</label>' +
      '<textarea id="srv-desc" class="form-input form-textarea" maxlength="500" rows="3">' + Ui.esc(detail.description || '') + '</textarea></div>' +
      '<div class="form-check" style="margin-bottom:var(--tc-space-2);"><input type="checkbox" id="srv-public" class="form-check-input"' + (detail.is_public ? ' checked' : '') + ' />' +
      '<label class="form-check-label" for="srv-public">Public server</label></div>' +
      '<div class="form-check" style="margin-bottom:var(--tc-space-4);"><input type="checkbox" id="srv-disc" class="form-check-input"' + (detail.is_discoverable ? ' checked' : '') + ' />' +
      '<label class="form-check-label" for="srv-disc">List in Discover</label></div>' +
      '<button class="btn btn-primary btn-sm" type="submit">Save changes</button></form>' +
      '<hr class="divider" />' +
      '<div class="set-row"><div class="grow"><strong>Join code</strong><small>Anyone with this code can join.</small></div>' +
      '<span class="code-chip">' + Ui.esc(detail.join_code || '–') + '</span> ' +
      (detail.join_code ? '<button type="button" class="btn btn-ghost btn-sm" data-copy-code>Copy</button>' : '') + '</div>' +
      '<hr class="divider" />' +
      '<div class="set-row"><div class="grow"><strong>Danger zone</strong><small>Deleting removes channels, messages, and memberships permanently.</small></div>' +
      '<button type="button" class="btn btn-danger btn-sm" data-del-srv">' + (detail.is_owner ? 'Delete server' : 'Leave server') + '</button></div>' +
      '</div></div>';
    root.querySelector('#srv-form').addEventListener('submit', (e) => {
      e.preventDefault();
      var name = root.querySelector('#srv-name').value.trim();
      if (!name) { Ui.toast('Give the server a name.', 'error'); return; }
      TrycordApi.patchServer(detail.id, {
        name,
        description: root.querySelector('#srv-desc').value.trim(),
        isPublic: root.querySelector('#srv-public').checked,
        isDiscoverable: root.querySelector('#srv-disc').checked,
      }).then(() => {
        Ui.toast('Server saved.', 'success');
        return Trycord.refreshServers();
      }).then(() => window.TrycordRouter.route())
        .catch((err) => Ui.toast(err.message, 'error'));
    });
    var cc = root.querySelector('[data-copy-code]');
    if (cc) cc.onclick = () => C.copyText(detail.join_code, 'Join code copied.');
    root.querySelector('[data-del-srv]').onclick = () => leaveOrDelete(detail);
  }

  window.TrycordPagesWorkspace = { workspace, cleanup };
})();
