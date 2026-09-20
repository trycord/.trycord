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
      C.renderRail(location.hash);
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
      if (!pill) return;
      var text = document.getElementById('conn-text');
      var dot = pill.querySelector('.dot');
      if (dot) dot.className = 'dot' + (online ? '' : ' dot-bad');
      if (text) text.textContent = online ? 'Online' : 'Offline';
      var banner = document.getElementById('offline-banner');
      if (banner) banner.hidden = online;
    },
  };
  window.Trycord = Trycord;

  function wireChrome() {
    var retry = document.getElementById('retry-link');
    if (retry) retry.onclick = function () { location.reload(); };

    var toggle = document.getElementById('nav-toggle');
    if (toggle) {
      toggle.onclick = function () {
        var open = !document.body.classList.contains('nav-open');
        document.body.classList.toggle('nav-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
    }

    // Rail navigation tabs
    document.querySelectorAll('#rail .rail-btn[data-nav]').forEach(function (b) {
      b.onclick = function () { location.hash = b.getAttribute('data-nav'); };
    });

    var railAdd = document.getElementById('rail-add');
    if (railAdd) railAdd.onclick = function () { C.createServerModal(); };

    var railAccount = document.getElementById('rail-account');
    if (railAccount) railAccount.onclick = function (e) { C.toggleMenu(e.currentTarget); };

    var avatarBtn = document.getElementById('avatar-btn');
    if (avatarBtn) avatarBtn.onclick = function (e) { C.toggleMenu(e.currentTarget); };

    var accTheme = document.getElementById('account-theme');
    if (accTheme) {
      accTheme.innerHTML = '<svg class="icon" aria-hidden="true" style="width:1.2rem;height:1.2rem;"><use href="#i-theme"/></svg>';
      accTheme.onclick = function () {
        var cur = document.documentElement.getAttribute('data-theme') || 'dark';
        var next = cur === 'dark' ? 'light' : cur === 'light' ? 'high-contrast' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('trycord-theme', next); } catch (e) {}
        Ui.toast('Theme: ' + next, 'info');
      };
    }
    var accSettings = document.getElementById('account-settings');
    if (accSettings) {
      accSettings.innerHTML = '<svg class="icon" aria-hidden="true" style="width:1.2rem;height:1.2rem;"><use href="#i-cog"/></svg>';
      accSettings.onclick = function () { C.openSettingsModal(); };
    }

    // Topbar search -> palette
    var search = document.getElementById('search-input');
    if (search) {
      search.addEventListener('focus', function () { C.openPalette(); search.blur(); });
      search.addEventListener('click', function () { C.openPalette(); search.blur(); });
    }

    document.addEventListener('click', function (e) {
      var root = document.getElementById('menu-root');
      if (root && root.firstChild &&
          !root.contains(e.target) &&
          !e.target.closest('#rail-account') &&
          !e.target.closest('#avatar-btn')) {
        C.closeMenus();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') C.closeMenus();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        C.openPalette();
      }
    });

    // Restore saved theme
    try {
      var saved = localStorage.getItem('trycord-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (e) {}
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
    window.addEventListener('hashchange', function () { window.TrycordRouter.route(); });
    if (!location.hash) location.hash = '#/';
    await window.TrycordRouter.route();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
