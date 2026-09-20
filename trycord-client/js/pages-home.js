/* Home: welcome, quick actions, servers, recent activity. Rows and
   rhythm — no dashboard card soup. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  function activityItem(a) {
    return (
      '<button type="button" class="dm-row" data-goto-server="' + Ui.esc(a.server_id) +
      '" data-goto-channel="' + Ui.esc(a.channel_id) + '">' +
      Ui.avatarHtml(a.author_display || a.author_name, '') +
      '<span class="who"><span class="name">' + Ui.esc(a.author_display || a.author_name) +
      ' <span class="text-muted">in ' + Ui.esc(a.server_name) + ' #' + Ui.esc(a.channel_name) + '</span></span>' +
      '<span class="preview">' + Ui.esc(a.content) + '</span></span>' +
      '<span class="when">' + Ui.esc(Ui.timeAgo(a.created_at)) + '</span></button>'
    );
  }

  async function home(root) {
    var u = TrycordState.user;
    var first = (u.displayName || u.username || 'there').split(' ')[0];
    C.setTopbar('Home', 'Your Trycord overview.',
      '<button type="button" class="btn btn-primary btn-sm" data-top-create>New server</button>' +
      '<a class="btn btn-ghost btn-sm" href="#/join">Join server</a>', 'i-home');

    var servers = TrycordState.servers.slice(0, 6);
    var list = servers.length
      ? servers.map((s) => C.serverRow(s)).join('') +
        (TrycordState.servers.length > 6
          ? '<p style="margin-top:var(--tc-space-3);"><a href="#/servers" class="tc-muted-link">View all ' + TrycordState.servers.length + ' servers →</a></p>' : '')
      : Ui.emptyState({
          icon: Ui.icons.grid, title: 'No servers yet',
          hint: 'Create your first server or join one with an invite code.',
          actions: '<button type="button" class="btn btn-primary btn-sm" data-act="create">Create server</button>' +
            '<a class="btn btn-ghost btn-sm" href="#/join">Join server</a>',
        });

    root.innerHTML =
      '<section style="margin-bottom:var(--tc-space-8);"><h2 class="tc-h1">Welcome back, ' + Ui.esc(first) + '</h2>' +
      '<p class="tc-body" style="margin:var(--tc-space-1) 0 var(--tc-space-4);">Here\'s what\'s happening across your Trycord servers.</p>' +
      '<div class="toolbar">' +
      '<button type="button" class="btn btn-primary" data-act="create">Create server</button>' +
      '<a class="btn btn-secondary" href="#/join">Join server</a>' +
      '<a class="btn btn-secondary" href="#/discover">Browse servers</a>' +
      '<button type="button" class="btn btn-ghost" data-act="recent">Open recent server</button>' +
      '</div></section>' +
      '<section style="margin-bottom:var(--tc-space-8);"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:var(--tc-space-2);"><h2 class="tc-h2">Your servers</h2><a href="#/servers" class="tc-muted-link text-sm">View all →</a></div>' +
      '<div id="home-servers">' + list + '</div></section>' +
      '<section><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:var(--tc-space-2);"><h2 class="tc-h2">Recent activity</h2><a href="#/activity" class="tc-muted-link text-sm">View all →</a></div>' +
      '<div id="home-activity">' + Ui.skeletons(3) + '</div></section>';

    C.wireServerRows(root);
    root.querySelectorAll('[data-act="create"]').forEach((b) => {
      b.onclick = () => C.createServerModal();
    });
    var topCreate = document.querySelector('[data-top-create]');
    if (topCreate) topCreate.onclick = () => C.createServerModal();
    var recentBtn = root.querySelector('[data-act="recent"]');
    if (recentBtn) {
      recentBtn.onclick = () => {
        var r = TrycordState.recent[0];
        if (r && TrycordState.serverById(r.id)) location.hash = '#/server/' + encodeURIComponent(r.id);
        else Ui.toast('No recent servers yet — open one first.', 'info');
      };
    }

    try {
      var acts = await TrycordApi.activity(8);
      var box = document.getElementById('home-activity');
      if (!box) return;
      if (!acts.length) {
        box.innerHTML = Ui.emptyState({ icon: Ui.icons.clock, title: 'No activity yet', hint: 'Messages in your servers will show up here.' });
        return;
      }
      box.innerHTML = acts.map(activityItem).join('');
      box.querySelectorAll('[data-goto-server]').forEach((b) => {
        b.onclick = () => {
          location.hash = '#/server/' + encodeURIComponent(b.dataset.gotoServer) +
            '/chat/' + encodeURIComponent(b.dataset.gotoChannel);
        };
      });
    } catch (e) {
      var box2 = document.getElementById('home-activity');
      if (box2) {
        box2.innerHTML = Ui.errorState(e.message);
        var rb = box2.querySelector('[data-retry]');
        if (rb) rb.onclick = () => home(root);
      }
    }
  }

  window.TrycordPagesHome = { home, activityItem };
})();
