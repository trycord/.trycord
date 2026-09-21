/* Hash router with auth guards. Public: #/ #/login #/register.
   App (require session): everything else. DM detail: #/dm/:id. */
(function () {
  var C = window.TrycordComponents;
  var Pub = window.TrycordPagesPublic;
  var Home = window.TrycordPagesHome;
  var Browse = window.TrycordPagesBrowse;
  var Dms = window.TrycordPagesDms;
  var Ws = window.TrycordPagesWorkspace;
  var Acct = window.TrycordPagesAccount;

  function showShell(which) {
    document.getElementById('shell-public').hidden = which !== 'public';
    document.getElementById('shell-app').hidden = which !== 'app';
  }

  function closeNav() {
    document.body.classList.remove('nav-open');
    document.body.classList.remove('side-open');
    var scrim = document.getElementById('nav-scrim');
    if (scrim) scrim.hidden = true;
    var t = document.getElementById('nav-toggle');
    if (t) t.setAttribute('aria-expanded', 'false');
  }

  // Mobile back button: visible on detail screens in mobile layout only.
  // (CSS keeps it hidden on desktop regardless.)
  function updateBackButton(r) {
    var back = document.getElementById('nav-back');
    if (!back) return;
    var detail = r.name === 'workspace' || r.name === 'dm-detail' ||
      r.name === 'preview' || r.name === 'settings';
    back.hidden = !(detail && window.TrycordUi.isMobileLayout());
  }

  function parse() {
    var h = location.hash || '#/';
    var segs = h.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    if (segs.length === 1 && segs[0] === '') return { name: 'landing' };
    if (segs[0] === 'server' && segs[1]) {
      return { name: 'workspace', id: segs[1], tab: segs[2] || 'overview', channel: segs[3] || null };
    }
    if (segs[0] === 'dm' && segs[1]) {
      return { name: 'dm-detail', id: segs[1] };
    }
    if (segs[0] === 'discover' && segs[1]) {
      return { name: 'preview', id: segs[1] };
    }
    if (segs[0] === 'reset-password') return { name: 'reset-password', token: segs[1] || null };
    if (segs[0] === 'verify-email') return { name: 'verify-email', token: segs[1] || null };
    if (segs[0] === 'forgot-password') return { name: 'forgot-password' };
    var simple = ['login', 'register', 'home', 'servers', 'discover', 'join', 'activity', 'favorites', 'dm', 'settings'];
    if (simple.indexOf(segs[0]) !== -1) return { name: segs[0] };
    return { name: 'unknown' };
  }

  var navigating = false;
  async function route() {
    if (navigating) return;
    navigating = true;
    try {
      C.closeMenus();
      if (window.TrycordUi) TrycordUi.closeCtx();
      closeNav();
      if (window.TrycordPagesWorkspace && TrycordPagesWorkspace.cleanup) {
        TrycordPagesWorkspace.cleanup();
      }
      if (window.TrycordPagesDms && TrycordPagesDms.cleanup) {
        TrycordPagesDms.cleanup();
      }
      var r = parse();
      var loggedIn = !!(window.TrycordState && TrycordState.user);

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
      // Recovery routes are public (the token IS the credential) and work
      // even when a stale session exists in this tab.
      if (r.name === 'forgot-password') {
        showShell('public');
        Pub.forgotPassword(document.getElementById('view-public'));
        document.title = 'Reset password · Trycord';
        return;
      }
      if (r.name === 'reset-password') {
        showShell('public');
        Pub.resetPassword(document.getElementById('view-public'), r.token);
        document.title = 'Set a new password · Trycord';
        return;
      }
      if (r.name === 'verify-email') {
        showShell('public');
        Pub.verifyEmail(document.getElementById('view-public'), r.token);
        document.title = 'Verify email · Trycord';
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
      if (r.name === 'dm-detail') activeHash = '#/dm';
      updateBackButton(r);
      C.renderRail(activeHash);
      C.renderUser();
      C.hideServerNav();
      var panel = document.getElementById('member-panel');
      if (panel) panel.hidden = true;
      var view = document.getElementById('view');

      switch (r.name) {
        case 'home': await Home.home(view); break;
        case 'servers': Browse.servers(view); break;
        case 'discover': await Browse.discover(view); break;
        case 'preview': await Browse.preview(view, r.id); break;
        case 'join': Browse.join(view); break;
        case 'activity': await Browse.activity(view); break;
        case 'favorites': Browse.favorites(view); break;
        case 'dm': await Dms.list(view); break;
        case 'dm-detail': await Dms.conversation(view, r.id); break;
        case 'settings': Acct.settings(view); break;
        case 'workspace':
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

  window.TrycordRouter = { route, parse, refreshChrome: () => updateBackButton(parse()) };
})();
