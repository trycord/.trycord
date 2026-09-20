/* Shared components: rail, topbar chrome, user menu, server cards, DMs, palette, modals. */
(function () {
  var Ui = window.TrycordUi;

  var NAV = [
    { hash: '#/home', label: 'Home', icon: 'i-home' },
    { hash: '#/servers', label: 'Your Servers', icon: 'i-grid' },
    { hash: '#/dm', label: 'Direct Messages', icon: 'i-mail' },
    { hash: '#/discover', label: 'Discover', icon: 'i-search' },
    { hash: '#/activity', label: 'Recent Activity', icon: 'i-activity' },
    { hash: '#/favorites', label: 'Favorites', icon: 'i-star' },
    { hash: '#/join', label: 'Join Server', icon: 'i-plus' },
  ];

  function railActiveFor(hash) {
    if (!hash) return '#/home';
    if (hash.indexOf('#/server/') === 0) return '#/servers';
    if (hash.indexOf('#/dm') === 0) return '#/dm';
    if (hash.indexOf('#/discover') === 0) return '#/discover';
    if (hash.indexOf('#/activity') === 0) return '#/activity';
    if (hash.indexOf('#/favorites') === 0) return '#/favorites';
    if (hash.indexOf('#/servers') === 0) return '#/servers';
    if (hash.indexOf('#/join') === 0) return '#/servers';
    if (hash.indexOf('#/home') === 0) return '#/home';
    return hash;
  }

  function renderRail(active) {
    var want = railActiveFor(active || location.hash);
    document.querySelectorAll('#rail .rail-btn[data-nav]').forEach(function (b) {
      var on = b.getAttribute('data-nav') === want;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    renderRailServers();
    // Mobile bar active state
    document.querySelectorAll('#mobilebar .mnav').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-nav') === want);
    });
  }

  // Back-compat: old pages call renderSidebar.
  function renderSidebar(active) {
    renderRail(active);
  }

  function renderRailServers() {
    var box = document.getElementById('rail-servers');
    if (!box) return;
    var servers = (window.TrycordState && TrycordState.servers) || [];
    if (!servers.length) { box.innerHTML = ''; return; }
    box.innerHTML = servers.slice(0, 20).map(function (s) {
      var active = (location.hash || '').indexOf('#/server/' + encodeURIComponent(s.id)) === 0;
      return '<button type="button" class="rail-srv' + (active ? ' active' : '') + '" data-open="' + Ui.esc(s.id) + '"' +
        ' title="' + Ui.esc(s.name) + '" aria-label="' + Ui.esc(s.name) + '">' +
        Ui.avatarHtml(s.name, '') + '</button>';
    }).join('');
    box.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { location.hash = '#/server/' + encodeURIComponent(b.dataset.open); };
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

  function renderDMList(activeId) {
    // Local DM recents stored in TrycordState.dms (array of {id,name,preview,unread}).
    var dms = (window.TrycordState && TrycordState.dms) || [];
    if (!dms.length) {
      return '<div class="nav-label">Direct Messages</div>' +
        Ui.emptyState({ icon: '✉', title: 'No conversations yet', hint: 'Start a DM from a member profile or server.', actions: '' });
    }
    var html = '<div class="nav-label">Direct Messages</div>';
    dms.forEach(function (d) {
      var on = activeId && String(activeId) === String(d.id);
      html += '<button type="button" class="chan-btn' + (on ? ' active' : '') + '" data-dm="' + Ui.esc(d.id) + '">' +
        Ui.avatarHtml(d.name, 'avatar-sm') +
        '<span class="lbl">' + Ui.esc(d.name) + '</span>' +
        (d.unread ? '<span class="chan-unread" aria-label="Unread"></span>' : '') + '</button>';
    });
    return html;
  }

  function setTopbar(title, subtitle, actionsHtml) {
    var t = document.getElementById('page-title');
    var s = document.getElementById('page-sub');
    if (t) t.textContent = title || '';
    if (s) s.textContent = subtitle || '';
    var right = document.querySelector('.topbar-right');
    if (!right) return;
    var old = document.getElementById('topbar-actions');
    if (old) old.remove();
    if (actionsHtml) {
      var wrap = document.createElement('div');
      wrap.id = 'topbar-actions';
      wrap.className = 'row';
      wrap.innerHTML = actionsHtml;
      right.insertBefore(wrap, right.firstChild);
    }
  }

  function renderUser() {
    var u = (window.TrycordState && TrycordState.user) || null;
    var name = u ? (u.displayName || u.username) : '–';
    var sub = u ? ('@' + u.username) : '–';
    var av = Ui.avatarHtml(name, 'sm');
    var railImg = document.getElementById('rail-avatar-img');
    if (railImg) railImg.innerHTML = Ui.avatarHtml(name, '');
    var accAv = document.getElementById('account-avatar');
    if (accAv) accAv.innerHTML = av;
    var accName = document.getElementById('account-name');
    if (accName) accName.textContent = name;
    var accSub = document.getElementById('account-sub');
    if (accSub) accSub.textContent = sub;
    var ab = document.getElementById('avatar-btn');
    if (ab) {
      ab.innerHTML = av;
      ab.setAttribute('aria-label', 'Account menu for ' + name);
    }
    var bar = document.getElementById('account-bar');
    if (bar) bar.hidden = !u;
  }

  function closeMenus() {
    var root = document.getElementById('menu-root');
    if (root) root.innerHTML = '';
    ['#rail-account', '#avatar-btn'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.setAttribute('aria-expanded', 'false');
    });
    var pal = document.getElementById('palette-root');
    // palette closed separately via its own handler
  }

  function toggleMenu(anchor) {
    var root = document.getElementById('menu-root');
    if (!root) return;
    var willOpen = !root.firstChild;
    closeMenus();
    if (!willOpen) return;
    var u = (window.TrycordState && TrycordState.user) || null;
    var menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      '<div class="dropdown-header">' + Ui.esc(u ? (u.displayName || u.username) : '') + '</div>' +
      '<button type="button" class="dropdown-item" data-go="#/profile" role="menuitem">Profile</button>' +
      '<button type="button" class="dropdown-item" data-go="#/settings" role="menuitem">Settings</button>' +
      '<button type="button" class="dropdown-item danger" data-logout role="menuitem">Log out</button>';
    var r = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = Math.min(window.innerHeight - 220, r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, (r.right || r.left) - 220) + 'px';
    menu.style.zIndex = '600';
    root.appendChild(menu);
    anchor.setAttribute('aria-expanded', 'true');
    menu.querySelectorAll('[data-go]').forEach(function (b) {
      b.onclick = function () { closeMenus(); location.hash = b.dataset.go; };
    });
    var lo = menu.querySelector('[data-logout]');
    if (lo) lo.onclick = function () { closeMenus(); if (window.Trycord) Trycord.logout(); };
  }

  function openProfileModal() {
    var u = (window.TrycordState && TrycordState.user) || {};
    var body = document.createElement('div');
    body.innerHTML =
      '<div style="display:flex;gap:1rem;align-items:center;margin-bottom:1rem;">' +
      Ui.avatarHtml(u.displayName || u.username || '?', 'avatar-lg') +
      '<div><div style="font-weight:700;font-size:1.1rem;">' + Ui.esc(u.displayName || u.username || '–') + '</div>' +
      '<div class="text-muted text-sm">@' + Ui.esc(u.username || '') + '</div></div></div>' +
      '<p class="text-muted text-sm">Member since ' + Ui.esc(Ui.fullDate(u.created_at)) + '</p>' +
      '<p><a class="btn btn-ghost btn-sm" href="#/profile">Open full profile page</a> ' +
      '<a class="btn btn-ghost btn-sm" href="#/settings">Settings</a></p>';
    Ui.openModal({ title: 'Profile', body: body, actions: [{ id: 'close', label: 'Close', primary: true }] });
  }

  function openSettingsModal() {
    var body = document.createElement('div');
    var theme = document.documentElement.getAttribute('data-theme') || 'dark';
    body.innerHTML =
      '<div class="form-group"><label class="form-label">Theme</label>' +
      '<div style="display:flex;gap:.5rem;">' +
      ['dark', 'light', 'high-contrast'].map(function (t) {
        return '<button type="button" class="btn btn-sm' + (t === theme ? ' btn-primary' : ' btn-ghost') + '" data-theme-pick="' + t + '">' + t + '</button>';
      }).join('') + '</div></div>' +
      '<p><a class="btn btn-ghost btn-sm" href="#/settings">Open full settings page</a></p>';
    Ui.openModal({ title: 'Settings', body: body, actions: [{ id: 'close', label: 'Close', primary: true }] });
    body.querySelectorAll('[data-theme-pick]').forEach(function (b) {
      b.onclick = function () {
        document.documentElement.setAttribute('data-theme', b.dataset.themePick);
        try { localStorage.setItem('trycord-theme', b.dataset.themePick); } catch (e) {}
        Ui.toast('Theme: ' + b.dataset.themePick, 'success');
      };
    });
  }

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
    var results = document.createElement('div');
    results.className = 'palette-results';
    function close() { root.innerHTML = ''; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    function renderList(q) {
      q = (q || '').toLowerCase();
      var items = NAV.filter(function (n) { return !q || n.label.toLowerCase().indexOf(q) !== -1; });
      var servers = ((window.TrycordState && TrycordState.servers) || []).filter(function (s) {
        return !q || String(s.name).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 6);
      var html = '<div class="palette-section"><div class="palette-section-label">Go to</div></div>';
      html += items.map(function (n) {
        return '<div class="palette-item" data-hash="' + n.hash + '"><svg class="ico" aria-hidden="true" style="width:1.1rem;height:1.1rem;"><use href="#' + n.icon + '"/></svg>' + Ui.esc(n.label) + '</div>';
      }).join('');
      if (servers.length) {
        html += '<div class="palette-section"><div class="palette-section-label">Servers</div></div>';
        html += servers.map(function (s) {
          return '<div class="palette-item" data-server="' + Ui.esc(s.id) + '"><svg class="ico" aria-hidden="true" style="width:1.1rem;height:1.1rem;"><use href="#i-grid"/></svg>' + Ui.esc(s.name) + '</div>';
        }).join('');
      }
      results.innerHTML = html || '<div class="palette-item">No results</div>';
      results.querySelectorAll('[data-hash]').forEach(function (el) {
        el.onclick = function () { close(); location.hash = el.dataset.hash; };
      });
      results.querySelectorAll('[data-server]').forEach(function (el) {
        el.onclick = function () { close(); location.hash = '#/server/' + encodeURIComponent(el.dataset.server); };
      });
    }
    input.addEventListener('input', function () { renderList(input.value); });
    box.append(input, results);
    overlay.appendChild(box);
    root.appendChild(overlay);
    renderList('');
    setTimeout(function () { input.focus(); }, 0);
  }

  function favStar(serverId, isFav) {
    return '<button type="button" class="icon-btn fav-btn" data-fav="' + Ui.esc(serverId) + '" ' +
      'title="' + (isFav ? 'Remove from favorites' : 'Add to favorites') + '" ' +
      'aria-pressed="' + (isFav ? 'true' : 'false') + '" aria-label="Toggle favorite">' +
      (isFav ? '★' : '☆') + '</button>';
  }

  function serverCard(s, opts) {
    opts = opts || {};
    var isFav = window.TrycordState ? TrycordState.isFav(s.id) : false;
    var desc = s.description || 'No description.';
    return (
      '<article class="server-card" data-server="' + Ui.esc(s.id) + '">' +
      '<div class="header">' + Ui.avatarHtml(s.name, 'avatar-lg') +
      '<div class="info"><div class="name">' + Ui.esc(s.name) + '</div>' +
      '<div class="meta"><span class="badge badge-dot badge-dot-success">' + (s.member_count || 0) + ' member' + ((s.member_count || 0) === 1 ? '' : 's') + '</span>' +
      '<span class="badge badge-secondary">' + (s.channel_count !== undefined ? s.channel_count : '?') + ' channels</span></div>' +
      '</div>' + favStar(s.id, isFav) + '</div>' +
      '<p class="desc">' + Ui.esc(desc) + '</p>' +
      '<div class="meta">' +
      (s.is_owner ? Ui.badge('Owner', 'owner') : Ui.badge('Member', '')) +
      (s.is_public !== undefined ? (s.is_public ? Ui.badge('Public', 'pub') : Ui.badge('Private', 'priv')) : '') +
      (opts.extra || '') +
      '</div>' +
      '<div class="footer"><span class="text-muted text-sm">Active ' + Ui.timeAgo(s.last_activity_at) + '</span>' +
      '<span class="grow"></span>' +
      '<button type="button" class="btn btn-primary btn-sm" data-open="' + Ui.esc(s.id) + '">Open →</button></div>' +
      '</article>'
    );
  }

  function wireCards(root, onFavChange) {
    root.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { location.hash = '#/server/' + encodeURIComponent(b.dataset.open); };
    });
    root.querySelectorAll('[data-fav]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var nowFav = TrycordState.toggleFav(b.dataset.fav);
        b.setAttribute('aria-pressed', nowFav ? 'true' : 'false');
        b.textContent = nowFav ? '★' : '☆';
        b.title = nowFav ? 'Remove from favorites' : 'Add to favorites';
        if (onFavChange) onFavChange(b.dataset.fav, nowFav);
      };
    });
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
      body: body,
      actions: [
        { id: 'cancel', label: 'Cancel' },
        {
          id: 'create', label: 'Create server', primary: true,
          onClick: function (close) {
            var nameEl = document.getElementById('cs-name');
            var name = nameEl.value.trim();
            if (!name) {
              Ui.fieldError(nameEl, 'Give your server a name.');
              nameEl.focus();
              return;
            }
            var btn = document.querySelector('.modal-footer .btn-primary');
            Ui.setLoading(btn, true, 'Creating…');
            TrycordApi.createServer({
              name: name,
              description: document.getElementById('cs-desc').value.trim(),
              isPublic: document.getElementById('cs-public').checked,
            }).then(function (r) {
              return Trycord.refreshServers().then(function () {
                close();
                Ui.toast('Server created.', 'success');
                if (onCreated) onCreated(r.serverId);
                else location.hash = '#/server/' + encodeURIComponent(r.serverId);
              });
            }).catch(function (e) {
              Ui.setLoading(btn, false);
              Ui.toast(e.message, 'error');
            });
          },
        },
      ],
    });
    setTimeout(function () { var i = document.getElementById('cs-name'); if (i) i.focus(); }, 0);
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
    root.querySelectorAll('[data-srv-host]').forEach(function (el) {
      el.textContent = serverHost();
    });
    root.querySelectorAll('[data-change-server]').forEach(function (b) {
      b.onclick = function () { openServerConfigModal(); };
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

    body.querySelector('#cfg-test').onclick = function (e) {
      var btn = e.currentTarget;
      Ui.setLoading(btn, true, 'Testing…');
      status.textContent = '';
      TrycordApi.testConnection(input.value).then(function (r) {
        Ui.setLoading(btn, false);
        if (!r.url) {
          status.innerHTML = '<span class="text-danger">' + Ui.esc(r.message) + '</span>';
        } else if (r.ok) {
          status.innerHTML = '<span class="text-success">Connected to Trycord (' + r.latencyMs + ' ms)</span>';
        } else {
          status.innerHTML = '<span class="text-danger">' + Ui.esc(r.message) + '</span>';
        }
      });
    };

    Ui.openModal({
      title: 'Trycord server',
      body: body,
      actions: [
        { id: 'cancel', label: 'Cancel' },
        {
          id: 'save', label: 'Save', primary: true,
          onClick: function (close) {
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
            setTimeout(function () { location.reload(); }, 400);
          },
        },
      ],
    });
    setTimeout(function () { input.focus(); }, 0);
  }

  window.TrycordComponents = {
    NAV: NAV, renderSidebar: renderSidebar, renderRail: renderRail,
    renderRailServers: renderRailServers, renderServerNav: renderServerNav, hideServerNav: hideServerNav,
    renderDMList: renderDMList, setTopbar: setTopbar, renderUser: renderUser,
    closeMenus: closeMenus, toggleMenu: toggleMenu,
    openProfileModal: openProfileModal, openSettingsModal: openSettingsModal, openPalette: openPalette,
    serverCard: serverCard, wireCards: wireCards, favStar: favStar, createServerModal: createServerModal,
    serverSwitcher: serverSwitcher, wireServerSwitcher: wireServerSwitcher, openServerConfigModal: openServerConfigModal,
  };
})();
