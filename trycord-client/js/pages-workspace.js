/* Server workspace: header + tabs (Overview, Chat, Members, Settings). */
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

  async function workspace(root, serverId, tab, deepChannelId) {
    tab = tab || 'overview';
    var detail;
    try {
      detail = await TrycordApi.serverDetail(serverId);
    } catch (e) {
      Ui.toast(e.message, 'bad');
      location.hash = '#/servers';
      return;
    }
    TrycordState.touchRecent(detail.id);
    current.serverId = detail.id;

    if (tab === 'settings' && !detail.is_owner) {
      Ui.toast('Only the server owner can open settings.', 'bad');
      location.hash = '#/server/' + encodeURIComponent(detail.id) + '/overview';
      return;
    }

    C.setTopbar(detail.name, 'Server workspace', '');
    var isFav = TrycordState.isFav(detail.id);
    root.innerHTML =
      '<section class="ws-head">' + Ui.avatarHtml(detail.name, 'lg') +
      '<div class="titles"><h2>' + Ui.esc(detail.name) + '</h2>' +
      '<p class="desc">' + Ui.esc(detail.description || 'No description.') + '</p>' +
      '<div class="meta row wrap" style="margin-top:0.4rem">' +
      (detail.is_owner ? Ui.badge('Owner', 'owner') : Ui.badge('Member', '')) +
      (detail.is_public ? Ui.badge('Public', 'pub') : Ui.badge('Private', 'priv')) +
      Ui.badge(detail.member_count + ' member' + (detail.member_count === 1 ? '' : 's'), '') +
      '</div></div>' +
      '<div class="side">' +
      '<span class="code-chip" title="Invite code">⌁ ' + Ui.esc(detail.join_code) +
      ' <button type="button" class="btn btn-ghost btn-sm" id="copy-code">Copy</button></span>' +
      '<button type="button" class="icon-btn fav-btn" data-fav="' + Ui.esc(detail.id) + '" ' +
      'aria-pressed="' + (isFav ? 'true' : 'false') + '" title="Toggle favorite">' + (isFav ? '★' : '☆') + '</button>' +
      '</div></section>' +
      '<div class="tabs" role="tablist" aria-label="Server sections">' +
      ['overview', 'chat', 'members'].concat(detail.is_owner ? ['settings'] : []).map((t) =>
        '<button type="button" role="tab" class="tab" data-tab="' + t + '" aria-selected="' + (t === tab ? 'true' : 'false') + '">' +
        t[0].toUpperCase() + t.slice(1) + '</button>').join('') +
      '</div>' +
      '<div id="ws-body"></div>';

    C.wireCards(root);
    document.getElementById('copy-code').onclick = async () => {
      try {
        await navigator.clipboard.writeText(detail.join_code);
        Ui.toast('Invite code copied.', 'good');
      } catch (e) {
        Ui.toast('Invite code: ' + detail.join_code, 'info');
      }
    };
    root.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        location.hash = '#/server/' + encodeURIComponent(detail.id) + '/' + b.dataset.tab;
      };
    });

    var body = document.getElementById('ws-body');
    if (tab === 'overview') await renderOverview(body, detail);
    else if (tab === 'chat') await renderChat(body, detail, deepChannelId);
    else if (tab === 'members') await renderMembers(body, detail);
    else if (tab === 'settings') renderSettings(body, detail);
  }

  // --- overview -----------------------------------------------------------
  async function renderOverview(body, detail) {
    body.innerHTML =
      '<div class="stats">' +
      '<div class="stat"><div class="num">' + detail.member_count + '</div><div class="lbl">Members</div></div>' +
      '<div class="stat"><div class="num">' + detail.channel_count + '</div><div class="lbl">Channels</div></div>' +
      '<div class="stat"><div class="num">' + detail.message_count + '</div><div class="lbl">Messages</div></div>' +
      '<div class="stat"><div class="num">' + Ui.timeAgo(detail.created_at) + '</div><div class="lbl">Created</div></div>' +
      '</div>' +
      '<div class="toolbar">' +
      '<a class="btn btn-primary btn-sm" href="#/server/' + encodeURIComponent(detail.id) + '/chat">Open chat</a>' +
      (detail.is_owner
        ? '<a class="btn btn-ghost btn-sm" href="#/server/' + encodeURIComponent(detail.id) + '/settings">Server settings</a>'
        : '<a class="btn btn-ghost btn-sm" href="#/server/' + encodeURIComponent(detail.id) + '/members">View members</a>') +
      '</div>' +
      '<section class="section"><h2>Recent activity</h2><div id="ws-activity">' + Ui.skeletons(3) + '</div></section>';

    try {
      var acts = (await TrycordApi.activity(30)).filter((a) => a.server_id === detail.id).slice(0, 5);
      var box = document.getElementById('ws-activity');
      if (!box) return;
      box.innerHTML = acts.length
        ? '<div class="activity-list">' + acts.map(TrycordPagesHome.activityItem).join('') + '</div>'
        : Ui.emptyState({ icon: '◷', title: 'No activity yet', hint: 'Be the first to post in #' + 'general.' });
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
    body.innerHTML =
      '<div class="chat-grid"><div class="chat-channels">' +
      '<div class="nav-label">Channels</div><div id="ch-list">' + Ui.skeletons(3) + '</div>' +
      '<form id="ch-new" class="stack" style="margin-top:0.6rem">' +
      '<input type="text" id="ch-name" placeholder="new-channel" maxlength="32" aria-label="New channel name" />' +
      '<button class="btn btn-sm" type="submit">+ Add channel</button></form>' +
      '</div>' +
      '<div class="chat-pane"><div class="chat-topic" id="ch-topic">Select a channel</div>' +
      '<ul class="msg-list" id="msg-list" aria-live="polite"></ul>' +
      '<form class="composer" id="composer"><input id="msg-input" placeholder="Type a message…" autocomplete="off" aria-label="Message" />' +
      '<button class="btn btn-primary" type="submit">Send</button></form></div></div>';

    var channels = [];
    try {
      channels = await TrycordApi.channels(detail.id);
    } catch (e) {
      document.getElementById('ch-list').innerHTML = Ui.errorState(e.message);
      return;
    }
    var list = document.getElementById('ch-list');
    function paintChannels() {
      list.innerHTML = '';
      channels.forEach((c) => {
        var row = document.createElement('div');
        row.className = 'channel-row';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'channel-btn' + (c.id === current.channelId ? ' active' : '');
        btn.textContent = '# ' + c.name;
        btn.onclick = () => selectChannel(c.id);
        row.appendChild(btn);
        if (detail.is_owner) {
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
        list.appendChild(row);
      });
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
      var tx = document.createElement('div');
      tx.className = 'text';
      tx.textContent = m.content || '';
      bd.append(meta, tx);
      li.append(av, bd);
      document.getElementById('msg-list').appendChild(li);
      li.scrollIntoView({ block: 'nearest' });
    }

    document.getElementById('ch-new').addEventListener('submit', async (e) => {
      e.preventDefault();
      var input = document.getElementById('ch-name');
      var name = input.value.trim();
      if (!name) return;
      try {
        var r = await TrycordApi.createChannel(detail.id, { name });
        channels = await TrycordApi.channels(detail.id);
        input.value = '';
        paintChannels();
        selectChannel(r.channelId);
        Ui.toast('Channel created.', 'good');
      } catch (err) { Ui.toast(err.message, 'bad'); }
    });

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
        } catch (e) { /* ignore */ }
      };
    } else {
      document.getElementById('msg-list').innerHTML = '<li class="muted">No channels yet.</li>';
    }
  }

  // --- members ------------------------------------------------------------
  async function renderMembers(body, detail) {
    body.innerHTML = '<div id="mem-list">' + Ui.skeletons(4) + '</div>';
    var box = document.getElementById('mem-list');
    try {
      var members = await TrycordApi.serverMembers(detail.id);
      box.innerHTML = '<p class="muted">' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</p>' +
        '<ul class="member-list">' + members.map((m) =>
          '<li class="member-item">' + Ui.avatarHtml(m.display_name || m.username) +
          '<span class="who"><strong>' + Ui.esc(m.display_name || m.username) +
          ' <small>@' + Ui.esc(m.username) + '</small></strong>' +
          '<small>Joined ' + Ui.fullDate(m.joined_at) + '</small></span>' +
          (m.is_owner ? Ui.badge('Owner', 'owner') : '') + '</li>').join('') + '</ul>';
    } catch (e) {
      box.innerHTML = Ui.errorState(e.message);
      var rb = box.querySelector('[data-retry]');
      if (rb) rb.onclick = () => renderMembers(body, detail);
    }
  }

  // --- settings (owner) ----------------------------------------------------
  function renderSettings(body, detail) {
    body.innerHTML =
      '<div class="settings-grid"><section class="settings-card"><h2>Server settings</h2>' +
      '<form id="srv-form">' +
      '<label class="field"><span>Name</span><input type="text" id="srv-name" maxlength="64" value="' + Ui.esc(detail.name) + '" /></label>' +
      '<label class="field"><span>Description</span><textarea id="srv-desc" maxlength="500">' + Ui.esc(detail.description || '') + '</textarea></label>' +
      '<label class="switch"><input type="checkbox" id="srv-public"' + (detail.is_public ? ' checked' : '') + ' />' +
      '<span class="track" aria-hidden="true"></span>List publicly in Discover</label>' +
      '<div class="form-row" style="margin-top:0.8rem"><button class="btn btn-primary" type="submit" id="srv-save">Save changes</button></div>' +
      '</form></section>' +
      '<section class="settings-card"><h2>Invite code</h2>' +
      '<p class="hint">Share this code so others can join. Anyone with the code can join.</p>' +
      '<p><span class="code-chip">⌁ ' + Ui.esc(detail.join_code) + '</span></p></section></div>';

    document.getElementById('srv-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var nameEl = document.getElementById('srv-name');
      if (!Ui.fieldError(nameEl, nameEl.value.trim() ? '' : 'Name cannot be empty.')) return;
      var btn = document.getElementById('srv-save');
      Ui.setLoading(btn, true, 'Saving…');
      try {
        await TrycordApi.patchServer(detail.id, {
          name: nameEl.value.trim(),
          description: document.getElementById('srv-desc').value.trim(),
          isPublic: document.getElementById('srv-public').checked,
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
  }

  window.TrycordPagesWorkspace = { workspace, cleanup: closeChat };
})();
