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

  function showStaleClientNotice() {
    if (document.getElementById('stale-client-notice')) return;
    var div = document.createElement('div');
    div.id = 'stale-client-notice';
    div.setAttribute('role', 'alert');
    div.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:#141519;color:#edeff4;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:2rem;';
    div.innerHTML =
      '<div style="max-width:26rem;text-align:center;">' +
      '<h1 style="font-size:1.25rem;margin:0 0 .5rem;">Trycord needs a refresh</h1>' +
      '<p style="margin:0 0 1rem;color:#b9bec1;font-size:.9rem;">The app failed to start, usually because the browser kept an old copy of the client files. Reloading fetches the current version.</p>' +
      '<button type="button" style="padding:.6rem 1.2rem;border:none;border-radius:8px;background:#6e6bf2;color:#fff;font:inherit;font-weight:600;cursor:pointer;">Reload Trycord</button></div>';
    document.body.prepend(div);
    var btn = div.querySelector('button');
    if (btn) btn.onclick = () => location.reload();
  }

  // Fail visibly instead of leaving a blank page: if the HTML shell and the
  // loaded scripts disagree (stale cached bundle) or boot throws, say so.
  window.addEventListener('error', () => {
    if (window.__trycordBooted) return;
    try { showStaleClientNotice(); } catch (e) { /* last resort: stay silent */ }
  });

  function shellMismatch() {
    return !(document.getElementById('shell-app') &&
      document.getElementById('view') &&
      document.getElementById('rail'));
  }

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
    if (shellMismatch()) {
      showStaleClientNotice();
      return;
    }
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
    window.__trycordBooted = true;
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
