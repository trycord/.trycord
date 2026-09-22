/* Direct messages: conversation list, real-time conversation view,
   friends, requests, notifications. All data comes from the backend —
   nothing here is mocked. */
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

  function peerName(c) {
    return (c.peer && (c.peer.displayName || c.peer.username)) || 'Unknown';
  }

  function conversationListHtml(activeId, convs) {
    if (!convs.length) {
      return '<div class="nav-label">Direct messages</div>' +
        '<div style="padding:var(--tc-space-2);">' +
        Ui.emptyState({
          icon: Ui.icons.empty, title: 'No conversations yet.',
          hint: 'Find someone to talk to.',
          actions: '<button type="button" class="btn btn-primary btn-sm" data-new-dm>Start a conversation</button>',
        }) + '</div>';
    }
    var html = '<div class="nav-label">Direct messages</div>';
    convs.forEach((c) => {
      var on = String(activeId || '') === String(c.id);
      var last = c.lastMessage ? Ui.esc(c.lastMessage.content) : 'Start the conversation.';
      html += '<button type="button" class="dm-row' + (on ? ' active' : '') + (c.unreadCount ? ' unread' : '') + '" data-dm="' + Ui.esc(c.id) + '">' +
        C.presenceAvatar(peerName(c), '', c.peer && c.peer.presence) +
        '<span class="who"><span class="name">' + Ui.esc(peerName(c)) + '</span>' +
        '<span class="preview">' + last + '</span></span>' +
        (c.lastMessage ? '<span class="when">' + Ui.esc(Ui.timeAgo(c.lastMessage.createdAt)) + '</span>' : '') +
        (c.unreadCount ? '<span class="chan-badge">' + (c.unreadCount > 99 ? '99+' : c.unreadCount) + '</span>' : '') +
        '</button>';
    });
    return html;
  }

  function dmRowMenu(c, x, y) {
    Ui.contextMenu(x, y, [
      { label: 'Open conversation', icon: 'i-mail', onClick: () => { location.hash = '#/dm/' + encodeURIComponent(c.id); } },
      { label: 'View profile', icon: 'i-users', onClick: () => C.openProfileModal(c.peer && c.peer.id) },
      { label: 'Mark as read', icon: 'i-checks', hidden: !c.unreadCount, onClick: () => {
        TrycordApi.dmRead(c.id).then(() => Trycord.refreshSocial().then(() => window.TrycordRouter.route())).catch((err) => Ui.toast(err.message, 'error'));
      } },
    ]);
  }

  function wireNavList(root, onNew) {
    root.querySelectorAll('[data-dm]').forEach((b) => {
      b.onclick = () => { location.hash = '#/dm/' + encodeURIComponent(b.dataset.dm); };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        var c = TrycordState.dmById(b.dataset.dm);
        if (c) dmRowMenu(c, e.clientX, e.clientY);
      };
    });
    Ui.bindLongPress(root, '[data-dm]', (el, x, y) => {
      var c = TrycordState.dmById(el.dataset.dm);
      if (c) dmRowMenu(c, x, y);
    });
    var nw = root.querySelector('[data-new-dm]');
    if (nw) nw.onclick = onNew;
  }

  function startConversation() {
    C.openUserSearch((picked) => {
      TrycordApi.openDM(picked.id).then((c) => {
        Trycord.refreshSocial().then(() => { location.hash = '#/dm/' + encodeURIComponent(c.id); });
      }).catch((e) => Ui.toast(e.message, 'error'));
    });
  }

  // ---------- #/dm: tabs ----------

  var tab = 'chats';

  async function list(view) {
    C.setTopbar('Direct messages', 'Private conversations.', '', 'i-mail');
    try {
      var [convs, friends, reqs, notes] = await Promise.all([
        TrycordApi.dms().catch(() => []),
        TrycordApi.friends().catch(() => []),
        TrycordApi.friendRequests().catch(() => ({ incoming: [], outgoing: [] })),
        TrycordApi.notifications(30).catch(() => ({ items: [], unreadCount: 0 })),
      ]);
      TrycordState.setDMs(convs);
      TrycordState.setFriends(friends);
      TrycordState.setRequests(reqs.incoming, reqs.outgoing);
      TrycordState.setNotifications(notes.items, notes.unreadCount);
      C.renderRailBadges();
      C.renderBell();
    } catch (e) {
      view.innerHTML = Ui.errorState(e.message, 'Retry');
      var rb = view.querySelector('[data-retry]');
      if (rb) rb.onclick = () => list(view);
      return;
    }
    C.renderServerNav(conversationListHtml(null, TrycordState.dms), true);
    wireNavList(TrycordShell.el('server-nav-body'), startConversation);

    var tabs = [
      ['chats', 'Chats'],
      ['friends', 'Friends'],
      ['requests', 'Requests' + (TrycordState.pendingRequestCount() ? ' (' + TrycordState.pendingRequestCount() + ')' : '')],
      ['notifications', 'Notifications' + (TrycordState.notifications.unreadCount ? ' (' + TrycordState.notifications.unreadCount + ')' : '')],
    ];
    view.innerHTML =
      '<div class="tabs" role="tablist" style="margin-bottom:var(--tc-space-4);">' +
      tabs.map((t) => '<button type="button" role="tab" class="tab' + (tab === t[0] ? ' active' : '') + '" aria-selected="' + (tab === t[0]) + '" data-tab="' + t[0] + '">' + Ui.esc(t[1]) + '</button>').join('') +
      '</div><div id="dm-tab-body"></div>';
    view.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { tab = b.dataset.tab; list(view); };
    });
    var body = view.querySelector('#dm-tab-body');
    if (tab === 'friends') renderFriendsTab(body);
    else if (tab === 'requests') renderRequestsTab(body);
    else if (tab === 'notifications') renderNotificationsTab(body);
    else renderChatsTab(body);
  }

  function renderChatsTab(body) {
    var convs = TrycordState.dms;
    if (!convs.length) {
      body.innerHTML = Ui.emptyState({
        icon: Ui.icons.empty, title: 'No conversations yet.',
        hint: 'Find someone to talk to.',
        actions: '<button type="button" class="btn btn-primary" data-new-dm2>Start a conversation</button>',
      });
      body.querySelector('[data-new-dm2]').onclick = startConversation;
      return;
    }
    body.innerHTML = convs.map((c) =>
      '<button type="button" class="dm-row' + (c.unreadCount ? ' unread' : '') + '" data-open-dm="' + Ui.esc(c.id) + '" style="border-bottom:1px solid var(--tc-border-subtle);border-radius:0;padding:var(--tc-space-3) var(--tc-space-2);">' +
      C.presenceAvatar(peerName(c), '', c.peer && c.peer.presence) +
      '<span class="who"><span class="name">' + Ui.esc(peerName(c)) + '</span>' +
      '<span class="preview">' + (c.lastMessage ? Ui.esc(c.lastMessage.content) : 'Start the conversation.') + '</span></span>' +
      (c.lastMessage ? '<span class="when">' + Ui.esc(Ui.timeAgo(c.lastMessage.createdAt)) + '</span>' : '') +
      (c.unreadCount ? '<span class="chan-badge">' + (c.unreadCount > 99 ? '99+' : c.unreadCount) + '</span>' : '') +
      '</button>'
    ).join('');
    body.querySelectorAll('[data-open-dm]').forEach((b) => {
      b.onclick = () => { location.hash = '#/dm/' + encodeURIComponent(b.dataset.openDm); };
    });
  }

  function renderFriendsTab(body) {
    var friends = TrycordState.friends;
    var html = '<div style="display:flex;gap:var(--tc-space-2);margin-bottom:var(--tc-space-4);">' +
      '<button type="button" class="btn btn-primary btn-sm" data-add-friend>Add friend</button></div>';
    if (!friends.length) {
      html += Ui.emptyState({ icon: Ui.icons.empty, title: 'No friends yet.', hint: 'Find someone on Trycord to get started.' });
    } else {
      html += friends.map((f) =>
        '<div class="member-row" data-user="' + Ui.esc(f.id) + '">' +
        C.presenceAvatar(f.displayName || f.username, '', f.presence) +
        '<span class="who"><span class="name">' + Ui.esc(f.displayName || f.username) + '</span>' +
        '<span class="sub">@' + Ui.esc(f.username) + ' · ' + Ui.esc(f.presence || 'offline') + '</span></span>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-msg>Message</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-unfriend>Remove</button></div>'
      ).join('');
    }
    body.innerHTML = html;
    body.querySelector('[data-add-friend]').onclick = () => {
      C.openUserSearch((picked) => {
        TrycordApi.friendRequest(picked.id)
          .then(() => { Ui.toast('Friend request sent.', 'success'); return Trycord.refreshSocial(); })
          .then(() => list(TrycordShell.el('view')))
          .catch((e) => Ui.toast(e.message, 'error'));
      });
    };
    body.querySelectorAll('[data-msg]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        var id = b.closest('[data-user]').dataset.user;
        TrycordApi.openDM(id).then((c) => { location.hash = '#/dm/' + encodeURIComponent(c.id); })
          .catch((err) => Ui.toast(err.message, 'error'));
      };
    });
    body.querySelectorAll('[data-unfriend]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        var id = b.closest('[data-user]').dataset.user;
        var yes = await Ui.confirmDialog({ title: 'Remove friend?', message: 'They will be removed from your friends list.', confirmText: 'Remove' });
        if (!yes) return;
        TrycordApi.friendRemove(id).then(() => {
          Ui.toast('Friend removed.', 'success');
          return Trycord.refreshSocial();
        }).then(() => list(TrycordShell.el('view')))
          .catch((err) => Ui.toast(err.message, 'error'));
      };
    });
    body.querySelectorAll('.member-row[data-user]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('button')) return;
        C.openProfileModal(row.dataset.user);
      };
    });
  }

  function renderRequestsTab(body) {
    var inc = TrycordState.requests.incoming || [];
    var out = TrycordState.requests.outgoing || [];
    var html = '<div class="nav-label">Incoming</div>';
    html += inc.length ? inc.map((r) =>
      '<div class="member-row"><span>' + Ui.avatarHtml(r.from.displayName || r.from.username, '') + '</span>' +
      '<span class="who"><span class="name">' + Ui.esc(r.from.displayName || r.from.username) + '</span>' +
      '<span class="sub">@' + Ui.esc(r.from.username) + '</span></span>' +
      '<button type="button" class="btn btn-primary btn-sm" data-accept="' + Ui.esc(r.id) + '">Accept</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-decline="' + Ui.esc(r.id) + '">Decline</button></div>'
    ).join('') : '<p class="text-muted text-sm" style="padding:0 var(--tc-space-2);">No incoming requests.</p>';
    html += '<div class="nav-label">Outgoing</div>';
    html += out.length ? out.map((r) =>
      '<div class="member-row"><span>' + Ui.avatarHtml(r.to.displayName || r.to.username, '') + '</span>' +
      '<span class="who"><span class="name">' + Ui.esc(r.to.displayName || r.to.username) + '</span>' +
      '<span class="sub">@' + Ui.esc(r.to.username) + '</span></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-cancel="' + Ui.esc(r.id) + '">Cancel</button></div>'
    ).join('') : '<p class="text-muted text-sm" style="padding:0 var(--tc-space-2);">No outgoing requests.</p>';
    body.innerHTML = html;
    function refresh() {
      Trycord.refreshSocial().then(() => list(TrycordShell.el('view')));
    }
    body.querySelectorAll('[data-accept]').forEach((b) => {
      b.onclick = () => TrycordApi.friendAccept(b.dataset.accept)
        .then(() => { Ui.toast('Friend request accepted.', 'success'); return Trycord.refreshSocial(); })
        .then(() => list(TrycordShell.el('view')))
        .catch((e) => Ui.toast(e.message, 'error'));
    });
    body.querySelectorAll('[data-decline]').forEach((b) => {
      b.onclick = () => TrycordApi.friendDecline(b.dataset.decline).then(refresh).catch((e) => Ui.toast(e.message, 'error'));
    });
    body.querySelectorAll('[data-cancel]').forEach((b) => {
      b.onclick = () => TrycordApi.friendCancel(b.dataset.cancel).then(refresh).catch((e) => Ui.toast(e.message, 'error'));
    });
  }

  function renderNotificationsTab(body) {
    var items = TrycordState.notifications.items || [];
    var html = items.length
      ? '<div style="display:flex;justify-content:flex-end;margin-bottom:var(--tc-space-3);">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-read-all>Mark all read</button></div>' : '';
    if (!items.length) {
      html += Ui.emptyState({ icon: Ui.icons.empty, title: "You're all caught up.", hint: '' });
    } else {
      html += items.map((n) => {
        var who = (n.actor && (n.actor.displayName || n.actor.username)) || 'Trycord';
        var what = n.type === 'dm' ? 'sent you a message'
          : n.type === 'friend_request' ? 'sent you a friend request'
          : n.type === 'friend_accepted' ? 'accepted your friend request' : 'mentioned you';
        return '<div class="notif-row' + (n.readAt ? '' : ' unread') + '" data-notif="' + Ui.esc(n.id) + '" data-ref="' + Ui.esc(n.referenceId || '') + '" data-kind="' + Ui.esc(n.type) + '">' +
          Ui.avatarHtml(who, '') +
          '<div class="body"><b>' + Ui.esc(who) + '</b> ' + Ui.esc(what) + '<br>' +
          '<span class="text-muted">' + Ui.esc(Ui.timeAgo(n.createdAt)) + (n.readAt ? '' : ' · unread') + '</span></div></div>';
      }).join('');
    }
    body.innerHTML = html;
    var all = body.querySelector('[data-read-all]');
    if (all) {
      all.onclick = () => TrycordApi.notifReadAll()
        .then(() => Trycord.refreshSocial())
        .then(() => list(TrycordShell.el('view')))
        .catch((e) => Ui.toast(e.message, 'error'));
    }
    body.querySelectorAll('[data-notif]').forEach((row) => {
      row.onclick = () => {
        TrycordApi.notifRead(row.dataset.notif).catch(() => {});
        if (row.dataset.kind === 'dm' && row.dataset.ref) location.hash = '#/dm/' + encodeURIComponent(row.dataset.ref);
        else { tab = 'chats'; list(TrycordShell.el('view')); }
        Trycord.refreshSocial();
      };
    });
  }

  // ---------- #/dm/:id: conversation ----------

  async function conversation(view, id) {
    var detail;
    try {
      detail = await TrycordApi.dmDetail(id);
    } catch (e) {
      C.setTopbar('Direct messages', '', '', 'i-mail');
      C.renderServerNav(conversationListHtml(null, TrycordState.dms), true);
      wireNavList(TrycordShell.el('server-nav-body'), startConversation);
      view.innerHTML = Ui.errorState(e.message, 'Back to messages');
      var rb = view.querySelector('[data-retry]');
      if (rb) rb.onclick = () => { location.hash = '#/dm'; };
      return;
    }
    var peer = detail.peer || {};
    var peerId = peer.id;
    C.setTopbar(peerName({ peer }), (peer.presence || 'offline') + ' · Direct message',
      '<button type="button" class="icon-btn" data-profile title="View profile" aria-label="View profile"><svg aria-hidden="true"><use href="#i-users"/></svg></button>', 'i-mail');
    try {
      var fresh = await TrycordApi.dms().catch(() => []);
      if (fresh.length) TrycordState.setDMs(fresh);
    } catch (e) { /* list is best-effort here */ }
    C.renderServerNav(conversationListHtml(id, TrycordState.dms), true);
    wireNavList(TrycordShell.el('server-nav-body'), startConversation);
    var profBtn = TrycordShell.q('#topbar-actions [data-profile]');
    if (profBtn) profBtn.onclick = () => C.openProfileModal(peerId);

    var myLastRead = null;
    (detail.members || []).forEach((m) => {
      if (String(m.userId) === String(TrycordState.user.id)) myLastRead = m.lastReadAt;
    });
    var peerReadAt = null;
    (detail.members || []).forEach((m) => {
      if (String(m.userId) !== String(TrycordState.user.id)) {
        if (!peerReadAt || String(m.lastReadAt || '') > String(peerReadAt)) peerReadAt = m.lastReadAt;
      }
    });

    view.innerHTML =
      '<div style="display:flex;flex-direction:column;height:100%;min-height:0;">' +
      '<ul class="msg-list" id="dm-list" style="flex:1;overflow-y:auto;" aria-label="Messages"></ul>' +
      '<div class="typing-row" id="dm-typing" aria-live="polite"></div>' +
      '<form class="composer" id="dm-composer">' +
      '<div class="composer-box"><textarea id="dm-input" rows="1" placeholder="Message ' + Ui.esc(peerName({ peer })) + '…" aria-label="Message text"></textarea>' +
      '<button type="submit" class="composer-send" id="dm-send" aria-label="Send message"><svg aria-hidden="true"><use href="#i-send"/></svg></button></div>' +
      '<div class="composer-hint">Enter to send · Shift+Enter for a new line</div>' +
      '</form></div>';

    var listEl = view.querySelector('#dm-list');
    var input = view.querySelector('#dm-input');
    var typingEl = view.querySelector('#dm-typing');
    var rendered = [];
    var renderedIds = {};
    var hasMore = detail.messages.length >= 50;
    var loadingMore = false;
    var myId = TrycordState.user.id;

    function groupable(prev, m) {
      if (!prev || String(prev.authorId) !== String(m.authorId)) return false;
      var dt = new Date(m.createdAt) - new Date(prev.createdAt);
      return dt >= 0 && dt < 5 * 60 * 1000;
    }

    function paint(focusBottom, keepPos) {
      var prevHeight = keepPos ? listEl.scrollHeight : 0;
      var prevTop = keepPos ? listEl.scrollTop : 0;
      var unreadAnchor = null;
      listEl.innerHTML = rendered.map((m, i) => {
        var grouped = i > 0 && groupable(rendered[i - 1], m);
        var mine = String(m.authorId) === String(myId);
        var showDivider = !unreadAnchor && myLastRead && String(m.createdAt) > String(myLastRead) && !mine;
        var html = '';
        if (showDivider) {
          unreadAnchor = m.id;
          html += '<li class="msg-unread" aria-hidden="true"><span>New</span></li>';
        }
        var mine2 = String(m.authorId) === String(myId);
        html += C.renderMessage(m, {
          grouped,
          canDelete: mine2,
          canEdit: mine2,
          showRead: true,
          isMine: mine2,
          peerReadAt: peerReadAt,
        });
        return html;
      }).join('');
      C.wireMessageList(listEl, {
        onDelete: (mid) => {
          TrycordApi.dmDelete(id, mid).catch((e) => Ui.toast(e.message, 'error'));
        },
        onEdit: (mid) => editMessage(mid),
      });
      if (focusBottom) listEl.scrollTop = listEl.scrollHeight;
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
      rendered.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
      var nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
      paint(toBottom || nearBottom, added && !toBottom && !nearBottom);
    }

    function applyUpdatedMessage(ev) {
      var idx = -1;
      rendered.forEach((m, i) => { if (String(m.id) === String(ev.id)) idx = i; });
      if (idx === -1) return false;
      rendered[idx] = Object.assign({}, rendered[idx], { content: ev.content, editedAt: ev.editedAt || null });
      paint(false, false);
      return true;
    }

    function editMessage(mid) {
      var m = rendered.find((x) => String(x.id) === String(mid));
      if (!m || String(m.authorId) !== String(myId)) return;
      C.openEditModal(m.content, (text) =>
        TrycordApi.dmEdit(id, mid, text).then((out) => {
          applyUpdatedMessage({ id: mid, content: out.content, editedAt: out.editedAt || null });
        })
      );
    }

    rendered = [];
    renderedIds = {};
    addMessages(detail.messages, true);
    if (!rendered.length) {
      listEl.innerHTML = '<li style="list-style:none;"><div style="max-width:26rem;margin:var(--tc-space-8) auto;text-align:center;">' +
        '<div class="empty-state-icon" aria-hidden="true">✉</div>' +
        '<h3 class="empty-state-title">Start the conversation.</h3>' +
        '<p class="empty-state-text">Say hello to ' + Ui.esc(peerName({ peer })) + '.</p></div></li>';
    }

    // Viewing marks read (debounced so rapid events don't spam).
    var readTimer = null;
    function markReadSoon() {
      clearTimeout(readTimer);
      readTimer = setTimeout(() => {
        TrycordApi.dmRead(id).then((r) => {
          myLastRead = r.lastReadAt;
          var c = TrycordState.dmById(id);
          if (c) {
            c.unreadCount = 0;
            C.renderRailBadges();
          }
        }).catch(() => {});
      }, 800);
    }
    markReadSoon();

    listEl.addEventListener('scroll', () => {
      if (listEl.scrollTop > 120 || loadingMore || !hasMore || !rendered.length) return;
      loadingMore = true;
      var oldest = rendered[0].id;
      var prevHeight = listEl.scrollHeight;
      TrycordApi.dmHistory(id, oldest, 50).then((older) => {
        if (older.length < 50) hasMore = false;
        var fresh = older.filter((m) => !renderedIds[m.id]);
        fresh.forEach((m) => { renderedIds[m.id] = true; });
        rendered = fresh.concat(rendered);
        paint(false);
        listEl.scrollTop = listEl.scrollHeight - prevHeight;
      }).catch(() => {}).finally(() => { loadingMore = false; });
    });

    // Typing state: throttled outbound, expiring inbound.
    var typingTimers = {};
    function showTyping(userId, username) {
      if (String(userId) === String(myId)) return;
      typingEl.innerHTML = '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span> ' + Ui.esc(username || peerName({ peer })) + ' is typing…';
      clearTimeout(typingTimers[userId]);
      typingTimers[userId] = setTimeout(() => { typingEl.innerHTML = ''; }, 4000);
    }
    var lastTypedAt = 0;
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 192) + 'px';
      var nowTs = Date.now();
      if (nowTs - lastTypedAt > 2500 && wsRef.sock && wsRef.sock.readyState === 1) {
        lastTypedAt = nowTs;
        try { wsRef.sock.send(JSON.stringify({ type: 'dm:typing', conversationId: id })); } catch (e) {}
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        view.querySelector('#dm-composer').requestSubmit();
      }
    });

    var wsRef = { sock: null };
    var sendBtn = view.querySelector('#dm-send');
    view.querySelector('#dm-composer').addEventListener('submit', (e) => {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      Ui.setLoading(sendBtn, true, '…');
      TrycordApi.dmSend(id, text).then((m) => {
        input.value = '';
        input.style.height = 'auto';
        addMessages([Object.assign(m, { authorName: m.authorName || 'You' })], true);
        var c = TrycordState.dmById(id);
        if (c) TrycordState.touchDM(id, { lastMessage: m, updatedAt: m.createdAt });
        markReadSoon();
      }).catch((err) => Ui.toast(err.message, 'error'))
        .finally(() => Ui.setLoading(sendBtn, false));
    });

    listEl.oncontextmenu = (e) => {
      var li = e.target.closest('[data-mid]');
      if (!li) return;
      e.preventDefault();
      var m = rendered.find((x) => String(x.id) === String(li.dataset.mid));
      if (!m) return;
      var mine = String(m.authorId) === String(myId);
      Ui.contextMenu(e.clientX, e.clientY, [
        { label: 'Copy text', icon: 'i-copy', onClick: () => C.copyText(li.querySelector('.text').textContent, 'Message copied.') },
        { label: 'Edit message', icon: 'i-pen', hidden: !mine, onClick: () => editMessage(m.id) },
        { label: 'Delete message', icon: 'i-trash', danger: true, hidden: !mine, onClick: () => TrycordApi.dmDelete(id, m.id).catch((err) => Ui.toast(err.message, 'error')) },
      ]);
    };
    // Long-press / touch menu already routes through wireMessageList into
    // the contextmenu handler above: one menu, every input method.
    cleanupFn = C.connectSocket({
      onOpen: (sock) => {
        wsRef.sock = sock;
        try { sock.send(JSON.stringify({ type: 'dm:join', conversationId: id })); } catch (e) {}
      },
      onStatus: (st) => {
        C.setTopbar(peerName({ peer }), st === 'connected'
          ? ((peer.presence || 'offline') + ' · Direct message')
          : 'Reconnecting…', TrycordShell.q('#topbar-actions') ? TrycordShell.q('#topbar-actions').innerHTML : '', 'i-mail');
        var pb = TrycordShell.q('#topbar-actions [data-profile]');
        if (pb) pb.onclick = () => C.openProfileModal(peerId);
      },
      onEvent: (ev) => {
        if (ev.conversationId && String(ev.conversationId) !== String(id)) {
          C.handleSignal(ev, {});
          return;
        }
        if (ev.type === 'dm:message') {
          addMessages([ev], false);
          var c = TrycordState.dmById(id);
          if (c) TrycordState.touchDM(id, { lastMessage: ev, updatedAt: ev.createdAt });
          markReadSoon();
        } else if (ev.type === 'dm:message_deleted') {
          delete renderedIds[ev.id];
          rendered = rendered.filter((m) => String(m.id) !== String(ev.id));
          paint(false);
        } else if (ev.type === 'dm:message_updated') {
          applyUpdatedMessage(ev);
        } else if (ev.type === 'dm:read') {
          if (String(ev.userId) !== String(myId)) {
            peerReadAt = ev.lastReadAt;
            paint(false);
          }
        } else if (ev.type === 'dm:typing') {
          showTyping(ev.userId, ev.username);
        } else {
          C.handleSignal(ev, { dmId: id });
        }
      },
    });
  }

  window.TrycordPagesDms = { list, conversation, cleanup };
})();
