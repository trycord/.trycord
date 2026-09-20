/* Browse pages: servers, public discover + preview, join flow,
   activity, favorites. Lists are rows, not card grids. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  var INVITE_ERRORS = {
    INVITE_EXPIRED: 'That invite has expired.',
    INVITE_EXHAUSTED: 'That invite has no uses left.',
    INVITE_REVOKED: 'That invite was revoked.',
    INVITE_INVALID: 'Invite not found.',
    ALREADY_MEMBER: 'You are already a member.',
    SERVER_PRIVATE: 'This server is private — you need an invite.',
  };

  function sortServers(list, mode) {
    var arr = list.slice();
    if (mode === 'members') arr.sort((a, b) => (b.member_count || 0) - (a.member_count || 0));
    else if (mode === 'active') {
      arr.sort((a, b) => String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')));
    } else arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return arr;
  }

  function filterBar(idPrefix, placeholder) {
    return (
      '<div class="toolbar" role="search">' +
      '<input type="text" id="' + idPrefix + '-q" class="form-input" style="flex:1;min-width:12rem;" placeholder="' + Ui.esc(placeholder || 'Search servers…') + '" aria-label="Search servers" />' +
      '<label class="text-sm text-muted">Sort <select id="' + idPrefix + '-sort" class="form-input" style="width:auto;" aria-label="Sort servers">' +
      '<option value="name">Name A–Z</option><option value="members">Most members</option>' +
      '<option value="active">Recently active</option></select></label>' +
      '</div><div id="' + idPrefix + '-results"></div>'
    );
  }

  function bindFilter(root, idPrefix, getList, emptyHtml) {
    var q = root.querySelector('#' + idPrefix + '-q');
    var sort = root.querySelector('#' + idPrefix + '-sort');
    var out = root.querySelector('#' + idPrefix + '-results');
    function render() {
      var term = q.value.trim().toLowerCase();
      var list = getList().filter((s) =>
        !term || String(s.name).toLowerCase().includes(term) ||
        String(s.description || '').toLowerCase().includes(term));
      var sorted = sortServers(list, sort.value);
      if (!sorted.length) {
        out.innerHTML = term
          ? Ui.emptyState({ icon: '○', title: 'Nothing matched that search.', hint: 'Try a different search.' })
          : emptyHtml;
        return;
      }
      out.innerHTML = sorted.map((s) => C.serverRow(s)).join('');
      C.wireServerRows(out);
    }
    q.addEventListener('input', render);
    sort.addEventListener('change', render);
    render();
    return render;
  }

  // --- your servers ------------------------------------------------------
  function servers(root) {
    C.setTopbar('Servers', TrycordState.servers.length + ' you belong to.',
      '<button type="button" class="btn btn-primary btn-sm" data-top-create>New server</button>', 'i-grid');
    root.innerHTML = filterBar('srv');
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

  // --- discover (public index, paginated, no membership required) --------
  function publicRow(s) {
    var member = TrycordState.serverById(s.id);
    return (
      '<article class="server-row">' +
      Ui.avatarHtml(s.name, '') +
      '<div class="info"><div class="name">' + Ui.esc(s.name) + '</div>' +
      '<div class="meta"><span>' + s.member_count + ' member' + (s.member_count === 1 ? '' : 's') + '</span><span>·</span>' +
      '<span>' + s.channel_count + ' channels</span></div>' +
      '<div class="desc">' + Ui.esc(s.description || 'No description yet.') + '</div></div>' +
      (member
        ? '<a class="btn btn-ghost btn-sm" href="#/server/' + Ui.esc(s.id) + '">Open</a>'
        : '<a class="btn btn-secondary btn-sm" href="#/discover/' + Ui.esc(s.id) + '">Preview</a>' +
          '<button type="button" class="btn btn-primary btn-sm" data-quick-join="' + Ui.esc(s.id) + '">Join</button>') +
      '</article>'
    );
  }

  async function discover(root) {
    C.setTopbar('Discover', 'Public servers — preview without joining.', '', 'i-globe');
    root.innerHTML =
      '<div class="toolbar" role="search">' +
      '<input type="text" id="dis-q" class="form-input" style="flex:1;min-width:12rem;" placeholder="Search public servers…" aria-label="Search public servers" />' +
      '</div><div id="dis-results"></div>' +
      '<div class="row" style="justify-content:center;margin-top:1rem"><button type="button" class="btn btn-ghost" id="dis-more" hidden>Load more</button></div>';

    var out = root.querySelector('#dis-results');
    var moreBtn = root.querySelector('#dis-more');
    var q = root.querySelector('#dis-q');
    var items = [];
    var page = 1;
    var pages = 1;
    var loading = false;
    var t = null;

    function paint(append) {
      if (!items.length) {
        out.innerHTML = Ui.emptyState({
          icon: '○', title: 'No public servers found',
          hint: q.value.trim()
            ? 'Try a different search.'
            : 'Server owners can list their server from Server → Settings → Visibility.',
        });
      } else {
        if (append) {
          var tmp = document.createElement('div');
          tmp.innerHTML = items.slice(out.querySelectorAll('.server-row').length).map(publicRow).join('');
          while (tmp.firstChild) out.appendChild(tmp.firstChild);
          wireJoins(out);
        } else {
          out.innerHTML = items.map(publicRow).join('');
          wireJoins(out);
        }
      }
      moreBtn.hidden = page >= pages;
    }

    function wireJoins(scope) {
      scope.querySelectorAll('[data-quick-join]').forEach((b) => {
        b.onclick = () => quickJoin(b.dataset.quickJoin, b);
      });
    }

    async function load(reset) {
      if (loading) return;
      loading = true;
      if (reset) { page = 1; items = []; out.innerHTML = Ui.skeletons(4); }
      try {
        var r = await TrycordApi.discover(q.value.trim(), page, 12);
        pages = r.pages;
        items = reset ? r.items : items.concat(r.items);
        paint(!reset);
      } catch (e) {
        if (reset) {
          out.innerHTML = Ui.errorState(e.message);
          var rb = out.querySelector('[data-retry]');
          if (rb) rb.onclick = () => load(true);
        } else Ui.toast(e.message, 'error');
      }
      loading = false;
    }

    async function quickJoin(serverId, btn) {
      Ui.setLoading(btn, true, 'Joining…');
      try {
        var r = await TrycordApi.joinPublic(serverId);
        await Trycord.refreshServers();
        Ui.setLoading(btn, false);
        Ui.toast('Joined server.', 'success');
        location.hash = '#/server/' + encodeURIComponent(r.serverId || serverId);
      } catch (e) {
        Ui.setLoading(btn, false);
        Ui.toast(INVITE_ERRORS[e.code] || e.message, 'error');
      }
    }

    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(true), 350); });
    moreBtn.onclick = () => { page++; load(false); };
    load(true);
  }

  // --- public preview (no membership required) ---------------------------
  async function preview(root, serverId) {
    C.setTopbar('Server preview', 'Public information — no membership needed.', '', 'i-globe');
    root.innerHTML = '<div id="prev-body">' + Ui.skeletons(3) + '</div>';
    var body = document.getElementById('prev-body');
    try {
      var p = await TrycordApi.discoverPreview(serverId);
    } catch (e) {
      body.innerHTML = Ui.emptyState({
        icon: '○', title: 'Server unavailable',
        hint: 'It may be private, unlisted, or deleted.',
        actions: '<a class="btn btn-ghost btn-sm" href="#/discover">Back to Discover</a>',
      });
      return;
    }
    var member = TrycordState.serverById(p.id);
    body.innerHTML =
      '<div style="display:flex;gap:var(--tc-space-4);align-items:center;margin-bottom:var(--tc-space-5);flex-wrap:wrap;">' +
      Ui.avatarHtml(p.name, 'avatar-lg') +
      '<div style="flex:1;min-width:12rem;"><h2 class="tc-h1">' + Ui.esc(p.name) + '</h2>' +
      '<p class="tc-body" style="margin:var(--tc-space-1) 0 0;">' + Ui.esc(p.description || 'No description yet.') + '</p></div>' +
      (member
        ? '<a class="btn btn-primary" href="#/server/' + Ui.esc(p.id) + '">Open server</a>'
        : '<button type="button" class="btn btn-primary" id="prev-join">Join server</button>') +
      '</div>' +
      '<div class="tc-cluster" style="margin-bottom:var(--tc-space-6);">' +
      '<div class="stat" style="flex:1;min-width:8rem;"><div class="num">' + p.member_count + '</div><div class="lbl">Members</div></div>' +
      '<div class="stat" style="flex:1;min-width:8rem;"><div class="num">' + p.channel_count + '</div><div class="lbl">Channels</div></div>' +
      '<div class="stat" style="flex:1;min-width:8rem;"><div class="num">' + Ui.timeAgo(p.created_at) + '</div><div class="lbl">Created</div></div>' +
      '</div>' +
      '<h2 class="tc-h2" style="margin-bottom:var(--tc-space-2);">Channels</h2>' +
      (p.channels.length
        ? p.channels.map((c) =>
          '<div class="chan"><span class="chan-btn" style="cursor:default;"><svg aria-hidden="true"><use href="#i-hash"/></svg>' +
          '<span class="lbl">' + Ui.esc(c.name) + '</span>' +
          '<span class="text-muted text-sm">' + Ui.esc(c.topic || '') + '</span></span></div>').join('')
        : '<p class="text-muted">No channels listed.</p>');

    var joinBtn = document.getElementById('prev-join');
    if (joinBtn) {
      joinBtn.onclick = async () => {
        Ui.setLoading(joinBtn, true, 'Joining…');
        try {
          var r = await TrycordApi.joinPublic(p.id);
          await Trycord.refreshServers();
          Ui.toast('Joined ' + p.name + '.', 'success');
          location.hash = '#/server/' + encodeURIComponent(r.serverId || p.id);
        } catch (e) {
          Ui.setLoading(joinBtn, false);
          if (e.code === 'ALREADY_MEMBER') {
            await Trycord.refreshServers();
            location.hash = '#/server/' + encodeURIComponent(p.id);
          } else Ui.toast(INVITE_ERRORS[e.code] || e.message, 'error');
        }
      };
    }
  }

  // --- join (invites first, legacy codes as fallback) ---------------------
  function join(root) {
    C.setTopbar('Join a server', 'Enter an invite code.', '', 'i-plus');
    root.innerHTML =
      '<div style="max-width:28rem;margin:var(--tc-space-8) auto 0;">' +
      '<h2 class="tc-h1" style="margin-bottom:var(--tc-space-1);">Join a server</h2>' +
      '<p class="tc-body" style="margin-bottom:var(--tc-space-5);">Enter the invite code someone shared with you.</p>' +
      '<form id="join-form" novalidate><div class="form-group"><label class="form-label" for="join-code">Invite or join code</label>' +
      '<input type="text" id="join-code" class="form-input" placeholder="e.g. AB12CD34" autocomplete="off" spellcheck="false" /></div>' +
      '<button class="btn btn-primary btn-block" type="submit" id="join-lookup">Look up</button></form>' +
      '<div id="join-result" style="margin-top:var(--tc-space-4);"></div>' +
      '<p class="text-muted text-sm" style="margin-top:var(--tc-space-5);text-align:center;">No code? <a href="#/discover">Browse Discover</a> for public servers.</p></div>';

    var codeInput = document.getElementById('join-code');

    document.getElementById('join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var code = codeInput.value.trim();
      if (!Ui.fieldError(codeInput, code ? '' : 'Enter an invite code.')) return;
      var btn = document.getElementById('join-lookup');
      var box = document.getElementById('join-result');
      Ui.setLoading(btn, true, 'Looking up…');
      box.innerHTML = '';

      var found = null;
      try {
        var inv = await TrycordApi.invitePreview(code);
        found = { kind: 'invite', server: inv.server, invite: inv.invite };
      } catch (err) {
        if (err.code !== 'INVITE_INVALID') {
          Ui.setLoading(btn, false);
          box.innerHTML = Ui.errorState(err.message, 'Try again');
          var rb0 = box.querySelector('[data-retry]');
          if (rb0) rb0.onclick = () => btn.click();
          return;
        }
        try {
          var srv = await TrycordApi.previewByCode(code);
          found = { kind: 'legacy', server: { id: srv.id, name: srv.name, description: srv.description, member_count: srv.member_count } };
        } catch (err2) {
          Ui.setLoading(btn, false);
          box.innerHTML = Ui.emptyState({
            icon: '○', title: 'Code not found',
            hint: 'Check the code and try again, or browse Discover for public servers.',
          });
          return;
        }
      }
      Ui.setLoading(btn, false);
      renderFound(box, found, code);
    });

    function renderFound(box, found, code) {
      var s = found.server;
      var already = TrycordState.serverById(s.id);
      var stateNote = '';
      var canJoin = true;
      if (found.kind === 'invite' && found.invite.state !== 'valid') {
        canJoin = false;
        stateNote = '<p class="text-danger" role="alert">' +
          Ui.esc(INVITE_ERRORS['INVITE_' + found.invite.state.toUpperCase()] || 'This invite is not usable.') + '</p>';
      }
      box.innerHTML =
        '<div class="server-row">' + Ui.avatarHtml(s.name, '') +
        '<div class="info"><div class="name">' + Ui.esc(s.name) + '</div>' +
        '<div class="meta"><span>' + s.member_count + ' member' + (s.member_count === 1 ? '' : 's') + '</span></div>' +
        '<div class="desc">' + Ui.esc(s.description || 'No description yet.') + '</div></div></div>' +
        stateNote +
        '<button type="button" class="btn btn-primary btn-block" id="do-join" style="margin-top:var(--tc-space-3);" ' + (canJoin ? '' : 'disabled') + '>' +
        (already ? 'Open server' : 'Join server') + '</button>';

      var jb = document.getElementById('do-join');
      if (!jb || !canJoin) return;
      jb.onclick = async () => {
        if (already) {
          location.hash = '#/server/' + encodeURIComponent(s.id);
          return;
        }
        Ui.setLoading(jb, true, 'Joining…');
        try {
          var r = found.kind === 'invite'
            ? await TrycordApi.joinWithInvite(code)
            : await TrycordApi.joinByCode(code);
          await Trycord.refreshServers();
          Ui.setLoading(jb, false);
          Ui.toast('Joined ' + s.name + '.', 'success');
          location.hash = '#/server/' + encodeURIComponent(r.serverId);
        } catch (err) {
          Ui.setLoading(jb, false);
          if (err.code === 'ALREADY_MEMBER') {
            await Trycord.refreshServers();
            location.hash = '#/server/' + encodeURIComponent(s.id);
          } else {
            Ui.toast(INVITE_ERRORS[err.code] || err.message, 'error');
          }
        }
      };
    }
  }

  // --- activity ----------------------------------------------------------
  async function activity(root) {
    C.setTopbar('Activity', 'Latest messages across your servers.', '', 'i-activity');
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
      box.innerHTML = acts.map(TrycordPagesHome.activityItem).join('');
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
    C.setTopbar('Favorites', 'Servers you starred for quick access.', '', 'i-star');
    var favs = TrycordState.servers.filter((s) => TrycordState.isFav(s.id));
    if (!favs.length) {
      root.innerHTML = Ui.emptyState({
        icon: '☆', title: 'No favorites yet',
        hint: 'Star any server to pin it here.',
        actions: '<a class="btn btn-ghost btn-sm" href="#/servers">Browse your servers</a>',
      });
      return;
    }
    root.innerHTML = '<div id="fav-list">' + favs.map((s) => C.serverRow(s)).join('') + '</div>';
    C.wireServerRows(root.querySelector('#fav-list'), () => favorites(root));
  }

  window.TrycordPagesBrowse = { servers, discover, preview, join, activity, favorites };
})();
