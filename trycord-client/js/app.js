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

    async refreshSocial() {
      await Promise.all([
        C.refreshDMList(),
        C.refreshFriends(),
        C.refreshNotifications(),
      ]);
    },

    async logout() {
      try { await TrycordApi.logout(); } catch (e) { /* token may already be dead */ }
      TrycordApi.token = null;
      TrycordState.user = null;
      if (window.TrycordPagesWorkspace) TrycordPagesWorkspace.cleanup();
      if (window.TrycordPagesDms) TrycordPagesDms.cleanup();
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
      '<p style="margin:0 0 1rem;color:#b9bec9;font-size:.9rem;">The app failed to start, usually because the browser kept an old copy of the client files. Reloading fetches the current version.</p>' +
      '<button type="button" style="padding:.6rem 1.2rem;border:none;border-radius:8px;background:#6e6bf2;color:#fff;font:inherit;font-weight:600;cursor:pointer;">Reload Trycord</button></div>';
    document.body.prepend(div);
    var btn = div.querySelector('button');
    if (btn) btn.onclick = () => location.reload();
  }

  // Fail visibly instead of leaving a blank page.
  window.addEventListener('error', () => {
    if (window.__trycordBooted) return;
    try { showStaleClientNotice(); } catch (e) { /* last resort */ }
  });

  function shellMismatch() {
    return !(document.getElementById('shell-app') &&
      document.getElementById('view') &&
      document.getElementById('rail'));
  }

  function wireChrome() {
    var retry = document.getElementById('retry-link');
    if (retry) retry.onclick = () => location.reload();

    var toggle = document.getElementById('nav-toggle');
    var scrim = document.getElementById('nav-scrim');
    if (toggle) {
      toggle.onclick = () => {
        var open = !document.body.classList.contains('nav-open');
        document.body.classList.toggle('nav-open', open);
        if (scrim) scrim.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
    }
    if (scrim) {
      scrim.onclick = () => {
        document.body.classList.remove('nav-open');
        scrim.hidden = true;
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      };
    }

    var backBtn = document.getElementById('nav-back');
    if (backBtn) {
      backBtn.onclick = () => {
        if (window.history.length > 1) window.history.back();
        else location.hash = '#/home';
      };
    }

    document.querySelectorAll('#rail .spine-place[data-nav]').forEach((b) => {
      b.onclick = () => { location.hash = b.getAttribute('data-nav'); };
    });

    var railAdd = document.getElementById('rail-add');
    if (railAdd) railAdd.onclick = () => C.createServerModal();

    var railAccount = document.getElementById('rail-account');
    if (railAccount) railAccount.onclick = (e) => C.toggleMenu(e.currentTarget);

    var avatarBtn = document.getElementById('avatar-btn');
    if (avatarBtn) avatarBtn.onclick = (e) => C.toggleMenu(e.currentTarget);

    var bell = document.getElementById('bell-btn');
    if (bell) bell.onclick = (e) => C.toggleBell(e.currentTarget);

    var paletteBtn = document.getElementById('palette-btn');
    if (paletteBtn) paletteBtn.onclick = () => C.openPalette();

    var accTheme = document.getElementById('account-theme');
    if (accTheme) {
      accTheme.innerHTML = '<svg aria-hidden="true" style="width:1.1rem;height:1.1rem;"><use href="#i-theme"/></svg>';
      accTheme.onclick = () => cycleTheme();
    }
    var accSettings = document.getElementById('account-settings');
    if (accSettings) {
      accSettings.innerHTML = '<svg aria-hidden="true" style="width:1.1rem;height:1.1rem;"><use href="#i-cog"/></svg>';
      accSettings.onclick = () => { location.hash = '#/settings'; };
    }

    document.addEventListener('click', (e) => {
      var root = document.getElementById('menu-root');
      if (root && root.firstChild &&
          !root.contains(e.target) &&
          !e.target.closest('#rail-account') &&
          !e.target.closest('#avatar-btn') &&
          !e.target.closest('#bell-btn')) {
        C.closeMenus();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        C.closeMenus();
        if (window.TrycordUi) TrycordUi.closeCtx();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        C.openPalette();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        location.hash = '#/settings';
      }
    });

    // Restore saved appearance (theme/density/motion/font size).
    try {
      var savedTheme = localStorage.getItem('trycord-theme');
      if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    } catch (e) {}
    applyPrefs();
  }

  function cycleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = cur === 'dark' ? 'light' : cur === 'light' ? 'high-contrast' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('trycord-theme', next); } catch (e) {}
    var sel = document.getElementById('set-theme');
    if (sel) sel.value = next;
    Ui.toast('Theme: ' + next, 'info');
  }

  function applyPrefs() {
    try {
      var fs = localStorage.getItem('trycord-font-scale');
      if (fs) document.documentElement.style.fontSize = fs + 'px';
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
        await Trycord.refreshSocial();
      } catch (e) {
        TrycordApi.token = null;
        TrycordState.user = null;
      }
    }
    window.addEventListener('hashchange', () => window.TrycordRouter.route());
    // Presentation state is owned by presentation.js (single media query).
    // Breakpoint crossings only refresh chrome affordances (back button).
    // Never re-render the view: that would wipe composer drafts.
    if (window.TrycordPresentation) {
      document.addEventListener('trycord:presentation', () => {
        if (window.TrycordRouter.refreshChrome) window.TrycordRouter.refreshChrome();
      });
    }
    if (!location.hash) location.hash = '#/';
    await window.TrycordRouter.route();
    window.__trycordBooted = true;
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
