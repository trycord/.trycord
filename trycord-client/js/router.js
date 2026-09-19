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
    document.getElementById('sidebar-scrim').hidden = true;
    document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
  }

  function parse() {
    var h = location.hash || '#/';
    var segs = h.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    if (segs.length === 1 && segs[0] === '') return { name: 'landing' };
    if (segs[0] === 'server' && segs[1]) {
      return { name: 'workspace', id: segs[1], tab: segs[2] || 'overview', channel: segs[3] || null };
    }
    if (segs[0] === 'discover' && segs[1]) {
      return { name: 'preview', id: segs[1] };
    }
    var simple = ['login', 'register', 'home', 'servers', 'discover', 'join', 'activity', 'favorites', 'profile', 'settings'];
    if (simple.indexOf(segs[0]) !== -1) return { name: segs[0] };
    return { name: 'unknown' };
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
        document.title = '.trycord';
        return;
      }
      if (r.name === 'login' || r.name === 'register') {
        if (loggedIn) { location.hash = '#/home'; return; }
        showShell('public');
        (r.name === 'login' ? Pub.login : Pub.register)(document.getElementById('view-public'));
        document.title = (r.name === 'login' ? 'Log in' : 'Sign up') + ' · .trycord';
        return;
      }

      if (!loggedIn) {
        showShell('public');
        location.hash = '#/login';
        return;
      }
      showShell('app');
      C.renderSidebar('#/' + r.name.split('/')[0]);
      C.renderUser();
      var view = document.getElementById('view');
      view.classList.remove('view-wide');

      switch (r.name) {
        case 'home': await Home.home(view); break;
        case 'servers': Browse.servers(view); break;
        case 'discover': await Browse.discover(view); break;
        case 'preview':
          C.renderSidebar('#/discover');
          await Browse.preview(view, r.id);
          break;
        case 'join': Browse.join(view); break;
        case 'activity': await Browse.activity(view); break;
        case 'favorites': Browse.favorites(view); break;
        case 'profile': Acct.profile(view); break;
        case 'settings': Acct.settings(view); break;
        case 'workspace':
          view.classList.add('view-wide');
          C.renderSidebar('#/servers');
          await Ws.workspace(view, r.id, r.tab, r.channel);
          break;
        default: location.hash = '#/home'; return;
      }
      document.title = document.getElementById('page-title').textContent + ' · .trycord';
      view.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } finally {
      navigating = false;
    }
  }

  window.TrycordRouter = { route };
})();
