/* Browse pages: servers browser, discover, join flow, activity, favorites. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  function sortServers(list, mode) {
    var arr = list.slice();
    if (mode === 'members') arr.sort((a, b) => (b.member_count || 0) - (a.member_count || 0));
    else if (mode === 'active') {
      arr.sort((a, b) => String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')));
    } else arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return arr;
  }

  function filterBar(idPrefix) {
    return (
      '<div class="toolbar" role="search">' +
      '<input type="text" id="' + idPrefix + '-q" class="grow" placeholder="Search servers…" aria-label="Search servers" />' +
      '<label class="small muted">Sort <select id="' + idPrefix + '-sort" aria-label="Sort servers">' +
      '<option value="name">Name A–Z</option><option value="members">Most members</option>' +
      '<option value="active">Recently active</option></select></label>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="' + idPrefix + '-view" aria-pressed="false" title="Toggle grid/list">☰ List</button>' +
      '</div><div id="' + idPrefix + '-results"></div>'
    );
  }

  function bindFilter(root, idPrefix, getList, emptyHtml) {
    var q = root.querySelector('#' + idPrefix + '-q');
    var sort = root.querySelector('#' + idPrefix + '-sort');
    var viewBtn = root.querySelector('#' + idPrefix + '-view');
    var out = root.querySelector('#' + idPrefix + '-results');
    var asList = false;
    function render() {
      var term = q.value.trim().toLowerCase();
      var list = getList().filter((s) =>
        !term || String(s.name).toLowerCase().includes(term) ||
        String(s.description || '').toLowerCase().includes(term));
      var sorted = sortServers(list, sort.value);
      if (!sorted.length) {
        out.innerHTML = term
          ? Ui.emptyState({ icon: '⌕', title: 'No matches', hint: 'Try a different search.' })
          : emptyHtml;
        return;
      }
      out.innerHTML = '<div class="grid-cards' + (asList ? ' list' : '') + '">' +
        sorted.map((s) => C.serverCard(s)).join('') + '</div>';
      C.wireCards(out);
    }
    q.addEventListener('input', render);
    sort.addEventListener('change', render);
    viewBtn.onclick = () => {
      asList = !asList;
      viewBtn.textContent = asList ? '▦ Grid' : '☰ List';
      viewBtn.setAttribute('aria-pressed', asList ? 'true' : 'false');
      render();
    };
    render();
    return render;
  }

  // --- your servers ------------------------------------------------------
  function servers(root) {
    C.setTopbar('Your Servers', TrycordState.servers.length + ' server(s) you belong to.',
      '<button type="button" class="btn btn-primary btn-sm" data-top-create>+ New server</button>');
    root.innerHTML = '<section class="section">' + filterBar('srv') + '</section>';
    bindFilter(root, 'srv', () => TrycordState.servers,
      Ui.emptyState({
        icon: '▦', title: 'You haven’t joined any servers',
        hint: 'Create one or join with an invite code.',
        actions: '<button type="button" class="btn btn-primary btn-sm" data-act="create">Create server</button>' +
          '<a class="btn btn-ghost btn-sm" href="#/join">Join server</a>',
      }));
    root.querySelector('#srv-results').addEventListener('click', (e) => {
      if (e.target.closest('[data-act="create"]')) C.createServerModal(() => servers(root));
    });
    var topBtn = document.querySelector('[data-top-create]');
    if (topBtn) topBtn.onclick = () => C.createServerModal(() => servers(root));
  }

  // --- discover ----------------------------------------------------------
  async function discover(root) {
    C.setTopbar('Discover', 'Public servers open to everyone.');
    root.innerHTML = '<section class="section">' + filterBar('dis') + '</section>';
    var out = root.querySelector('#dis-results');
    out.innerHTML = Ui.skeletons(4);
    try {
      var all = await TrycordApi.discover('');
      var rerender = bindFilter(root, 'dis', () => all,
        Ui.emptyState({
          icon: '◌', title: 'No public servers yet',
          hint: 'Server owners can list their server here from Server → Settings → Visibility.',
          actions: '<a class="btn btn-ghost btn-sm" href="#/servers">Your servers</a>',
        }));
      // live server-side search on typing (debounced)
      var q = root.querySelector('#dis-q');
      var t = null;
      q.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          try { all = await TrycordApi.discover(q.value.trim()); rerender(); } catch (e) { /* keep old */ }
        }, 350);
      });
    } catch (e) {
      out.innerHTML = Ui.errorState(e.message);
      var rb = out.querySelector('[data-retry]');
      if (rb) rb.onclick = () => discover(root);
    }
  }

  // --- join --------------------------------------------------------------
  function join(root, presetCode) {
    C.setTopbar('Join a Server', 'Enter an invite code to join.');
    root.innerHTML =
      '<div class="join-wrap stack"><section class="settings-card">' +
      '<h2>Enter a Trycord invite code</h2>' +
      '<form id="join-form" novalidate><label class="field"><span>Invite code</span>' +
      '<input type="text" id="join-code" class="code-input" placeholder="e.g. lobby" autocomplete="off" spellcheck="false" /></label>' +
      '<button class="btn btn-primary btn-block" type="submit" id="join-lookup">Look up server</button></form>' +
      '<div id="join-result" style="margin-top:1rem"></div>' +
      '<hr class="divider" /><p class="muted small">Don’t have a code? <a href="#/discover">Browse Discover</a> for public servers.</p>' +
      '</section></div>';

    var codeInput = document.getElementById('join-code');
    if (presetCode) codeInput.value = presetCode;

    document.getElementById('join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var code = codeInput.value.trim().toLowerCase();
      if (!Ui.fieldError(codeInput, code ? '' : 'Enter an invite code.')) return;
      var btn = document.getElementById('join-lookup');
      var box = document.getElementById('join-result');
      Ui.setLoading(btn, true, 'Looking up…');
      box.innerHTML = '';
      try {
        var srv = await TrycordApi.previewByCode(code);
        Ui.setLoading(btn, false);
        var already = TrycordState.serverById(srv.id);
        box.innerHTML =
          '<div class="server-card"><div class="head">' + Ui.avatarHtml(srv.name) +
          '<div class="titles"><h3>' + Ui.esc(srv.name) + '</h3>' +
          '<div class="meta"><span>' + srv.member_count + ' member' + (srv.member_count === 1 ? '' : 's') + '</span></div>' +
          '</div></div>' +
          '<p class="desc">' + Ui.esc(srv.description || 'No description.') + '</p>' +
          '<div class="foot"><button type="button" class="btn btn-primary" id="do-join">' +
          (already ? 'Open server' : 'Join server') + '</button></div></div>';
        document.getElementById('do-join').onclick = async (ev) => {
          var jb = ev.currentTarget;
          if (already) {
            location.hash = '#/server/' + encodeURIComponent(srv.id);
            return;
          }
          Ui.setLoading(jb, true, 'Joining…');
          try {
            var r = await TrycordApi.joinByCode(code);
            await Trycord.refreshServers();
            Ui.setLoading(jb, false);
            Ui.toast('Joined ' + (r.name || srv.name) + '.', 'good');
            location.hash = '#/server/' + encodeURIComponent(r.serverId);
          } catch (err) {
            Ui.setLoading(jb, false);
            Ui.toast(err.message, 'bad');
          }
        };
      } catch (err) {
        Ui.setLoading(btn, false);
        box.innerHTML = '<div class="state" role="alert"><div class="glyph" aria-hidden="true">⌕</div>' +
          '<h3>Code not found</h3><p>' + Ui.esc(err.message) +
          ' Check the code and try again, or browse Discover.</p></div>';
      }
    });
  }

  // --- activity ----------------------------------------------------------
  async function activity(root) {
    C.setTopbar('Recent Activity', 'Latest messages across your servers.');
    root.innerHTML = '<div id="act-list">' + Ui.skeletons(5) + '</div>';
    var box = document.getElementById('act-list');
    try {
      var acts = await TrycordApi.activity(30);
      if (!acts.length) {
        box.innerHTML = Ui.emptyState({
          icon: '◷', title: 'Nothing yet',
          hint: 'When people post in your servers, the latest messages land here.',
        });
        return;
      }
      box.innerHTML = '<div class="activity-list">' +
        acts.map(TrycordPagesHome.activityItem).join('') + '</div>';
      box.querySelectorAll('[data-goto-server]').forEach((b) => {
        b.onclick = () => {
          location.hash = '#/server/' + encodeURIComponent(b.dataset.gotoServer) +
            '/chat/' + encodeURIComponent(b.dataset.gotoChannel);
        };
      });
    } catch (e) {
      box.innerHTML = Ui.errorState(e.message);
      var rb = box.querySelector('[data-retry]');
      if (rb) rb.onclick = () => activity(root);
    }
  }

  // --- favorites ---------------------------------------------------------
  function favorites(root) {
    C.setTopbar('Favorites', 'Servers you starred for quick access.');
    var favs = TrycordState.servers.filter((s) => TrycordState.isFav(s.id));
    root.innerHTML = '<section class="section"><div id="fav-list"></div></section>';
    var box = document.getElementById('fav-list');
    if (!favs.length) {
      box.innerHTML = Ui.emptyState({
        icon: '☆', title: 'No favorites yet',
        hint: 'Star any server with ☆ to pin it here.',
        actions: '<a class="btn btn-ghost btn-sm" href="#/servers">Browse your servers</a>',
      });
      return;
    }
    box.innerHTML = '<div class="grid-cards">' + favs.map((s) => C.serverCard(s)).join('') + '</div>';
    C.wireCards(box, () => favorites(root));
  }

  window.TrycordPagesBrowse = { servers, discover, join, activity, favorites };
})();
