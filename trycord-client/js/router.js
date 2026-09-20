/* Hash router with auth guards. Public: #/ #/login #/register.
   App (require session): everything else. */
(function () {
  var C = window.TrycordComponents;
  var Pub = window.TrycordPagesPublic;
  var Home = window.TrycordPagesHome;
  var Browse = window.TrycordPagesBrowse;
  var Ws = window.TrycordPagesWorkspace;
  var Acct = window.TrycordPagesAccount;

  function showShell(which) {
    document.getElementById('shell-public').hidden = which !== 'public';
    document.getElementById('shell-app').hidden = which !== 'app';
  }

  function closeNav() {
    document.body.classList.remove('nav-open');
    document.body.classList.remove('panel-open');
    var t = document.getElementById('nav-toggle');
    if (t) t.setAttribute('aria-expanded', 'false');
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

  function parse() {
    var h = location.hash || '#/';
    var segs = h.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    if (segs.length === 1 && segs[0] === '') return { name: 'landing' };
    if (segs[0] === 'server' && segs[1]) {
      return { name: 'workspace', id: segs[1], tab: segs[2] || 'overview', channel: segs[3] || null };
    }
    if (segs[0] === 'dm' && segs[1]) {
      return { name: 'dm', id: segs[1] };
    }
    if (segs[0] === 'discover' && segs[1]) {
      return { name: 'preview', id: segs[1] };
    }
    var simple = ['login', 'register', 'home', 'servers', 'discover', 'join', 'activity', 'favorites', 'dm', 'profile', 'settings'];
    if (simple.indexOf(segs[0]) !== -1) return { name: segs[0] };
    return { name: 'unknown' };
  }

  function renderDMPage(view, peerId) {
    C.setTopbar('Direct Messages', 'Private conversations.');
    C.hideServerNav();
    var panel = document.getElementById('member-panel');
    if (panel) panel.hidden = true;
    var dms = (window.TrycordState && TrycordState.dms) || [];
    var peer = null;
    dms.forEach(function (d) { if (String(d.id) === String(peerId)) peer = d; });
    var list = C.renderDMList(peerId);
    view.innerHTML =
      '<div class="chat-grid" style="display:grid;grid-template-columns:18rem 1fr;gap:1rem;align-items:start;">' +
      '<div class="chat-channels">' + list + '</div>' +
      '<div class="chat-pane">' +
      (peer
        ? '<div class="chat-topic"><b>' + window.TrycordUi.esc(peer.name) + '</b> · Direct message</div>' +
          '<div class="msg-list"><div class="msg"><span class="avatar" aria-hidden="true">✉</span>' +
          '<div class="content"><div class="author">Trycord</div>' +
          '<div class="text">Direct messaging is coming online. Messages with ' + window.TrycordUi.esc(peer.name) + ' will appear here.</div></div></div></div>' +
          '<div class="composer"><textarea id="dm-input" placeholder="Message ' + window.TrycordUi.esc(peer.name) + '…" rows="1"></textarea>' +
          '<button type="button" class="send-btn" id="dm-send" aria-label="Send">➤</button></div>'
        : window.TrycordUi.emptyState({ icon: '✉', title: 'Select a conversation', hint: 'Pick someone from your DMs to start chatting.' })) +
      '</div></div>';
    view.querySelectorAll('[data-dm]').forEach(function (b) {
      b.onclick = function () { location.hash = '#/dm/' + encodeURIComponent(b.dataset.dm); };
    });
    var send = document.getElementById('dm-send');
    var input = document.getElementById('dm-input');
    if (send && input) {
      send.onclick = function () {
        if (!input.value.trim()) return;
        window.TrycordUi.toast('DM sending is not wired to the server yet.', 'warning');
      };
    }
  }

  var navigating = false;
  async function route() {
    if (navigating) return;
    navigating = true;
    try {
      C.closeMenus();
      closeNav();
      if (window.TrycordPagesWorkspace && TrycordPagesWorkspace.cleanup) {
        TrycordPagesWorkspace.cleanup();
      }
      var r = parse();
      var loggedIn = !!TrycordState.user;

      if (r.name === 'landing') {
        if (loggedIn) { location.hash = '#/home'; return; }
        showShell('public');
        Pub.landing(document.getElementById('view-public'));
        document.title = 'Trycord';
        return;
      }
      if (r.name === 'login' || r.name === 'register') {
        if (loggedIn) { location.hash = '#/home'; return; }
        showShell('public');
        (r.name === 'login' ? Pub.login : Pub.register)(document.getElementById('view-public'));
        document.title = (r.name === 'login' ? 'Log in' : 'Sign up') + ' · Trycord';
        return;
      }

      if (!loggedIn) {
        showShell('public');
        location.hash = '#/login';
        return;
      }
      showShell('app');
      var activeHash = '#/' + r.name.split('/')[0];
      if (r.name === 'workspace') activeHash = '#/servers';
      if (r.name === 'preview') activeHash = '#/discover';
      C.renderRail(activeHash === '#/dm' && r.id ? '#/dm' : activeHash);
      renderMobileBar(activeHash);
      C.renderUser();
      var view = document.getElementById('view');
      view.classList.remove('view-wide');

      switch (r.name) {
        case 'home': C.hideServerNav(); await Home.home(view); break;
        case 'servers': C.hideServerNav(); Browse.servers(view); break;
        case 'discover': C.hideServerNav(); await Browse.discover(view); break;
        case 'preview':
          C.hideServerNav();
          await Browse.preview(view, r.id);
          break;
        case 'join': C.hideServerNav(); Browse.join(view); break;
        case 'activity': C.hideServerNav(); await Browse.activity(view); break;
        case 'favorites': C.hideServerNav(); Browse.favorites(view); break;
        case 'dm': renderDMPage(view, r.id || null); break;
        case 'profile': C.hideServerNav(); Acct.profile(view); break;
        case 'settings': C.hideServerNav(); Acct.settings(view); break;
        case 'workspace':
          view.classList.add('view-wide');
          await Ws.workspace(view, r.id, r.tab, r.channel);
          break;
        default: location.hash = '#/home'; return;
      }
      var pt = document.getElementById('page-title');
      document.title = (pt ? pt.textContent : 'Trycord') + ' · Trycord';
      view.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } finally {
      navigating = false;
    }
  }

  window.TrycordRouter = { route: route };
})();
