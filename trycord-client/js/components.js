/* Shared components: sidebar, topbar chrome, user menu, server cards, create-server modal. */
(function () {
  var Ui = window.TrycordUi;

  var NAV = [
    { hash: '#/home', label: 'Home', icon: '⌂' },
    { hash: '#/servers', label: 'Your Servers', icon: '▦' },
    { hash: '#/discover', label: 'Discover', icon: '◌' },
    { hash: '#/activity', label: 'Recent Activity', icon: '◷' },
    { hash: '#/favorites', label: 'Favorites', icon: '☆' },
    { hash: '#/join', label: 'Join Server', icon: '＋' },
  ];

  function renderSidebar(active) {
    var nav = document.getElementById('sidebar-nav');
    var html = '<div class="nav-label">Menu</div>';
    NAV.forEach((item) => {
      var isActive = active === item.hash ||
        (item.hash === '#/servers' && active.indexOf('#/server/') === 0);
      html += '<a class="nav-item' + (isActive ? ' active' : '') + '" href="' + item.hash + '"' +
        (isActive ? ' aria-current="page"' : '') + '>' +
        '<span class="ico" aria-hidden="true">' + item.icon + '</span>' + Ui.esc(item.label);
      if (item.hash === '#/servers') {
        html += '<span class="count">' + TrycordState.servers.length + '</span>';
      }
      html += '</a>';
    });
    html += '<div class="nav-label">Personal</div>' +
      '<a class="nav-item' + (active === '#/profile' ? ' active' : '') + '" href="#/profile">' +
      '<span class="ico" aria-hidden="true">☺</span>Profile</a>' +
      '<a class="nav-item' + (active === '#/settings' ? ' active' : '') + '" href="#/settings">' +
      '<span class="ico" aria-hidden="true">⚙</span>Settings</a>';
    nav.innerHTML = html;
  }

  function setTopbar(title, subtitle, actionsHtml) {
    document.getElementById('page-title').textContent = title || '';
    document.getElementById('page-sub').textContent = subtitle || '';
    var right = document.querySelector('.topbar-right');
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
    var u = TrycordState.user;
    var name = u ? (u.displayName || u.username) : '–';
    document.getElementById('user-chip-name').textContent = name;
    document.getElementById('user-chip-avatar').innerHTML = Ui.avatarHtml(name, 'sm');
    var ab = document.getElementById('avatar-btn');
    ab.innerHTML = Ui.avatarHtml(name, 'sm round');
    ab.setAttribute('aria-label', 'Account menu for ' + name);
  }

  function closeMenus() {
    document.getElementById('user-menu').hidden = true;
    document.getElementById('user-chip-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('avatar-btn').setAttribute('aria-expanded', 'false');
  }

  function toggleMenu(anchor) {
    var menu = document.getElementById('user-menu');
    var willOpen = menu.hidden;
    closeMenus();
    if (!willOpen) return;
    var u = TrycordState.user;
    menu.innerHTML =
      '<div class="menu-head"><strong>' + Ui.esc(u ? (u.displayName || u.username) : '') + '</strong><br>' +
      '<small class="muted">@' + Ui.esc(u ? u.username : '') + '</small></div>' +
      '<button type="button" data-go="#/profile" role="menuitem"><span aria-hidden="true">☺</span>Profile</button>' +
      '<button type="button" data-go="#/settings" role="menuitem"><span aria-hidden="true">⚙</span>Settings</button>' +
      '<button type="button" data-logout role="menuitem" class="danger"><span aria-hidden="true">⏻</span>Log out</button>';
    var r = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = Math.min(window.innerHeight - 200, r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, r.right - 200) + 'px';
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    menu.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => { closeMenus(); location.hash = b.dataset.go; };
    });
    menu.querySelector('[data-logout]').onclick = () => {
      closeMenus();
      Trycord.logout();
    };
  }

  function favStar(serverId, isFav) {
    return '<button type="button" class="icon-btn fav-btn" data-fav="' + Ui.esc(serverId) + '" ' +
      'title="' + (isFav ? 'Remove from favorites' : 'Add to favorites') + '" ' +
      'aria-pressed="' + (isFav ? 'true' : 'false') + '" aria-label="Toggle favorite">' +
      (isFav ? '★' : '☆') + '</button>';
  }

  function serverCard(s, opts) {
    opts = opts || {};
    var isFav = TrycordState.isFav(s.id);
    var desc = s.description || 'No description.';
    return (
      '<article class="server-card" data-server="' + Ui.esc(s.id) + '">' +
      '<div class="head">' + Ui.avatarHtml(s.name) +
      '<div class="titles"><h3>' + Ui.esc(s.name) + '</h3>' +
      '<div class="meta"><span>' + (s.member_count || 0) + ' member' + ((s.member_count || 0) === 1 ? '' : 's') + '</span>' +
      '<span aria-hidden="true">·</span><span>' + (s.channel_count !== undefined ? s.channel_count : '?') + ' channels</span></div>' +
      '</div>' + favStar(s.id, isFav) + '</div>' +
      '<p class="desc">' + Ui.esc(desc) + '</p>' +
      '<div class="meta">' +
      (s.is_owner ? Ui.badge('Owner', 'owner') : Ui.badge('Member', '')) +
      (s.is_public !== undefined ? (s.is_public ? Ui.badge('Public', 'pub') : Ui.badge('Private', 'priv')) : '') +
      (opts.extra || '') +
      '</div>' +
      '<div class="foot"><span class="muted small">Active ' + Ui.timeAgo(s.last_activity_at) + '</span>' +
      '<span class="grow"></span>' +
      '<button type="button" class="btn btn-sm" data-open="' + Ui.esc(s.id) + '">Open →</button></div>' +
      '</article>'
    );
  }

  // Wire [data-open] (navigate) and [data-fav] (toggle + rerender) inside a container.
  function wireCards(root, onFavChange) {
    root.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => { location.hash = '#/server/' + encodeURIComponent(b.dataset.open); };
    });
    root.querySelectorAll('[data-fav]').forEach((b) => {
      b.onclick = (e) => {
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
      '<label class="field"><span>Name</span><input type="text" id="cs-name" maxlength="64" placeholder="e.g. Study Group" /></label>' +
      '<label class="field"><span>Description (optional)</span><textarea id="cs-desc" maxlength="500" placeholder="What is this server about?"></textarea></label>' +
      '<label class="switch"><input type="checkbox" id="cs-public" /><span class="track" aria-hidden="true"></span>List publicly in Discover</label>';
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
            var btn = document.querySelector('.modal-foot .btn-primary');
            Ui.setLoading(btn, true, 'Creating…');
            try {
              var r = await TrycordApi.createServer({
                name,
                description: document.getElementById('cs-desc').value.trim(),
                isPublic: document.getElementById('cs-public').checked,
              });
              await Trycord.refreshServers();
              close();
              Ui.toast('Server created.', 'good');
              if (onCreated) onCreated(r.serverId);
              else location.hash = '#/server/' + encodeURIComponent(r.serverId);
            } catch (e) {
              Ui.setLoading(btn, false);
              Ui.toast(e.message, 'bad');
            }
          },
        },
      ],
    });
    setTimeout(() => { var i = document.getElementById('cs-name'); if (i) i.focus(); }, 0);
  }

  window.TrycordComponents = {
    NAV, renderSidebar, setTopbar, renderUser, closeMenus, toggleMenu,
    serverCard, wireCards, favStar, createServerModal,
  };
})();
