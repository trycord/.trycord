/* Server workspace: header + tabs (Overview, Chat, Members, Roles, Invites, Settings).
   Tabs are gated by real backend permissions; the backend re-checks everything. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;
  var chatSocket = null;
  var renderedIds = {};
  var current = { serverId: null, channelId: null };

  function closeChat() {
    if (chatSocket) {
      try { chatSocket.close(); } catch (e) { /* ignore */ }
      chatSocket = null;
    }
    current.channelId = null;
    renderedIds = {};
  }

  function can(perm) {
    return TrycordState.can(current.serverId, perm);
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      Ui.toast(okMsg || 'Copied.', 'good');
    } catch (e) {
      Ui.toast(text, 'info');
    }
  }

  async function workspace(root, serverId, tab, deepChannelId) {
    tab = tab || 'overview';
    var detail;
    try {
      detail = await TrycordApi.serverDetail(serverId);
    } catch (e) {
      if (e.code === 'NOT_A_MEMBER') {
        renderNotMember(root, serverId);
        return;
      }
      Ui.toast(e.message, 'bad');
      location.hash = '#/servers';
      return;
    }
    TrycordState.touchRecent(detail.id);
    TrycordState.setPerms(detail.id, { is_owner: detail.is_owner, permissions: detail.permissions || [] });
    current.serverId = detail.id;

    var tabs = ['overview', 'chat', 'members'];
    if (can('MANAGE_ROLES')) tabs.push('roles');
    if (can('MANAGE_INVITES')) tabs.push('invites');
    if (can('MANAGE_SERVER')) tabs.push('settings');
    if (tabs.indexOf(tab) === -1) {
      location.hash = '#/server/' + encodeURIComponent(detail.id) + '/overview';
      return;
    }

    C.setTopbar(detail.name, 'Server workspace', '');
    var isFav = TrycordState.isFav(detail.id);
    var vis = detail.is_public
      ? (detail.is_discoverable ? Ui.badge('Public', 'pub') : Ui.badge('Unlisted', ''))
      : Ui.badge('Private', 'priv');
    root.innerHTML =
      '<section class="ws-head">' + Ui.avatarHtml(detail.name, 'lg') +
      '<div class="titles"><h2>' + Ui.esc(detail.name) + '</h2>' +
      '<p class="desc">' + Ui.esc(detail.description || 'No description.') + '</p>' +
      '<div class="meta row wrap" style="margin-top:0.4rem">' +
      (detail.is_owner ? Ui.badge('Owner', 'owner') : Ui.badge('Member', '')) + vis +
      Ui.badge(detail.member_count + ' member' + (detail.member_count === 1 ? '' : 's'), '') +
      '</div></div>' +
      '<div class="side">' +
      '<span class="code-chip" title="Legacy join code">⌁ ' + Ui.esc(detail.join_code) +
      ' <button type="button" class="btn btn-ghost btn-sm" id="copy-code">Copy</button></span>' +
      '<button type="button" class="icon-btn fav-btn" data-fav="' + Ui.esc(detail.id) + '" ' +
      'aria-pressed="' + (isFav ? 'true' : 'false') + '" title="Toggle favorite">' + (isFav ? '★' : '☆') + '</button>' +
      '</div></section>' +
      '<div class="tabs" role="tablist" aria-label="Server sections">' +
      tabs.map((t) =>
        '<button type="button" role="tab" class="tab" data-tab="' + t + '" aria-selected="' + (t === tab ? 'true' : 'false') + '">' +
        t[0].toUpperCase() + t.slice(1) + '</button>').join('') +
      '</div>' +
      '<div id="ws-body"></div>';

    C.wireCards(root);
    document.getElementById('copy-code').onclick = () => copyText(detail.join_code, 'Join code copied.');
    root.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        location.hash = '#/server/' + encodeURIComponent(detail.id) + '/' + b.dataset.tab;
      };
    });

    var body = document.getElementById('ws-body');
    if (tab === 'overview') await renderOverview(body, detail);
    else if (tab === 'chat') await renderChat(body, detail, deepChannelId);
    else if (tab === 'members') await renderMembers(body, detail);
    else if (tab === 'roles') await renderRoles(body, detail);
    else if (tab === 'invites') await renderInvites(body, detail);
    else if (tab === 'settings') renderSettings(body, detail);
  }

  // --- not a member: join prompt, not a dead end ---------------------------
  async function renderNotMember(root, serverId) {
    C.setTopbar('Server', 'You are not a member.');
    root.innerHTML = '<div id="nm-body">' + Ui.skeletons(2) + '</div>';
    var body = document.getElementById('nm-body');
    var preview = null;
    try {
      preview = await TrycordApi.discoverPreview(serverId);
    } catch (e) { /* private or gone */ }
    if (!preview) {
      body.innerHTML = Ui.emptyState({
        icon: '◌', title: 'Server unavailable',
        hint: 'It may be private, unlisted, or deleted. Ask a member for an invite.',
        actions: '<a class="btn btn-ghost btn-sm" href="#/servers">Your servers</a>' +
          '<a class="btn btn-ghost btn-sm" href="#/discover">Discover</a>',
      });
      return;
    }
    body.innerHTML =
      '<div class="state"><div class="glyph" aria-hidden="true">◌</div>' +
      '<h3>You’re not a member of ' + Ui.esc(preview.name) + '</h3>' +
      '<p>' + Ui.esc(preview.description || 'No description.') + '<br>' +
      '<span class="muted">' + preview.member_count + ' members · ' + preview.channel_count + ' channels</span></p>' +
      '<div class="actions"><button type="button" class="btn btn-primary" id="nm-join">Join server</button>' +
      '<a class="btn btn-ghost" href="#/discover/' + Ui.esc(preview.id) + '">Full preview</a></div></div>';
    document.getElementById('nm-join').onclick = async (e) => {
      var btn = e.currentTarget;
      Ui.setLoading(btn, true, 'Joining…');
      try {
        await TrycordApi.joinPublic(preview.id);
        await Trycord.refreshServers();
        Ui.toast('Joined ' + preview.name + '.', 'good');
        location.hash = '#/server/' + encodeURIComponent(preview.id) + '/overview';
        workspace(root, preview.id, 'overview');
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.toast(err.message, 'bad');
      }
    };
  }

  // --- overview -----------------------------------------------------------
  async function renderOverview(body, detail) {
    var canInvite = can('MANAGE_INVITES');
    body.innerHTML =
      '<div class="stats">' +
      '<div class="stat"><div class="num">' + detail.member_count + '</div><div class="lbl">Members</div></div>' +
      '<div class="stat"><div class="num">' + detail.channel_count + '</div><div class="lbl">Channels</div></div>' +
      '<div class="stat"><div class="num">' + detail.message_count + '</div><div class="lbl">Messages</div></div>' +
      '<div class="stat"><div class="num">' + Ui.timeAgo(detail.created_at) + '</div><div class="lbl">Created</div></div>' +
      '</div>' +
      '<div class="toolbar">' +
      '<a class="btn btn-primary btn-sm" href="#/server/' + encodeURIComponent(detail.id) + '/chat">Open chat</a>' +
      (canInvite ? '<button type="button" class="btn btn-ghost btn-sm" id="ov-invite">Copy 24h invite</button>' : '') +
      (can('MANAGE_SERVER')
        ? '<a class="btn btn-ghost btn-sm" href="#/server/' + encodeURIComponent(detail.id) + '/settings">Server settings</a>'
        : '<a class="btn btn-ghost btn-sm" href="#/server/' + encodeURIComponent(detail.id) + '/members">View members</a>') +
      '</div>' +
      '<section class="section"><h2>Recent activity</h2><div id="ws-activity">' + Ui.skeletons(3) + '</div></section>';

    var invBtn = document.getElementById('ov-invite');
    if (invBtn) {
      invBtn.onclick = async () => {
        try {
          var inv = await TrycordApi.createInvite(detail.id, { expiresInHours: 24 });
          copyText(inv.code, 'Invite copied (expires in 24h).');
        } catch (e) { Ui.toast(e.message, 'bad'); }
      };
    }

    try {
      var acts = (await TrycordApi.activity(30)).filter((a) => a.server_id === detail.id).slice(0, 5);
      var box = document.getElementById('ws-activity');
      if (!box) return;
      box.innerHTML = acts.length
        ? '<div class="activity-list">' + acts.map(TrycordPagesHome.activityItem).join('') + '</div>'
        : Ui.emptyState({ icon: '◷', title: 'No activity yet', hint: 'Be the first to post in chat.' });
      box.querySelectorAll('[data-goto-server]').forEach((b) => {
        b.onclick = () => {
          location.hash = '#/server/' + encodeURIComponent(b.dataset.gotoServer) +
            '/chat/' + encodeURIComponent(b.dataset.gotoChannel);
        };
      });
    } catch (e) {
      var box2 = document.getElementById('ws-activity');
      if (box2) box2.innerHTML = Ui.errorState(e.message);
    }
  }

  // --- chat ---------------------------------------------------------------
  async function renderChat(body, detail, deepChannelId) {
    var manageChannels = can('MANAGE_CHANNELS');
    body.innerHTML =
      '<div class="chat-grid"><div class="chat-channels">' +
      '<div class="nav-label">Channels</div><div id="ch-list">' + Ui.skeletons(3) + '</div>' +
      (manageChannels
        ? '<form id="ch-new" class="stack" style="margin-top:0.6rem">' +
          '<input type="text" id="ch-name" placeholder="new-channel" maxlength="32" aria-label="New channel name" />' +
          '<select id="ch-cat" aria-label="Category"></select>' +
          '<button class="btn btn-sm" type="submit">+ Add channel</button></form>'
        : '') +
      '</div>' +
      '<div class="chat-pane"><div class="chat-topic" id="ch-topic">Select a channel</div>' +
      '<ul class="msg-list" id="msg-list" aria-live="polite"></ul>' +
      '<form class="composer" id="composer"><input id="msg-input" placeholder="Type a message…" autocomplete="off" aria-label="Message" />' +
      '<button class="btn btn-primary" type="submit">Send</button></form></div></div>';

    var cats = [];
    var channels = [];
    try {
      var data = await TrycordApi.channels(detail.id);
      cats = data.categories || [];
      channels = data.channels || [];
    } catch (e) {
      document.getElementById('ch-list').innerHTML = Ui.errorState(e.message);
      return;
    }
    var canModMsg = can('MANAGE_MESSAGES');
    var me = TrycordState.user;
    var list = document.getElementById('ch-list');
    var catSelect = document.getElementById('ch-cat');
    if (catSelect) {
      catSelect.innerHTML = '<option value="">No category</option>' +
        cats.map((c) => '<option value="' + Ui.esc(c.id) + '">' + Ui.esc(c.name) + '</option>').join('');
    }

    function paintChannels() {
      list.innerHTML = '';
      var uncategorized = channels.filter((c) => !c.category_id);
      cats.forEach((cat) => {
        var inCat = channels.filter((c) => c.category_id === cat.id);
        if (!inCat.length) return;
        var lbl = document.createElement('div');
        lbl.className = 'nav-label';
        lbl.textContent = cat.name;
        list.appendChild(lbl);
        inCat.forEach((c) => list.appendChild(channelRow(c)));
      });
      if (uncategorized.length) {
        if (cats.length) {
          var lbl = document.createElement('div');
          lbl.className = 'nav-label';
          lbl.textContent = 'No category';
          list.appendChild(lbl);
        }
        uncategorized.forEach((c) => list.appendChild(channelRow(c)));
      }
      if (!channels.length) list.innerHTML = '<p class="muted small">No channels yet.</p>';
    }

    function channelRow(c) {
      var row = document.createElement('div');
      row.className = 'channel-row';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-btn' + (c.id === current.channelId ? ' active' : '');
      btn.textContent = '# ' + c.name;
      btn.onclick = () => selectChannel(c.id);
      row.appendChild(btn);
      if (manageChannels) {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn channel-del';
        del.title = 'Delete #' + c.name;
        del.setAttribute('aria-label', 'Delete channel ' + c.name);
        del.textContent = '✕';
        del.onclick = async () => {
          var yes = await Ui.confirmDialog({
            title: 'Delete #' + c.name + '?',
            message: 'All messages in this channel will be permanently deleted.',
            confirmText: 'Delete', danger: true,
          });
          if (!yes) return;
          try {
            await TrycordApi.deleteChannel(detail.id, c.id);
            channels = channels.filter((x) => x.id !== c.id);
            if (current.channelId === c.id) current.channelId = null;
            paintChannels();
            if (channels[0]) selectChannel(channels[0].id);
            else document.getElementById('msg-list').innerHTML = '';
            Ui.toast('Channel deleted.', 'good');
          } catch (err) { Ui.toast(err.message, 'bad'); }
        };
        row.appendChild(del);
      }
      return row;
    }

    async function selectChannel(id) {
      var ch = channels.find((x) => x.id === id) || channels[0];
      if (!ch) return;
      current.channelId = ch.id;
      renderedIds = {};
      paintChannels();
      document.getElementById('ch-topic').textContent = '#' + ch.name + (ch.topic ? ' — ' + ch.topic : '');
      var ml = document.getElementById('msg-list');
      ml.innerHTML = Ui.skeletons(3);
      try {
        var msgs = await TrycordApi.messages(ch.id, 50);
        ml.innerHTML = '';
        msgs.forEach(addMsg);
      } catch (e) {
        ml.innerHTML = '<li>' + Ui.errorState(e.message) + '</li>';
      }
      if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
        chatSocket.send(JSON.stringify({ type: 'join', channelId: ch.id }));
      }
      history.replaceState(null, '', '#/server/' + encodeURIComponent(detail.id) + '/chat/' + encodeURIComponent(ch.id));
    }

    function addMsg(m) {
      if (!m || renderedIds[m.id]) return;
      renderedIds[m.id] = true;
      var li = document.createElement('li');
      li.className = 'msg';
      li.dataset.mid = m.id;
      var av = document.createElement('span');
      av.innerHTML = Ui.avatarHtml(m.user || m.author_name || '?', 'sm');
      var bd = document.createElement('div');
      bd.className = 'body';
      var meta = document.createElement('div');
      meta.className = 'meta';
      var b = document.createElement('b');
      b.textContent = m.user || m.author_name || 'user';
      var t = document.createElement('time');
      t.textContent = m.created_at ? new Date(m.created_at).toLocaleString() : '';
      meta.append(b, t);
      if (me && (m.author_id === me.id || canModMsg)) {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn btn-sm';
        del.title = 'Delete message';
        del.setAttribute('aria-label', 'Delete message');
        del.textContent = '✕';
        del.onclick = async () => {
          try {
            await TrycordApi.deleteMessage(current.channelId, m.id);
            delete renderedIds[m.id];
            li.remove();
          } catch (err) { Ui.toast(err.message, 'bad'); }
        };
        meta.appendChild(del);
      }
      var tx = document.createElement('div');
      tx.className = 'text';
      tx.textContent = m.content || '';
      bd.append(meta, tx);
      li.append(av, bd);
      document.getElementById('msg-list').appendChild(li);
      li.scrollIntoView({ block: 'nearest' });
    }

    var newForm = document.getElementById('ch-new');
    if (newForm) {
      newForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        var input = document.getElementById('ch-name');
        var name = input.value.trim();
        if (!name) return;
        try {
          var r = await TrycordApi.createChannel(detail.id, {
            name, categoryId: document.getElementById('ch-cat').value || undefined,
          });
          var data2 = await TrycordApi.channels(detail.id);
          cats = data2.categories || [];
          channels = data2.channels || [];
          input.value = '';
          paintChannels();
          selectChannel(r.id || r.channelId);
          Ui.toast('Channel created.', 'good');
        } catch (err) { Ui.toast(err.message, 'bad'); }
      });
    }

    document.getElementById('composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      var input = document.getElementById('msg-input');
      var content = input.value.trim();
      if (!content || !current.channelId) return;
      input.value = '';
      try {
        var m = await TrycordApi.postMessage(current.channelId, content);
        addMsg(m);
      } catch (err) { Ui.toast(err.message, 'bad'); }
    });

    paintChannels();
    var start = channels.find((x) => x.id === deepChannelId) ? deepChannelId
      : (channels[0] && channels[0].id);
    if (start) {
      selectChannel(start);
      chatSocket = new WebSocket(TrycordApi.wsUrl());
      chatSocket.onopen = () => {
        if (current.channelId) chatSocket.send(JSON.stringify({ type: 'join', channelId: current.channelId }));
      };
      chatSocket.onmessage = (ev) => {
        try {
          var data = JSON.parse(ev.data);
          if (data.type === 'message' && data.channel_id === current.channelId) addMsg(data);
          else if (data.type === 'message_deleted' && data.channel_id === current.channelId) {
            delete renderedIds[data.id];
            var el = document.querySelector('[data-mid="' + data.id + '"]');
            if (el) el.remove();
          }
        } catch (err) { /* ignore */ }
      };
    } else {
      document.getElementById('msg-list').innerHTML = '<li class="muted">No channels yet.</li>';
    }
  }

  // --- members ------------------------------------------------------------
  async function renderMembers(body, detail) {
    var manageRoles = can('MANAGE_ROLES');
    var kickPerm = can('KICK_MEMBERS');
    body.innerHTML = '<div id="mem-list">' + Ui.skeletons(4) + '</div>';
    var box = document.getElementById('mem-list');
    var members;
    try {
      members = await TrycordApi.serverMembers(detail.id);
    } catch (e) {
      box.innerHTML = Ui.errorState(e.message);
      var rb = box.querySelector('[data-retry]');
      if (rb) rb.onclick = () => renderMembers(body, detail);
      return;
    }
    var me = TrycordState.user;
    box.innerHTML = '<p class="muted">' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</p>' +
      '<ul class="member-list">' + members.map((m, i) =>
        '<li class="member-item" data-uid="' + Ui.esc(m.id) + '">' +
        Ui.avatarHtml(m.display_name || m.username) +
        '<span class="who"><strong>' + Ui.esc(m.display_name || m.username) +
        ' <small>@' + Ui.esc(m.username) + '</small></strong>' +
        '<small>Joined ' + Ui.fullDate(m.joined_at) + '</small>' +
        '<span class="row wrap" style="margin-top:0.25rem">' +
        (m.is_owner ? Ui.badge('Owner', 'owner') : '') +
        m.roles.map((r) => Ui.badge(Ui.esc(r.name), '')).join('') + '</span></span>' +
        '<span class="row">' +
        (manageRoles && !m.is_owner ? '<button type="button" class="btn btn-ghost btn-sm" data-roles="' + i + '">Roles</button>' : '') +
        (kickPerm && !m.is_owner && m.id !== me.id ? '<button type="button" class="btn btn-ghost btn-sm" data-kick="' + Ui.esc(m.id) + '" data-kick-name="' + Ui.esc(m.display_name || m.username) + '">Kick</button>' : '') +
        '</span></li>').join('') + '</ul>';

    box.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = async () => {
        var yes = await Ui.confirmDialog({
          title: 'Kick ' + b.dataset.kickName + '?',
          message: 'They will leave the server immediately and can rejoin with a new invite.',
          confirmText: 'Kick', danger: true,
        });
        if (!yes) return;
        try {
          await TrycordApi.kickMember(detail.id, b.dataset.kick);
          Ui.toast('Member kicked.', 'good');
          renderMembers(body, detail);
        } catch (err) { Ui.toast(err.message, 'bad'); }
      };
    });

    if (manageRoles) {
      var allRoles = await TrycordApi.roles(detail.id).catch(() => []);
      box.querySelectorAll('[data-roles]').forEach((b) => {
        b.onclick = () => roleAssignModal(detail, members[Number(b.dataset.roles)], allRoles, () => renderMembers(body, detail));
      });
    }
  }

  function roleAssignModal(detail, member, allRoles, onDone) {
    var wrap = document.createElement('div');
    wrap.innerHTML = '<p class="muted">Roles for <b>' + Ui.esc(member.display_name || member.username) + '</b>:</p>' +
      allRoles.map((r) => {
        var has = member.roles.some((x) => x.id === r.id);
        return '<label class="row" style="margin-bottom:0.4rem"><input type="checkbox" data-role="' + Ui.esc(r.id) + '"' +
          (has ? ' checked' : '') + ' /> ' + Ui.esc(r.name) + '</label>';
      }).join('');
    Ui.openModal({
      title: 'Edit roles',
      body: wrap,
      actions: [
        { id: 'cancel', label: 'Cancel' },
        {
          id: 'save', label: 'Save', primary: true,
          onClick: async (close) => {
            var checks = wrap.querySelectorAll('[data-role]');
            try {
              for (var i = 0; i < checks.length; i++) {
                var rid = checks[i].dataset.role;
                var had = member.roles.some((x) => x.id === rid);
                if (checks[i].checked && !had) await TrycordApi.assignRole(detail.id, rid, member.id);
                if (!checks[i].checked && had) await TrycordApi.unassignRole(detail.id, rid, member.id);
              }
              close();
              Ui.toast('Roles updated.', 'good');
              onDone();
            } catch (e) { Ui.toast(e.message, 'bad'); }
          },
        },
      ],
    });
  }

  // --- roles --------------------------------------------------------------
  async function renderRoles(body, detail) {
    body.innerHTML = '<div id="roles-list">' + Ui.skeletons(3) + '</div>';
    var box = document.getElementById('roles-list');
    var roleList;
    try {
      roleList = await TrycordApi.roles(detail.id);
    } catch (e) {
      box.innerHTML = Ui.errorState(e.message);
      return;
    }
    var allPerms = {};
    try {
      var p = await TrycordApi.serverPerms(detail.id);
      allPerms = p.all || {};
    } catch (e) { /* keep empty */ }
    var permNames = Object.keys(allPerms);

    box.innerHTML =
      '<form id="role-new" class="toolbar"><input type="text" id="role-name" class="grow" maxlength="32" placeholder="New role name…" aria-label="New role name" />' +
      '<button class="btn btn-sm" type="submit">+ Add role</button></form>' +
      '<div class="stack">' + roleList.map((r) =>
        '<section class="settings-card" data-role-card="' + Ui.esc(r.id) + '">' +
        '<div class="row space"><h2 style="margin:0">' + Ui.esc(r.name) + '</h2>' +
        '<span class="row">' + (r.is_default ? Ui.badge('Default', '') : '') +
        (r.is_default ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-role-del="' + Ui.esc(r.id) + '">Delete</button>') +
        '</span></div>' +
        '<div class="row wrap" style="margin:0.6rem 0">' +
        permNames.map((pn) =>
          '<label class="row small" style="margin-right:0.8rem"><input type="checkbox" data-role-perm="' + Ui.esc(r.id) + ':' + Ui.esc(pn) + '"' +
          (r.permissions.indexOf(pn) !== -1 ? ' checked' : '') + ' title="' + Ui.esc(allPerms[pn] || pn) + '" /> ' +
          Ui.esc(pn.replace(/_/g, ' ').toLowerCase()) + '</label>').join('') +
        '</div>' +
        '<button type="button" class="btn btn-primary btn-sm" data-role-save="' + Ui.esc(r.id) + '">Save permissions</button>' +
        '</section>').join('') + '</div>';

    document.getElementById('role-new').addEventListener('submit', async (e) => {
      e.preventDefault();
      var input = document.getElementById('role-name');
      if (!input.value.trim()) return;
      try {
        await TrycordApi.createRole(detail.id, { name: input.value.trim(), permissions: [] });
        Ui.toast('Role created.', 'good');
        renderRoles(body, detail);
      } catch (err) { Ui.toast(err.message, 'bad'); }
    });

    box.querySelectorAll('[data-role-save]').forEach((b) => {
      b.onclick = async () => {
        var rid = b.dataset.roleSave;
        var checked = [];
        box.querySelectorAll('[data-role-perm]').forEach((cb) => {
          var parts = cb.dataset.rolePerm.split(':');
          if (parts[0] === rid && cb.checked) checked.push(parts.slice(1).join(':'));
        });
        try {
          await TrycordApi.patchRole(detail.id, rid, { permissions: checked });
          Ui.toast('Permissions saved.', 'good');
        } catch (err) { Ui.toast(err.message, 'bad'); }
      };
    });

    box.querySelectorAll('[data-role-del]').forEach((b) => {
      b.onclick = async () => {
        var yes = await Ui.confirmDialog({
          title: 'Delete role?', message: 'Members keep their membership but lose this role.',
          confirmText: 'Delete', danger: true,
        });
        if (!yes) return;
        try {
          await TrycordApi.deleteRole(detail.id, b.dataset.roleDel);
          Ui.toast('Role deleted.', 'good');
          renderRoles(body, detail);
        } catch (err) { Ui.toast(err.message, 'bad'); }
      };
    });
  }

  // --- invites ------------------------------------------------------------
  async function renderInvites(body, detail) {
    body.innerHTML =
      '<section class="settings-card"><h2>New invite</h2>' +
      '<form id="inv-new" class="toolbar">' +
      '<label class="small muted">Max uses <input type="number" id="inv-max" min="1" max="100" placeholder="∞" style="width:5rem" /></label>' +
      '<label class="small muted">Expires <select id="inv-exp">' +
      '<option value="">Never</option><option value="1">1 hour</option>' +
      '<option value="24" selected>24 hours</option><option value="168">7 days</option></select></label>' +
      '<button class="btn btn-primary btn-sm" type="submit">Create invite</button></form></section>' +
      '<section class="section" style="margin-top:1rem"><h2>Active invites</h2><div id="inv-list">' + Ui.skeletons(3) + '</div></section>';

    async function reload() {
      var box = document.getElementById('inv-list');
      var list;
      try {
        list = await TrycordApi.invites(detail.id);
      } catch (e) {
        box.innerHTML = Ui.errorState(e.message);
        return;
      }
      var alive = list.filter((i) => !i.revoked);
      box.innerHTML = alive.length ? '<ul class="member-list">' + alive.map((i) =>
        '<li class="member-item"><span class="who"><strong class="code-chip">⌁ ' + Ui.esc(i.code) + '</strong> ' +
        '<small>by @' + Ui.esc(i.creator_name) + ' · ' + i.uses + (i.max_uses ? '/' + i.max_uses : '') + ' used' +
        (i.expires_at ? ' · expires ' + Ui.fullDate(i.expires_at) : ' · never expires') + '</small></span>' +
        '<span class="row"><button type="button" class="btn btn-ghost btn-sm" data-inv-copy="' + Ui.esc(i.code) + '">Copy</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-inv-revoke="' + Ui.esc(i.id) + '">Revoke</button></span></li>'
      ).join('') + '</ul>'
        : Ui.emptyState({ icon: '✉', title: 'No active invites', hint: 'Create one above to let people join.' });
      box.querySelectorAll('[data-inv-copy]').forEach((b) => {
        b.onclick = () => copyText(b.dataset.invCopy, 'Invite copied.');
      });
      box.querySelectorAll('[data-inv-revoke]').forEach((b) => {
        b.onclick = async () => {
          try {
            await TrycordApi.revokeInvite(detail.id, b.dataset.invRevoke);
            Ui.toast('Invite revoked.', 'good');
            reload();
          } catch (err) { Ui.toast(err.message, 'bad'); }
        };
      });
    }

    document.getElementById('inv-new').addEventListener('submit', async (e) => {
      e.preventDefault();
      var maxRaw = document.getElementById('inv-max').value;
      try {
        var inv = await TrycordApi.createInvite(detail.id, {
          maxUses: maxRaw ? Number(maxRaw) : undefined,
          expiresInHours: document.getElementById('inv-exp').value || undefined,
        });
        Ui.toast('Invite created: ' + inv.code, 'good');
        copyText(inv.code, 'Invite copied: ' + inv.code);
        reload();
      } catch (err) { Ui.toast(err.message, 'bad'); }
    });
    reload();
  }

  // --- settings (MANAGE_SERVER) --------------------------------------------
  function renderSettings(body, detail) {
    var manageChannels = can('MANAGE_CHANNELS');
    var isOwner = detail.is_owner;
    var vis = !detail.is_public ? 'private' : (detail.is_discoverable ? 'listed' : 'unlisted');
    body.innerHTML =
      '<div class="settings-grid">' +
      '<section class="settings-card"><h2>Server settings</h2>' +
      '<form id="srv-form">' +
      '<label class="field"><span>Name</span><input type="text" id="srv-name" maxlength="64" value="' + Ui.esc(detail.name) + '" /></label>' +
      '<label class="field"><span>Description</span><textarea id="srv-desc" maxlength="500">' + Ui.esc(detail.description || '') + '</textarea></label>' +
      '<label class="field"><span>Visibility</span><select id="srv-vis">' +
      '<option value="listed"' + (vis === 'listed' ? ' selected' : '') + '>Public — listed in Discover</option>' +
      '<option value="unlisted"' + (vis === 'unlisted' ? ' selected' : '') + '>Public — unlisted (join via code/invite)</option>' +
      '<option value="private"' + (vis === 'private' ? ' selected' : '') + '>Private — invite only</option>' +
      '</select></label>' +
      '<div class="form-row" style="margin-top:0.8rem"><button class="btn btn-primary" type="submit" id="srv-save">Save changes</button></div>' +
      '</form></section>' +
      '<section class="settings-card"><h2>Join codes</h2>' +
      '<p class="hint">Legacy permanent code (works even for private servers — share carefully):</p>' +
      '<p><span class="code-chip">⌁ ' + Ui.esc(detail.join_code) + '</span></p>' +
      '<p class="hint">For expiring, limited-use codes, use the <a href="#/server/' + encodeURIComponent(detail.id) + '/invites">Invites</a> tab.</p></section>' +
      (manageChannels
        ? '<section class="settings-card"><h2>Categories</h2><div id="cat-list"></div>' +
          '<form id="cat-new" class="toolbar" style="margin-top:0.6rem"><input type="text" id="cat-name" class="grow" maxlength="32" placeholder="New category…" aria-label="New category name" />' +
          '<button class="btn btn-sm" type="submit">Add</button></form></section>'
        : '') +
      '<section class="settings-card"><h2>Danger zone</h2>' +
      (!isOwner ? '<p class="hint">You are a member of this server.</p><button class="btn btn-ghost" type="button" id="leave-btn2">Leave server</button>' : '') +
      (isOwner ? '<p class="hint">Deleting a server permanently removes its channels, messages, roles, and invites.</p><button class="btn btn-danger" type="button" id="del-server">Delete server</button>' : '') +
      '</section></div>';

    document.getElementById('srv-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var nameEl = document.getElementById('srv-name');
      if (!Ui.fieldError(nameEl, nameEl.value.trim() ? '' : 'Name cannot be empty.')) return;
      var v = document.getElementById('srv-vis').value;
      var btn = document.getElementById('srv-save');
      Ui.setLoading(btn, true, 'Saving…');
      try {
        await TrycordApi.patchServer(detail.id, {
          name: nameEl.value.trim(),
          description: document.getElementById('srv-desc').value.trim(),
          isPublic: v !== 'private',
          isDiscoverable: v === 'listed',
        });
        await Trycord.refreshServers();
        Ui.setLoading(btn, false);
        Ui.toast('Server updated.', 'good');
        workspace(document.getElementById('view'), detail.id, 'settings');
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.toast(err.message, 'bad');
      }
    });

    if (manageChannels) loadCategories(body, detail);

    var leaveBtn = document.getElementById('leave-btn2');
    if (leaveBtn) {
      leaveBtn.onclick = async () => {
        var yes = await Ui.confirmDialog({
          title: 'Leave ' + detail.name + '?',
          message: 'You can rejoin later with a new invite.',
          confirmText: 'Leave',
        });
        if (!yes) return;
        try {
          await TrycordApi.leaveServer(detail.id);
          await Trycord.refreshServers();
          Ui.toast('Left server.', 'info');
          location.hash = '#/servers';
        } catch (err) { Ui.toast(err.message, 'bad'); }
      };
    }
    var delBtn = document.getElementById('del-server');
    if (delBtn) {
      delBtn.onclick = async () => {
        var yes = await Ui.confirmDialog({
          title: 'Delete ' + detail.name + '?',
          message: 'This permanently deletes channels, messages, roles, and invites. This cannot be undone.',
          confirmText: 'Delete forever', danger: true,
        });
        if (!yes) return;
        try {
          await TrycordApi.deleteServer(detail.id);
          await Trycord.refreshServers();
          Ui.toast('Server deleted.', 'info');
          location.hash = '#/servers';
        } catch (err) { Ui.toast(err.message, 'bad'); }
      };
    }
  }

  async function loadCategories(body, detail) {
    var box = body.querySelector('#cat-list');
    if (!box) return;
    var data;
    try {
      data = await TrycordApi.channels(detail.id);
    } catch (e) {
      box.innerHTML = Ui.errorState(e.message);
      return;
    }
    var cats = data.categories || [];
    box.innerHTML = cats.length ? '<ul class="member-list">' + cats.map((c) =>
      '<li class="member-item"><span class="who"><strong>' + Ui.esc(c.name) + '</strong></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-cat-del="' + Ui.esc(c.id) + '">Delete</button></li>'
    ).join('') + '</ul>' : '<p class="muted">No categories — channels are ungrouped.</p>';
    box.querySelectorAll('[data-cat-del]').forEach((b) => {
      b.onclick = async () => {
        try {
          await TrycordApi.deleteCategory(detail.id, b.dataset.catDel);
          Ui.toast('Category deleted (channels kept).', 'good');
          loadCategories(body, detail);
        } catch (err) { Ui.toast(err.message, 'bad'); }
      };
    });
    document.getElementById('cat-new').addEventListener('submit', async (e) => {
      e.preventDefault();
      var input = document.getElementById('cat-name');
      if (!input.value.trim()) return;
      try {
        await TrycordApi.createCategory(detail.id, { name: input.value.trim() });
        Ui.toast('Category created.', 'good');
        loadCategories(body, detail);
      } catch (err) { Ui.toast(err.message, 'bad'); }
    }, { once: true });
  }

  window.TrycordPagesWorkspace = { workspace, cleanup: closeChat };
})();
