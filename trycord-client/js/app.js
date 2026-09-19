/* Boot: shell wiring, session restore, connection status, routing. */
(function () {
  var C = window.TrycordComponents;
  var Ui = window.TrycordUi;

  var Trycord = {
    async refreshServers() {
      try {
        TrycordState.setServers(await TrycordApi.myServers());
      } catch (e) {
        TrycordState.setServers([]);
      }
      C.renderSidebar(location.hash);
    },

    async logout() {
      try { await TrycordApi.logout(); } catch (e) { /* token may already be dead */ }
      TrycordApi.token = null;
      TrycordState.user = null;
      if (window.TrycordPagesWorkspace) TrycordPagesWorkspace.cleanup();
      location.hash = '#/login';
      Ui.toast('Logged out.', 'info');
    },

    setOnline(online) {
      var pill = document.getElementById('conn-pill');
      var text = document.getElementById('conn-text');
      var dot = pill.querySelector('.dot');
      dot.className = 'dot' + (online ? '' : ' dot-bad');
      text.textContent = online ? 'Online' : 'Offline';
      document.getElementById('offline-banner').hidden = online;
    },
  };
  window.Trycord = Trycord;

  function wireChrome() {
    document.getElementById('retry-link').onclick = () => location.reload();

    var toggle = document.getElementById('nav-toggle');
    var scrim = document.getElementById('sidebar-scrim');
    toggle.onclick = () => {
      var open = !document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', open);
      scrim.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    scrim.onclick = () => {
      document.body.classList.remove('nav-open');
      scrim.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    };

    document.getElementById('user-chip-btn').onclick = (e) => {
      C.toggleMenu(e.currentTarget);
    };
    document.getElementById('avatar-btn').onclick = (e) => {
      C.toggleMenu(e.currentTarget);
    };
    document.getElementById('logout-btn').onclick = () => Trycord.logout();
    document.getElementById('new-server-btn').onclick = () => {
      document.body.classList.remove('nav-open');
      scrim.hidden = true;
      C.createServerModal();
    };
    document.addEventListener('click', (e) => {
      var menu = document.getElementById('user-menu');
      if (!menu.hidden &&
          !menu.contains(e.target) &&
          !e.target.closest('#user-chip-btn') &&
          !e.target.closest('#avatar-btn')) {
        C.closeMenus();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') C.closeMenus();
    });
  }

  async function probe() {
    try {
      await TrycordApi.health();
      Trycord.setOnline(true);
    } catch (e) {
      Trycord.setOnline(false);
    }
  }

  async function boot() {
    wireChrome();
    await probe();
    setInterval(probe, 30000);
    if (TrycordApi.token) {
      try {
        TrycordState.user = await TrycordApi.me();
        await Trycord.refreshServers();
      } catch (e) {
        TrycordApi.token = null;
        TrycordState.user = null;
      }
    }
    window.addEventListener('hashchange', () => window.TrycordRouter.route());
    if (!location.hash) location.hash = '#/';
    await window.TrycordRouter.route();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
