/* Home dashboard: welcome, quick actions, servers preview, recent activity. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  function activityItem(a) {
    return (
      '<button type="button" class="activity-item" data-goto-server="' + Ui.esc(a.server_id) +
      '" data-goto-channel="' + Ui.esc(a.channel_id) + '">' +
      Ui.avatarHtml(a.author_display || a.author_name, 'sm') +
      '<span class="body"><span class="ctx"><b>' + Ui.esc(a.author_display || a.author_name) + '</b> in ' +
      Ui.esc(a.server_name) + ' <b>#' + Ui.esc(a.channel_name) + '</b> · ' + Ui.timeAgo(a.created_at) + '</span>' +
      '<span class="text">' + Ui.esc(a.content) + '</span></span></button>'
    );
  }

  async function home(root) {
    var u = TrycordState.user;
    var first = (u.displayName || u.username || 'there').split(' ')[0];
    C.setTopbar('Home', 'Your Trycord overview.',
      '<button type="button" class="btn btn-primary btn-sm" data-top-create>+ New server</button>' +
      '<a class="btn btn-ghost btn-sm" href="#/join">Join server</a>');

    var servers = TrycordState.servers.slice(0, 6);
    var cards = servers.length
      ? '<div class="grid-cards">' + servers.map((s) => C.serverCard(s)).join('') + '</div>' +
        (TrycordState.servers.length > 6
          ? '<p><a href="#/servers">View all ' + TrycordState.servers.length + ' servers →</a></p>' : '')
      : Ui.emptyState({
          icon: '▦', title: 'No servers yet',
          hint: 'Create your first server or join one with an invite code.',
          actions: '<button type="button" class="btn btn-primary btn-sm" data-act="create">Create server</button>' +
            '<a class="btn btn-ghost btn-sm" href="#/join">Join server</a>',
        });

    root.innerHTML =
      '<section class="section"><h2>Welcome back, ' + Ui.esc(first) + '</h2>' +
      '<p class="muted">Here’s what’s happening across your Trycord servers.</p>' +
      '<div class="toolbar">' +
      '<button type="button" class="btn" data-act="create">＋ Create server</button>' +
      '<a class="btn" href="#/join">Join server</a>' +
      '<a class="btn" href="#/discover">Browse servers</a>' +
      '<button type="button" class="btn" data-act="recent">Open recent server</button>' +
      '</div></section>' +
      '<section class="section"><div class="row space"><h2>Your servers</h2><a href="#/servers">View all →</a></div>' +
      '<div id="home-servers">' + cards + '</div></section>' +
      '<section class="section"><div class="row space"><h2>Recent activity</h2><a href="#/activity">View all →</a></div>' +
      '<div id="home-activity">' + Ui.skeletons(3) + '</div></section>';

    C.wireCards(root);
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
      box.innerHTML = acts.length
        ? '<div class="activity-list">' + acts.map(activityItem).join('') + '</div>'
        : Ui.emptyState({ icon: '◷', title: 'No activity yet', hint: 'Messages in your servers will show up here.' });
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
