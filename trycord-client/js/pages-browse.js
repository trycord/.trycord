/* Browse pages: servers browser, public discover + preview, join flow, activity, favorites. */
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

  // --- discover (public index, paginated, no membership required) --------
  function publicCard(s) {
    var member = TrycordState.serverById(s.id);
    return (
      '<article class="server-card">' +
      '<div class="head">' + Ui.avatarHtml(s.name) +
      '<div class="titles"><h3>' + Ui.esc(s.name) + '</h3>' +
      '<div class="meta"><span>' + s.member_count + ' member' + (s.member_count === 1 ? '' : 's') + '</span>' +
      '<span aria-hidden="true">·</span><span>' + s.channel_count + ' channels</span></div>' +
      '</div></div>' +
      '<p class="desc">' + Ui.esc(s.description || 'No description.') + '</p>' +
      '<div class="foot"><a class="btn btn-sm" href="#/discover/' + Ui.esc(s.id) + '">Preview</a>' +
      '<span class="grow"></span>' +
      (member
        ? '<a class="btn btn-sm btn-ghost" href="#/server/' + Ui.esc(s.id) + '">Open →</a>'
        : '<button type="button" class="btn btn-sm btn-primary" data-quick-join="' + Ui.esc(s.id) + '">Join</button>') +
      '</div></article>'
    );
  }

  async function discover(root) {
    C.setTopbar('Discover', 'Public servers — preview without joining.');
    root.innerHTML =
      '<section class="section"><div class="toolbar" role="search">' +
      '<input type="text" id="dis-q" class="grow" placeholder="Search public servers…" aria-label="Search public servers" />' +
      '</div><div id="dis-results"></div>' +
      '<div class="row" style="justify-content:center;margin-top:1rem"><button type="button" class="btn btn-ghost" id="dis-more" hidden>Load more</button></div></section>';

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
          icon: '◌', title: 'No public servers found',
          hint: q.value.trim()
            ? 'Try a different search.'
            : 'Server owners can list their server here from Server → Settings → Visibility.',
        });
      } else {
        out.innerHTML = '<div class="grid-cards">' + items.map(publicCard).join('') + '</div>';
        out.querySelectorAll('[data-quick-join]').forEach((b) => {
          b.onclick = () => quickJoin(b.dataset.quickJoin, b);
        });
      }
      moreBtn.hidden = page >= pages;
    }

    async function load(reset) {
      if (loading) return;
      loading = true;
      if (reset) { page = 1; items = []; out.innerHTML = Ui.skeletons(4); }
      try {
        var r = await TrycordApi.discover(q.value.trim(), page, 12);
        pages = r.pages;
        items = reset ? r.items : items.concat(r.items);
        paint();
      } catch (e) {
        if (reset) {
          out.innerHTML = Ui.errorState(e.message);
          var rb = out.querySelector('[data-retry]');
          if (rb) rb.onclick = () => load(true);
        } else Ui.toast(e.message, 'bad');
      }
      loading = false;
    }

    async function quickJoin(serverId, btn) {
      Ui.setLoading(btn, true, 'Joining…');
      try {
        var r = await TrycordApi.joinPublic(serverId);
        await Trycord.refreshServers();
        Ui.setLoading(btn, false);
        Ui.toast('Joined server.', 'good');
        location.hash = '#/server/' + encodeURIComponent(r.serverId || serverId);
      } catch (e) {
        Ui.setLoading(btn, false);
        Ui.toast(INVITE_ERRORS[e.code] || e.message, 'bad');
      }
    }

    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(true), 350); });
    moreBtn.onclick = () => { page++; load(false); };
    load(true);
  }

  // --- public preview (no membership required) ---------------------------
  async function preview(root, serverId) {
    C.setTopbar('Server Preview', 'Public information — no membership needed.');
    root.innerHTML = '<div id="prev-body">' + Ui.skeletons(3) + '</div>';
    var body = document.getElementById('prev-body');
    try {
      var p = await TrycordApi.discoverPreview(serverId);
    } catch (e) {
      body.innerHTML = Ui.emptyState({
        icon: '◌', title: 'Server unavailable',
        hint: 'It may be private, unlisted, or deleted.',
        actions: '<a class="btn btn-ghost btn-sm" href="#/discover">Back to Discover</a>',
      });
      return;
    }
    var member = TrycordState.serverById(p.id);
    body.innerHTML =
      '<section class="ws-head">' + Ui.avatarHtml(p.name, 'lg') +
      '<div class="titles"><h2>' + Ui.esc(p.name) + '</h2>' +
      '<p class="desc">' + Ui.esc(p.description || 'No description.') + '</p></div>' +
      '<div class="side">' +
      (member
        ? '<a class="btn btn-primary" href="#/server/' + Ui.esc(p.id) + '">Open server →</a>'
        : '<button type="button" class="btn btn-primary" id="prev-join">Join server</button>') +
      '<a class="btn btn-ghost" href="#/discover">Discover</a></div></section>' +
      '<div class="stats">' +
      '<div class="stat"><div class="num">' + p.member_count + '</div><div class="lbl">Members</div></div>' +
      '<div class="stat"><div class="num">' + p.channel_count + '</div><div class="lbl">Channels</div></div>' +
      '<div class="stat"><div class="num">' + Ui.timeAgo(p.created_at) + '</div><div class="lbl">Created</div></div>' +
      '</div>' +
      '<section class="section"><h2>Channels</h2>' +
      (p.channels.length
        ? '<div class="activity-list">' + p.channels.map((c) =>
          '<div class="activity-item"><span class="body"><span class="ctx"><b>#' + Ui.esc(c.name) + '</b></span>' +
          '<span class="text muted">' + Ui.esc(c.topic || 'No topic.') + '</span></span></div>').join('') + '</div>'
        : '<p class="muted">No channels listed.</p>') + '</section>';

    var joinBtn = document.getElementById('prev-join');
    if (joinBtn) {
      joinBtn.onclick = async () => {
        Ui.setLoading(joinBtn, true, 'Joining…');
        try {
          var r = await TrycordApi.joinPublic(p.id);
          await Trycord.refreshServers();
          Ui.toast('Joined ' + p.name + '.', 'good');
          location.hash = '#/server/' + encodeURIComponent(r.serverId || p.id);
        } catch (e) {
          Ui.setLoading(joinBtn, false);
          if (e.code === 'ALREADY_MEMBER') {
            await Trycord.refreshServers();
            location.hash = '#/server/' + encodeURIComponent(p.id);
          } else Ui.toast(INVITE_ERRORS[e.code] || e.message, 'bad');
        }
      };
    }
  }

  // --- join (invites first, legacy codes as fallback) ---------------------
  function join(root) {
    C.setTopbar('Join a Server', 'Enter an invite code.');
    root.innerHTML =
      '<div class="join-wrap stack"><section class="settings-card">' +
      '<h2>Enter an invite code</h2>' +
      '<form id="join-form" novalidate><label class="field"><span>Invite or join code</span>' +
      '<input type="text" id="join-code" class="code-input" placeholder="e.g. AB12CD34 or lobby" autocomplete="off" spellcheck="false" /></label>' +
      '<button class="btn btn-primary btn-block" type="submit" id="join-lookup">Look up</button></form>' +
      '<div id="join-result" style="margin-top:1rem"></div>' +
      '<hr class="divider" /><p class="muted small">No code? <a href="#/discover">Browse Discover</a> for public servers.</p>' +
      '</section></div>';

    var codeInput = document.getElementById('join-code');

    document.getElementById('join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var code = codeInput.value.trim();
      if (!Ui.fieldError(codeInput, code ? '' : 'Enter an invite code.')) return;
      var btn = document.getElementById('join-lookup');
      var box = document.getElementById('join-result');
      Ui.setLoading(btn, true, 'Looking up…');
      box.innerHTML = '';

      // Path 1: invite code -> invite preview (state included).
      var found = null; // { kind: 'invite'|'legacy', server, invite? }
      try {
        var inv = await TrycordApi.invitePreview(code);
        found = { kind: 'invite', server: inv.server, invite: inv.invite };
      } catch (err) {
        if (err.code !== 'INVITE_INVALID') {
          Ui.setLoading(btn, false);
          box.innerHTML = infoCard('⌕', 'Lookup failed', err.message);
          return;
        }
        // Path 2: legacy join code.
        try {
          var srv = await TrycordApi.previewByCode(code);
          found = { kind: 'legacy', server: { id: srv.id, name: srv.name, description: srv.description, member_count: srv.member_count } };
        } catch (err2) {
          Ui.setLoading(btn, false);
          box.innerHTML = infoCard('⌕', 'Code not found',
            'Check the code and try again, or browse Discover for public servers.');
          return;
        }
      }
      Ui.setLoading(btn, false);
      renderFound(box, found, code);
    });

    function infoCard(icon, title, hint) {
      return '<div class="state" role="status"><div class="glyph" aria-hidden="true">' + icon + '</div>' +
        '<h3>' + Ui.esc(title) + '</h3><p>' + Ui.esc(hint) + '</p></div>';
    }

    function renderFound(box, found, code) {
      var s = found.server;
      var already = TrycordState.serverById(s.id);
      var stateNote = '';
      var canJoin = true;
      if (found.kind === 'invite' && found.invite.state !== 'valid') {
        canJoin = false;
        stateNote = '<p class="field-err" role="alert">' +
          Ui.esc(INVITE_ERRORS['INVITE_' + found.invite.state.toUpperCase()] || 'This invite is not usable.') + '</p>';
      }
      box.innerHTML =
        '<div class="server-card"><div class="head">' + Ui.avatarHtml(s.name) +
        '<div class="titles"><h3>' + Ui.esc(s.name) + '</h3>' +
        '<div class="meta"><span>' + s.member_count + ' member' + (s.member_count === 1 ? '' : 's') + '</span></div>' +
        '</div></div>' +
        '<p class="desc">' + Ui.esc(s.description || 'No description.') + '</p>' + stateNote +
        '<div class="foot"><button type="button" class="btn btn-primary" id="do-join" ' + (canJoin ? '' : 'disabled') + '>' +
        (already ? 'Open server' : 'Join server') + '</button></div></div>';

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
          Ui.toast('Joined ' + s.name + '.', 'good');
          location.hash = '#/server/' + encodeURIComponent(r.serverId);
        } catch (err) {
          Ui.setLoading(jb, false);
          if (err.code === 'ALREADY_MEMBER') {
            await Trycord.refreshServers();
            location.hash = '#/server/' + encodeURIComponent(s.id);
          } else {
            Ui.toast(INVITE_ERRORS[err.code] || err.message, 'bad');
          }
        }
      };
    }
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

  window.TrycordPagesBrowse = { servers, discover, preview, join, activity, favorites };
})();
