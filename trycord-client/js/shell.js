/* Shell chrome: rail, topbar, menus, palette, context actions, profiles,
   server rows, shared message rendering, socket helper, realtime signals.
   Exposed as window.TrycordComponents (same contract name as before). */
(function () {
  var Ui = window.TrycordUi;

  var NAV = [
    { hash: '#/home', label: 'Home', icon: 'i-home' },
    { hash: '#/servers', label: 'Servers', icon: 'i-grid' },
    { hash: '#/dm', label: 'Direct messages', icon: 'i-mail' },
    { hash: '#/discover', label: 'Discover', icon: 'i-globe' },
    { hash: '#/activity', label: 'Activity', icon: 'i-activity' },
    { hash: '#/favorites', label: 'Favorites', icon: 'i-star' },
    { hash: '#/join', label: 'Join server', icon: 'i-plus' },
  ];

  function railActiveFor(hash) {
    if (!hash) return '#/home';
    if (hash.indexOf('#/server/') === 0) return '#/servers';
    if (hash.indexOf('#/dm') === 0) return '#/dm';
    if (hash.indexOf('#/discover') === 0) return '#/discover';
    if (hash.indexOf('#/activity') === 0) return '#/activity';
    if (hash.indexOf('#/favorites') === 0) return '#/favorites';
    if (hash.indexOf('#/servers') === 0 || hash.indexOf('#/join') === 0) return '#/servers';
    if (hash.indexOf('#/settings') === 0) return '#/home';
    return '#/home';
  }

  function renderRail(active) {
    var want = railActiveFor(active || location.hash);
    document.querySelectorAll('#rail .rail-item[data-nav]').forEach(function (b) {
      var on = b.getAttribute('data-nav') === want;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    renderRailServers();
    renderRailBadges();
    renderMobileBar(want);
  }

  // Back-compat alias (older code called this renderSidebar).
  function renderSidebar(active) {
    renderRail(active);
  }

  function renderRailServers() {
    var box = document.getElementById('rail-servers');
    if (!box) return;
    var servers = (window.TrycordState && TrycordState.servers) || [];
    box.innerHTML = servers.slice(0, 30).map(function (s) {
      var active = (location.hash || '').indexOf('#/server/' + encodeURIComponent(s.id)) === 0;
      return '<button type="button" class="rail-item' + (active ? ' active' : '') + '" data-open="' + Ui.esc(s.id) + '"' +
        ' data-tip="' + Ui.esc(s.name) + '" title="' + Ui.esc(s.name) + '" aria-label="' + Ui.esc(s.name) + '" role="listitem">' +
        '<span class="rail-pill" aria-hidden="true"></span>' + Ui.avatarHtml(s.name, '') + '</button>';
    }).join('');
    box.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { location.hash = '#/server/' + encodeURIComponent(b.dataset.open); };
      b.oncontextmenu = function (e) {
        e.preventDefault();
        var s = TrycordState.serverById(b.dataset.open);
        if (s) serverMenu(e.clientX, e.clientY, s);
      };
    });
    Ui.bindLongPress(box, '[data-open]', function (el, x, y) {
      var s = TrycordState.serverById(el.dataset.open);
      if (s) serverMenu(x, y, s);
    });
  }

  function renderRailBadges() {
    var total = window.TrycordState ? TrycordState.dmUnreadTotal() : 0;
    var badge = document.getElementById('dm-badge');
    if (badge) {
      badge.hidden = !total;
      badge.textContent = total > 99 ? '99+' : String(total);
    }
    var dmTab = document.querySelector('#rail .rail-item[data-nav="#/dm"]');
    if (dmTab) dmTab.classList.toggle('has-unread', total > 0);
  }

  function renderMobileBar(active) {
    var bar = document.getElementById('mobilebar');
    if (!bar) return;
    var items = [
      { hash: '#/home', label: 'Home', icon: 'i-home' },
      { hash: '#/servers', label: 'Servers', icon: 'i-grid' },
      { hash: '#/dm', label: 'DMs', icon: 'i-mail' },
      { hash: '#/activity', label: 'Activity', icon: 'i-activity' },
    ];
    bar.innerHTML = items.map(function (it) {
      var on = (active || '') === it.hash ||
        (it.hash === '#/servers' && (active || '').indexOf('#/server/') === 0);
      return '<button type="button" class="mnav' + (on ? ' active' : '') + '" data-nav="' + it.hash + '" aria-label="' + it.label + '">' +
        '<svg class="icon" aria-hidden="true"><use href="#' + it.icon + '"/></svg>' + it.label + '</button>';
    }).join('');
    bar.querySelectorAll('[data-nav]').forEach(function (b) {
      b.onclick = function () { location.hash = b.getAttribute('data-nav'); };
    });
  }

  function renderServerNav(html, show) {
    var nav = document.getElementById('server-nav');
    var body = document.getElementById('server-nav-body');
    if (!nav || !body) return;
    if (typeof html === 'string') body.innerHTML = html;
    nav.hidden = !show;
  }

  function hideServerNav() {
    var nav = document.getElementById('server-nav');
    if (nav) nav.hidden = true;
  }

  function setTopbar(title, subtitle, actionsHtml, iconId) {
    var t = document.getElementById('page-title');
    var s = document.getElementById('page-sub');
    var icon = document.getElementById('ctx-icon');
    if (t) t.textContent = title || '';
    if (s) s.textContent = subtitle || '';
    if (icon) icon.innerHTML = iconId ? '<svg aria-hidden="true" style="width:1.2rem;height:1.2rem;"><use href="#' + iconId + '"/></svg>' : '';
    var bar = document.querySelector('.topbar-actions');
    if (!bar) return;
    var old = document.getElementById('topbar-actions');
    if (old) old.remove();
    if (actionsHtml) {
      var wrap = document.createElement('div');
      wrap.id = 'topbar-actions';
      wrap.className = 'row';
      wrap.style.display = 'contents';
      wrap.innerHTML = actionsHtml;
      var pill = document.getElementById('conn-pill');
      bar.insertBefore(wrap, pill || bar.firstChild);
    }
  }

  function presenceAvatar(name, size, presence) {
    var ring = presence === 'online' ? ' online' : '';
    return '<span class="avatar-presence' + ring + '">' + Ui.avatarHtml(name, size || '') + '</span>';
  }

  function renderUser() {
    var u = (window.TrycordState && TrycordState.user) || null;
    var name = u ? (u.displayName || u.username) : '–';
    var sub = u ? ('@' + u.username) : '–';
    var railImg = document.getElementById('rail-avatar-img');
    if (railImg) railImg.innerHTML = Ui.avatarHtml(name, '');
    var accAv = document.getElementById('account-avatar');
    if (accAv) accAv.innerHTML = Ui.avatarHtml(name, '');
    var accName = document.getElementById('account-name');
    if (accName) accName.textContent = name;
    var accSub = document.getElementById('account-sub');
    if (accSub) accSub.textContent = sub;
    var ab = document.getElementById('avatar-btn');
    if (ab) {
      ab.innerHTML = Ui.avatarHtml(name, '');
      ab.setAttribute('aria-label', 'Account menu for ' + name);
    }
    var strip = document.getElementById('account-strip');
    if (strip) strip.hidden = !u;
    renderBell();
  }

  function renderBell() {
    var dot = document.getElementById('bell-dot');
    if (!dot) return;
    var n = window.TrycordState ? (window.TrycordState.notifications.unreadCount || 0) : 0;
    dot.hidden = !n;
    dot.textContent = n > 99 ? '99+' : String(n);
  }

  function closeMenus() {
    var root = document.getElementById('menu-root');
    if (root) root.innerHTML = '';
    ['#rail-account', '#avatar-btn', '#bell-btn'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.setAttribute('aria-expanded', 'false');
    });
  }

  function openMenu(anchor, build) {
    var root = document.getElementById('menu-root');
    if (!root) return;
    var willOpen = !root.firstChild;
    closeMenus();
    if (!willOpen) return;
    var menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'menu');
    build(menu);
    var r = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = Math.min(window.innerHeight - 260, r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
    menu.style.zIndex = '600';
    root.appendChild(menu);
    anchor.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('mousedown', function outside(e) {
        if (!menu.contains(e.target)) {
          closeMenus();
          document.removeEventListener('mousedown', outside);
        }
      });
    }, 0);
  }

  function menuButton(menu, label, icon, fn, danger) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dropdown-item' + (danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.innerHTML = (icon ? '<svg aria-hidden="true"><use href="#' + icon + '"/></svg>' : '') + '<span>' + Ui.esc(label) + '</span>';
    b.onclick = function () { closeMenus(); fn && fn(); };
    menu.appendChild(b);
    return b;
  }

  function toggleMenu(anchor) {
    openMenu(anchor, function (menu) {
      var u = (window.TrycordState && TrycordState.user) || {};
      var head = document.createElement('div');
      head.className = 'dropdown-header';
      head.textContent = (u.displayName || u.username || '') + '  @' + (u.username || '');
      menu.appendChild(head);
      menuButton(menu, 'View profile', 'i-users', openProfileModal);
      menuButton(menu, 'Settings', 'i-cog', function () { location.hash = '#/settings'; });
      menuButton(menu, 'Log out', 'i-out', function () { window.Trycord.logout(); }, true);
    });
  }

  function toggleBell(anchor) {
    openMenu(anchor, function (menu) {
      menu.classList.add('menu-wide');
      var items = (window.TrycordState && TrycordState.notifications.items) || [];
      var unread = items.filter((n) => !n.readAt).slice(0, 6);
      if (!unread.length) {
        var empty = document.createElement('div');
        empty.className = 'menu-empty';
        empty.textContent = "You're all caught up.";
        menu.appendChild(empty);
      } else {
        unread.forEach(function (n) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'dropdown-item';
          var who = (n.actor && (n.actor.displayName || n.actor.username)) || 'Trycord';
          var what = n.type === 'dm' ? 'sent you a message'
            : n.type === 'friend_request' ? 'sent you a friend request'
            : n.type === 'friend_accepted' ? 'accepted your friend request'
            : 'mentioned you';
          b.innerHTML = Ui.avatarHtml(who, 'avatar-sm') +
            '<span><b>' + Ui.esc(who) + '</b> ' + Ui.esc(what) + '<br><small class="text-muted">' + Ui.esc(Ui.timeAgo(n.createdAt)) + '</small></span>';
          b.onclick = function () {
            closeMenus();
            TrycordApi.notifRead(n.id).catch(() => {});
            location.hash = n.type === 'dm' && n.referenceId ? '#/dm/' + encodeURIComponent(n.referenceId) : '#/dm';
          };
          menu.appendChild(b);
        });
      }
      menuButton(menu, 'View all notifications', 'i-bell', function () { location.hash = '#/dm'; });
    });
    TrycordApi.notifications(10).then(function (d) {
      TrycordState.setNotifications(d.items, d.unreadCount);
      renderBell();
    }).catch(() => {});
  }

  // Cross-cutting realtime signals. Pages call this for events they don't
  // own so badges and lists stay correct without refetching everything.
  function handleSignal(ev, current) {
    if (!ev || !ev.type || !window.TrycordState) return;
    current = current || {};
    if (ev.type === 'notification' && ev.notification) {
      var st = TrycordState.notifications;
      if (!st.items.some((n) => n.id === ev.notification.id)) {
        st.items.unshift(ev.notification);
        st.unreadCount += 1;
      }
      renderBell();
      Ui.toast(describeNotification(ev.notification), 'info');
    } else if (ev.type === 'dm:message' && ev.conversationId) {
      if (String(current.dmId || '') === String(ev.conversationId)) return; // owner page handles it
      var c = TrycordState.dmById(ev.conversationId);
      if (c) {
        TrycordState.touchDM(ev.conversationId, {
          lastMessage: { id: ev.id, content: ev.content, createdAt: ev.createdAt, authorId: ev.authorId, authorName: ev.authorName },
          unreadCount: (c.unreadCount || 0) + (String(ev.authorId) === String(TrycordState.user.id) ? 0 : 1),
          updatedAt: ev.createdAt,
        });
      } else {
        refreshDMList();
      }
      renderRailBadges();
    } else if (ev.type === 'dm:read' && ev.conversationId) {
      if (String(current.dmId || '') !== String(ev.conversationId)) {
        var c2 = TrycordState.dmById(ev.conversationId);
        if (c2) c2.unreadCount = 0;
        renderRailBadges();
      }
    } else if (ev.type === 'dm:message_deleted' && ev.conversationId) {
      if (String(current.dmId || '') !== String(ev.conversationId)) refreshDMList();
    } else if (ev.type === 'presence' && ev.userId) {
      document.querySelectorAll('[data-presence-for="' + ev.userId + '"]').forEach(function (el) {
        el.classList.toggle('online', ev.presence === 'online');
      });
    }
  }

  function describeNotification(n) {
    var who = (n.actor && (n.actor.displayName || n.actor.username)) || 'Trycord';
    if (n.type === 'dm') return who + ' sent you a message';
    if (n.type === 'friend_request') return who + ' sent you a friend request';
    if (n.type === 'friend_accepted') return who + ' accepted your friend request';
    return 'New notification from ' + who;
  }

  function refreshDMList() {
    if (!window.TrycordState || !TrycordState.user) return Promise.resolve();
    return TrycordApi.dms().then(function (list) {
      TrycordState.setDMs(list);
      renderRailBadges();
    }).catch(() => {});
  }

  function refreshFriends() {
    if (!window.TrycordState || !TrycordState.user) return Promise.resolve();
    return Promise.all([
      TrycordApi.friends().then((f) => TrycordState.setFriends(f)).catch(() => {}),
      TrycordApi.friendRequests().then((r) => TrycordState.setRequests(r.incoming, r.outgoing)).catch(() => {}),
    ]);
  }

  function refreshNotifications() {
    if (!window.TrycordState || !TrycordState.user) return Promise.resolve();
    return TrycordApi.notifications(30).then(function (d) {
      TrycordState.setNotifications(d.items, d.unreadCount);
      renderBell();
    }).catch(() => {});
  }

  // --- Profile ---

  function openProfileModal(userId) {
    var me = TrycordState.user;
    var target = userId || (me && me.id);
    if (!target) return;
    TrycordApi.userProfile(target).then(function (p) {
      var body = document.createElement('div');
      var rel = p.relation || 'none';
      var actions = '';
      if (rel === 'self') {
        actions = '<a class="btn btn-ghost btn-sm" href="#/settings">Edit profile</a>';
      } else if (rel === 'friend') {
        actions = '<button type="button" class="btn btn-primary btn-sm" data-act="msg">Message</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="unfriend">Remove friend</button>';
      } else if (rel === 'pending-out') {
        actions = '<button type="button" class="btn btn-ghost btn-sm" data-act="msg">Message</button>' +
          '<span class="text-muted text-sm">Request pending</span>';
      } else if (rel === 'pending-in') {
        actions = '<button type="button" class="btn btn-primary btn-sm" data-act="accept">Accept request</button>';
      } else {
        actions = '<button type="button" class="btn btn-primary btn-sm" data-act="msg">Message</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="add">Add friend</button>';
      }
      body.innerHTML =
        '<div style="display:flex;gap:var(--tc-space-4);align-items:center;margin-bottom:var(--tc-space-3);">' +
        Ui.avatarHtml(p.displayName || p.username, 'avatar-xl') +
        '<div><div style="font-weight:800;font-size:1.15rem;">' + Ui.esc(p.displayName || p.username) + '</div>' +
        '<div class="text-muted text-sm">@' + Ui.esc(p.username) + ' · ' + Ui.esc(p.presence || 'offline') + '</div>' +
        '<div class="text-muted text-sm">Member since ' + Ui.esc(Ui.fullDate(p.createdAt)) + '</div></div></div>' +
        '<div style="display:flex;gap:var(--tc-space-2);flex-wrap:wrap;">' + actions + '</div>';
      Ui.openModal({ title: 'Profile', body: body, actions: [{ id: 'close', label: 'Close', primary: true }] });
      var q = (sel) => body.querySelector('[data-act="' + sel + '"]');
      if (q('msg')) q('msg').onclick = () => {
        document.getElementById('modal-root').innerHTML = '';
        TrycordApi.openDM(p.id).then((c) => { location.hash = '#/dm/' + encodeURIComponent(c.id); })
          .catch((e) => Ui.toast(e.message, 'error'));
      };
      if (q('add')) q('add').onclick = () => {
        TrycordApi.friendRequest(p.id).then(() => {
          Ui.toast('Friend request sent.', 'success');
          document.getElementById('modal-root').innerHTML = '';
          refreshFriends();
        }).catch((e) => Ui.toast(e.message, 'error'));
      };
      if (q('unfriend')) q('unfriend').onclick = async () => {
        var yes = await Ui.confirmDialog({ title: 'Remove friend?', message: 'Remove ' + (p.displayName || p.username) + ' from your friends?', confirmText: 'Remove' });
        if (!yes) return;
        TrycordApi.friendRemove(p.id).then(() => {
          Ui.toast('Friend removed.', 'success');
          document.getElementById('modal-root').innerHTML = '';
          refreshFriends();
        }).catch((e) => Ui.toast(e.message, 'error'));
      };
      if (q('accept')) q('accept').onclick = () => {
        TrycordApi.friendRequests().then((r) => {
          var inc = (r.incoming || []).find((x) => String(x.from.id) === String(p.id));
          if (!inc) throw new Error('Request is gone.');
          return TrycordApi.friendAccept(inc.id);
        }).then(() => {
          Ui.toast('Friend request accepted.', 'success');
          document.getElementById('modal-root').innerHTML = '';
          refreshFriends();
        }).catch((e) => Ui.toast(e.message, 'error'));
      };
    }).catch((e) => Ui.toast(e.message, 'error'));
  }

  // --- User search ---

  function openUserSearch(onPick) {
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="form-group" style="margin-bottom:var(--tc-space-3);"><input type="text" id="us-q" class="form-input" placeholder="Type at least 2 characters…" autocomplete="off" /></div>' +
      '<div id="us-results"><p class="text-muted text-sm">Search by username.</p></div>';
    Ui.openModal({ title: 'Find someone', body: body, actions: [{ id: 'close', label: 'Close', primary: true }] });
    var input = body.querySelector('#us-q');
    var out = body.querySelector('#us-results');
    var timer = null;
    function run() {
      var q = input.value.trim();
      if (q.length < 2) {
        out.innerHTML = '<p class="text-muted text-sm">Search by username.</p>';
        return;
      }
      out.innerHTML = Ui.skeletons(2);
      TrycordApi.userSearch(q).then(function (users) {
        if (!users.length) {
          out.innerHTML = Ui.emptyState({ icon: Ui.icons.empty, title: 'Nothing matched that search.', hint: '' });
          return;
        }
        out.innerHTML = users.map(function (u) {
          var self = TrycordState.user && String(u.id) === String(TrycordState.user.id);
          return '<div class="member-row" data-user="' + Ui.esc(u.id) + '">' +
            presenceAvatar(u.displayName || u.username, '', u.presence) +
            '<span class="who"><span class="name">' + Ui.esc(u.displayName || u.username) + '</span>' +
            '<span class="sub">@' + Ui.esc(u.username) + ' · ' + Ui.esc(u.presence || 'offline') + '</span></span>' +
            (self ? '' : '<button type="button" class="btn btn-primary btn-sm" data-pick>Select</button>') + '</div>';
        }).join('');
        out.querySelectorAll('[data-pick]').forEach(function (b) {
          b.onclick = function () {
            var id = b.closest('[data-user]').dataset.user;
            var picked = users.find((u) => String(u.id) === String(id));
            document.getElementById('modal-root').innerHTML = '';
            if (onPick) onPick(picked);
            else openProfileModal(id);
          };
        });
      }).catch(function (e) {
        out.innerHTML = Ui.errorState(e.message, 'Retry');
        var rb = out.querySelector('[data-retry]');
        if (rb) rb.onclick = run;
      });
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    setTimeout(() => input.focus(), 0);
  }

  function presenceAvatar(name, size, presence) {
    return '<span class="avatar-presence' + (presence === 'online' ? ' online' : '') +
      '" data-presence-for="">' + Ui.avatarHtml(name, size || '') + '</span>';
  }

  // --- Server rows (browse/home lists: rows, not cards) ---

  function favStar(serverId, isFav) {
    return '<button type="button" class="icon-btn fav-btn' + (isFav ? ' on' : '') + '" data-fav="' + Ui.esc(serverId) + '" ' +
      'title="' + (isFav ? 'Remove from favorites' : 'Add to favorites') + '" ' +
      'aria-pressed="' + (isFav ? 'true' : 'false') + '" aria-label="Toggle favorite">' +
      '<svg aria-hidden="true" style="width:1.1rem;height:1.1rem;' + (isFav ? 'fill:var(--tc-warning);stroke:var(--tc-warning);' : '') + '"><use href="#i-star"/></svg></button>';
  }

  function serverRow(s, opts) {
    opts = opts || {};
    var isFav = TrycordState.isFav(s.id);
    var desc = s.description || 'No description yet.';
    return (
      '<article class="server-row" data-server="' + Ui.esc(s.id) + '">' +
      Ui.avatarHtml(s.name, '') +
      '<div class="info"><div class="name">' + Ui.esc(s.name) + '</div>' +
      '<div class="meta"><span>' + (s.member_count || 0) + ' members</span><span>·</span>' +
      '<span>' + (s.channel_count !== undefined ? s.channel_count : '?') + ' channels</span>' +
      (s.is_owner ? '<span>·</span>' + Ui.badge('Owner', 'owner') : '') +
      (s.is_public !== undefined ? (s.is_public ? Ui.badge('Public', 'pub') : Ui.badge('Private', 'priv')) : '') +
      (opts.extra || '') + '</div>' +
      '<div class="desc">' + Ui.esc(desc) + '</div></div>' +
      favStar(s.id, isFav) +
      '<button type="button" class="btn btn-secondary btn-sm" data-open="' + Ui.esc(s.id) + '">Open</button>' +
      '</article>'
    );
  }

  function wireServerRows(root, onFavChange) {
    root.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => { location.hash = '#/server/' + encodeURIComponent(b.dataset.open); };
    });
    root.querySelectorAll('[data-fav]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        var nowFav = TrycordState.toggleFav(b.dataset.fav);
        b.setAttribute('aria-pressed', nowFav ? 'true' : 'false');
        b.classList.toggle('on', nowFav);
        var svg = b.querySelector('svg');
        if (svg) svg.style.cssText = 'width:1.1rem;height:1.1rem;' + (nowFav ? 'fill:var(--tc-warning);stroke:var(--tc-warning);' : '');
        b.title = nowFav ? 'Remove from favorites' : 'Add to favorites';
        if (onFavChange) onFavChange(b.dataset.fav, nowFav);
      };
    });
  }

  function serverMenu(x, y, s) {
    var items = [
      { label: 'Open server', icon: 'i-grid', onClick: () => { location.hash = '#/server/' + encodeURIComponent(s.id); } },
      { label: TrycordState.isFav(s.id) ? 'Remove from favorites' : 'Add to favorites', icon: 'i-star', onClick: () => { Trycord.refreshServers().then(() => window.TrycordRouter.route()); TrycordState.toggleFav(s.id); } },
    ];
    if (s.join_code) {
      items.push({ label: 'Copy invite code', icon: 'i-copy', onClick: () => copyText(s.join_code, 'Invite code copied.') });
    }
    Ui.contextMenu(x, y, items);
  }

  function copyText(text, okMsg) {
    function done() { Ui.toast(okMsg || 'Copied.', 'success'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => Ui.toast('Copy failed.', 'error'));
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { Ui.toast('Copy failed.', 'error'); }
      ta.remove();
    }
  }

  function createServerModal(onCreated) {
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="form-group"><label class="form-label" for="cs-name">Name</label>' +
      '<input type="text" id="cs-name" class="form-input" maxlength="64" placeholder="e.g. Study Group" /></div>' +
      '<div class="form-group"><label class="form-label" for="cs-desc">Description (optional)</label>' +
      '<textarea id="cs-desc" class="form-input form-textarea" maxlength="500" placeholder="What is this server about?" rows="3"></textarea></div>' +
      '<div class="form-check"><input type="checkbox" id="cs-public" class="form-check-input" />' +
      '<label class="form-check-label" for="cs-public">List publicly in Discover</label></div>';
    Ui.openModal({
      title: 'Create a server',
      body,
      actions: [
        { id: 'cancel', label: 'Cancel' },
        {
          id: 'create', label: 'Create server', primary: true,
          onClick: async (close) => {
            var nameEl = document.getElementById('cs-name');
            var name = nameEl.value.trim();
            if (!name) {
              Ui.fieldError(nameEl, 'Give your server a name.');
              nameEl.focus();
              return;
            }
            var btn = document.querySelector('.modal-footer .btn-primary');
            Ui.setLoading(btn, true, 'Creating…');
            try {
              var r = await TrycordApi.createServer({
                name,
                description: document.getElementById('cs-desc').value.trim(),
                isPublic: document.getElementById('cs-public').checked,
              });
              await Trycord.refreshServers();
              close();
              Ui.toast('Server created.', 'success');
              if (onCreated) onCreated(r.serverId);
              else location.hash = '#/server/' + encodeURIComponent(r.serverId);
            } catch (e) {
              Ui.setLoading(btn, false);
              Ui.toast(e.message, 'error');
            }
          },
        },
      ],
    });
    setTimeout(() => { var i = document.getElementById('cs-name'); if (i) i.focus(); }, 0);
  }

  function serverHost() {
    try {
      return new URL(TrycordApi.baseUrl()).host;
    } catch (e) {
      return TrycordApi.baseUrl();
    }
  }

  function serverSwitcher() {
    return '<p class="text-muted text-sm">Server: <b data-srv-host></b> ' +
      '<button type="button" class="btn btn-ghost btn-sm" data-change-server>Change</button></p>';
  }

  function wireServerSwitcher(root) {
    root.querySelectorAll('[data-srv-host]').forEach((el) => {
      el.textContent = serverHost();
    });
    root.querySelectorAll('[data-change-server]').forEach((b) => {
      b.onclick = () => openServerConfigModal();
    });
  }

  function openServerConfigModal() {
    var current = TrycordApi.baseUrl();
    var source = TrycordApi.baseSource();
    var body = document.createElement('div');
    body.innerHTML =
      '<p class="text-muted text-sm">Currently using <code data-cur></code> (from <span data-src></span>).</p>' +
      '<div class="form-group"><label class="form-label" for="cfg-url">Backend URL</label>' +
      '<input type="url" id="cfg-url" class="form-input" spellcheck="false" autocomplete="off" /></div>' +
      '<div style="display: flex; gap: var(--tc-space-3); align-items: center;"><button type="button" class="btn btn-ghost btn-sm" id="cfg-test">Test connection</button>' +
      '<span id="cfg-status" class="text-sm text-muted" role="status"></span></div>';
    body.querySelector('[data-cur]').textContent = current;
    body.querySelector('[data-src]').textContent = source;
    var input = body.querySelector('#cfg-url');
    input.value = current;
    var status = body.querySelector('#cfg-status');

    body.querySelector('#cfg-test').onclick = async (e) => {
      var btn = e.currentTarget;
      Ui.setLoading(btn, true, 'Testing…');
      status.textContent = '';
      var r = await TrycordApi.testConnection(input.value);
      Ui.setLoading(btn, false);
      if (!r.url) {
        status.innerHTML = '<span class="text-danger">' + Ui.esc(r.message) + '</span>';
      } else if (r.ok) {
        status.innerHTML = '<span class="text-success">Connected to Trycord (' + r.latencyMs + ' ms)</span>';
      } else {
        status.innerHTML = '<span class="text-danger">' + Ui.esc(r.message) + '</span>';
      }
    };

    Ui.openModal({
      title: 'Trycord server',
      body,
      actions: [
        { id: 'cancel', label: 'Cancel' },
        {
          id: 'save', label: 'Save', primary: true,
          onClick: (close) => {
            var url = TrycordApi.normalizeUrl(input.value);
            if (!url) {
              Ui.fieldError(input, 'Use an http(s) URL like http://51.79.44.111:9971');
              input.focus();
              return;
            }
            TrycordState.access.apiBase = url;
            TrycordState.saveAccess();
            close();
            Ui.toast('Backend saved. Reloading…', 'success');
            setTimeout(() => location.reload(), 400);
          },
        },
      ],
    });
    setTimeout(() => input.focus(), 0);
  }

  // Command palette: navigation + servers + DMs + actions.
  function openPalette() {
    var root = document.getElementById('palette-root');
    if (!root) return;
    root.innerHTML = '';
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var box = document.createElement('div');
    box.className = 'palette';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Quick switcher');
    var input = document.createElement('input');
    input.className = 'palette-input';
    input.placeholder = 'Type a command or search…  (Esc to close)';
    input.setAttribute('aria-label', 'Quick switcher');
    var results = document.createElement('div');
    results.className = 'palette-results';
    results.setAttribute('role', 'listbox');
    function close() { root.innerHTML = ''; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    function item(hash, icon, label) {
      return '<div class="palette-item" role="option" data-hash="' + hash + '"><span class="ico"><svg aria-hidden="true" style="width:1.1rem;height:1.1rem;"><use href="#' + icon + '"/></svg></span>' + Ui.esc(label) + '</div>';
    }
    function renderList(q) {
      q = (q || '').toLowerCase();
      var html = '<div class="palette-section"><div class="palette-section-label">Go to</div></div>';
      html += NAV.filter((n) => !q || n.label.toLowerCase().indexOf(q) !== -1)
        .map((n) => item(n.hash, n.icon, n.label)).join('');
      html += item('#/settings', 'i-cog', 'Settings');
      var servers = ((window.TrycordState && TrycordState.servers) || []).filter((s) => !q || String(s.name).toLowerCase().indexOf(q) !== -1).slice(0, 5);
      if (servers.length) {
        html += '<div class="palette-section"><div class="palette-section-label">Servers</div></div>';
        html += servers.map((s) => '<div class="palette-item" role="option" data-server="' + Ui.esc(s.id) + '"><span class="ico">' + Ui.avatarHtml(s.name, 'avatar-sm') + '</span>' + Ui.esc(s.name) + '</div>').join('');
      }
      var dms = ((window.TrycordState && TrycordState.dms) || []).filter((d) => d.peer && (!q || String(d.peer.displayName || d.peer.username).toLowerCase().indexOf(q) !== -1)).slice(0, 5);
      if (dms.length) {
        html += '<div class="palette-section"><div class="palette-section-label">Direct messages</div></div>';
        html += dms.map((d) => '<div class="palette-item" role="option" data-dm="' + Ui.esc(d.id) + '"><span class="ico">' + Ui.avatarHtml(d.peer.displayName || d.peer.username, 'avatar-sm') + '</span>' + Ui.esc(d.peer.displayName || d.peer.username) + '</div>').join('');
      }
      results.innerHTML = html || '<div class="palette-item">No results</div>';
      results.querySelectorAll('[data-hash]').forEach((el) => {
        el.onclick = () => { close(); location.hash = el.dataset.hash; };
      });
      results.querySelectorAll('[data-server]').forEach((el) => {
        el.onclick = () => { close(); location.hash = '#/server/' + encodeURIComponent(el.dataset.server); };
      });
      results.querySelectorAll('[data-dm]').forEach((el) => {
        el.onclick = () => { close(); location.hash = '#/dm/' + encodeURIComponent(el.dataset.dm); };
      });
    }
    input.addEventListener('input', () => renderList(input.value));
    box.append(input, results);
    overlay.appendChild(box);
    root.appendChild(overlay);
    renderList('');
    setTimeout(() => input.focus(), 0);
  }

  // Shared message renderer with grouping + hover actions.
  // opts: { grouped(bool, hide avatar+head), canDelete, onDelete(id),
  //         showRead(bool, peerReadAt, isMine), timeFull }
  function renderMessage(m, opts) {
    opts = opts || {};
    var grouped = !!opts.grouped;
    var time = Ui.timeAgo(m.createdAt);
    var full = '';
    try { full = new Date(m.createdAt).toLocaleString(); } catch (e) { full = time; }
    var seen = opts.showRead && opts.isMine && opts.peerReadAt && String(opts.peerReadAt) >= String(m.createdAt)
      ? '<div class="seen"><svg aria-hidden="true" style="width:.8rem;height:.8rem;vertical-align:-1px;"><use href="#i-checks"/></svg> Seen</div>'
      : '';
    return (
      '<li class="msg' + (grouped ? ' cont' : '') + '" data-mid="' + Ui.esc(m.id) + '">' +
      '<span class="gutter">' +
      (grouped
        ? '<span class="tick" title="' + Ui.esc(full) + '">' + Ui.esc(shortTime(m.createdAt)) + '</span>'
        : Ui.avatarHtml(m.authorName || '?', '')) +
      '</span>' +
      '<div class="body">' +
      (grouped ? '' :
        '<div class="head"><span class="author">' + Ui.esc(m.authorName || '?') + '</span>' +
        '<time class="time" title="' + Ui.esc(full) + '">' + Ui.esc(time) + '</time></div>') +
      '<div class="text">' + linkify(Ui.esc(m.content)) + '</div>' + seen +
      '</div>' +
      '<div class="msg-actions" role="toolbar" aria-label="Message actions">' +
      '<button type="button" class="icon-btn" data-copy title="Copy text" aria-label="Copy text"><svg aria-hidden="true"><use href="#i-copy"/></svg></button>' +
      (opts.canDelete ? '<button type="button" class="icon-btn" data-del title="Delete message" aria-label="Delete message"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>' : '') +
      '</div>' +
      '<button type="button" class="msg-touchbtn" data-touch-menu title="Message actions" aria-label="Message actions" aria-haspopup="menu"><svg aria-hidden="true"><use href="#i-dots"/></svg></button></li>'
    );
  }

  function shortTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function linkify(escaped) {
    // escaped is already HTML-escaped; link http(s) spans + @mentions.
    return escaped
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)@([A-Za-z0-9_.]{2,32})/g, '$1<span class="text-accent">@$2</span>');
  }

  function wireMessageList(root, onDelete) {
    Ui.bindLongPress(root, '[data-mid]', function (el, x, y) {
      Ui.fireContextMenu(el, x, y);
    });
    root.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        var li = b.closest('[data-mid]');
        var text = li ? li.querySelector('.text').textContent : '';
        copyText(text, 'Message copied.');
      };
    });
    // Touch path: re-dispatch as contextmenu so touch uses the exact same
    // permission-aware menu as right-click/long-press. One code path.
    root.querySelectorAll('[data-touch-menu]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        var li = b.closest('[data-mid]');
        if (!li) return;
        var r = b.getBoundingClientRect();
        Ui.fireContextMenu(li, r.left, r.bottom + 4);
      };
    });
    if (onDelete) {
      root.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          var li = b.closest('[data-mid]');
          if (li) onDelete(li.dataset.mid);
        };
      });
    }
  }

  // Shared reconnecting socket. Exactly one per page; pages must call the
  // returned cleanup on route change. No duplicate subscriptions.
  function connectSocket(opts) {
    opts = opts || {};
    var ws = null;
    var retries = 0;
    var dead = false;
    var backoff = null;
    function open() {
      if (dead) return;
      try {
        ws = new WebSocket(TrycordApi.wsUrl());
      } catch (e) {
        schedule();
        return;
      }
      ws.onopen = () => {
        retries = 0;
        if (opts.onStatus) opts.onStatus('connected');
        if (opts.onOpen) opts.onOpen(ws);
      };
      ws.onmessage = (e) => {
        var data = null;
        try { data = JSON.parse(e.data); } catch (err) { return; }
        if (opts.onEvent) opts.onEvent(data, ws);
      };
      ws.onclose = () => {
        if (dead) return;
        if (opts.onStatus) opts.onStatus('reconnecting');
        schedule();
      };
      ws.onerror = () => {
        try { ws.close(); } catch (e) { /* handled by onclose */ }
      };
    }
    function schedule() {
      if (dead) return;
      retries += 1;
      var delay = Math.min(1000 * Math.pow(1.6, Math.min(retries, 6)), 15000);
      clearTimeout(backoff);
      backoff = setTimeout(open, delay);
    }
    open();
    return function cleanup() {
      dead = true;
      clearTimeout(backoff);
      try { if (ws) ws.close(); } catch (e) { /* closing */ }
    };
  }

  window.TrycordComponents = {
    NAV,
    renderRail, renderSidebar, renderRailServers, renderRailBadges, renderMobileBar,
    renderServerNav, hideServerNav,
    setTopbar, renderUser, renderBell,
    closeMenus, toggleMenu, toggleBell, openMenu, menuButton,
    handleSignal, refreshDMList, refreshFriends, refreshNotifications,
    openProfileModal, openUserSearch, presenceAvatar,
    serverRow, wireServerRows, favStar, serverMenu, copyText,
    createServerModal, serverSwitcher, wireServerSwitcher, openServerConfigModal,
    openPalette, renderMessage, wireMessageList, connectSocket,
  };
})();
