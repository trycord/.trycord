/* Account pages: profile + settings (account, appearance, application). */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  function profile(root) {
    var u = TrycordState.user;
    var mine = TrycordState.servers;
    var owned = mine.filter((s) => s.is_owner).length;
    C.setTopbar('Profile', '@' + u.username);
    root.innerHTML =
      '<section class="card"><div class="card-body" style="display: flex; gap: var(--tc-space-4); align-items: center; flex-wrap: wrap;">' +
      Ui.avatarHtml(u.displayName || u.username, 'avatar-xl') +
      '<div><h2 style="margin:0">' + Ui.esc(u.displayName || u.username) + '</h2>' +
      '<p class="text-muted" style="margin:0">@' + Ui.esc(u.username) + ' · member since ' + Ui.fullDate(u.createdAt) + '</p></div>' +
      '</div></section>' +
      '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--tc-space-4); margin-top: var(--tc-space-4);">' +
      '<div class="card"><div class="card-body" style="text-align: center;"><div style="font-size: var(--tc-text-3xl); font-weight: var(--tc-font-bold);">' + mine.length + '</div><div class="text-muted text-sm">Servers joined</div></div></div>' +
      '<div class="card"><div class="card-body" style="text-align: center;"><div style="font-size: var(--tc-text-3xl); font-weight: var(--tc-font-bold);">' + owned + '</div><div class="text-muted text-sm">Servers owned</div></div></div>' +
      '<div class="card"><div class="card-body" style="text-align: center;"><div style="font-size: var(--tc-text-3xl); font-weight: var(--tc-font-bold);">' + TrycordState.favorites.length + '</div><div class="text-muted text-sm">Favorites</div></div></div>' +
      '</div>' +
      '<section class="section"><h2>Your servers</h2><div id="prof-servers"></div></section>';

    var box = document.getElementById('prof-servers');
    if (!mine.length) {
      box.innerHTML = Ui.emptyState({
        icon: '▦', title: 'No servers yet',
        hint: 'Join or create a server to get started.',
        actions: '<a class="btn btn-ghost btn-sm" href="#/join">Join server</a>',
      });
    } else {
      box.innerHTML = '<div class="showcase-grid">' + mine.map((s) => C.serverCard(s)).join('') + '</div>';
      C.wireCards(box);
    }
  }

  function settings(root) {
    var u = TrycordState.user;
    var s = TrycordState.settings;
    C.setTopbar('Settings', 'Account, appearance, and application.');
    root.innerHTML =
      '<div style="display: grid; gap: var(--tc-space-4); max-width: 48rem;">' +
      '<section class="card" aria-labelledby="set-account"><div class="card-header"><h2 id="set-account">Account</h2></div>' +
      '<div class="card-body"><p class="text-muted">Signed in as <b>@' + Ui.esc(u.username) + '</b>.</p>' +
      '<form id="name-form"><div class="form-group"><label class="form-label" for="set-display">Display name</label>' +
      '<input type="text" id="set-display" class="form-input" maxlength="32" value="' + Ui.esc(u.displayName || '') + '" /></div>' +
      '<button class="btn btn-primary btn-sm" type="submit">Save display name</button></form>' +
      '<hr class="divider" />' +
      '<form id="pw-form"><div class="form-group"><label class="form-label" for="pw-cur">Current password</label>' +
      '<input type="password" id="pw-cur" class="form-input" autocomplete="current-password" /></div>' +
      '<div class="form-group"><label class="form-label" for="pw-new">New password (6+ characters)</label>' +
      '<input type="password" id="pw-new" class="form-input" autocomplete="new-password" /></div>' +
      '<button class="btn btn-secondary btn-sm" type="submit">Change password</button></form></div></section>' +

      '<section class="card" aria-labelledby="set-appear"><div class="card-header"><h2 id="set-appear">Appearance</h2></div>' +
      '<div class="card-body"><div class="form-group"><label class="form-label" for="set-theme">Theme</label>' +
      '<select id="set-theme" class="form-input"><option value="dark">Dark</option><option value="light">Light</option></select></div>' +
      '<div class="form-group"><label class="form-label" for="set-density">Density</label>' +
      '<select id="set-density" class="form-input"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div>' +
      '<p class="text-muted text-sm">Saved instantly on this device.</p></div></section>' +

      '<section class="card" aria-labelledby="set-app"><div class="card-header"><h2 id="set-app">Application</h2></div>' +
      '<div class="card-body"><form id="api-form"><div class="form-group"><label class="form-label" for="set-api">Server URL (blank = auto)</label>' +
      '<input type="url" id="set-api" class="form-input" placeholder="http://localhost:9971" value="' + Ui.esc((TrycordState.access && TrycordState.access.apiBase) || '') + '" /></div>' +
      '<div style="display: flex; gap: var(--tc-space-3); align-items: center;"><button class="btn btn-secondary btn-sm" type="submit">Save &amp; reload</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="api-test">Test connection</button>' +
      '<span id="api-status" class="text-sm text-muted" role="status"></span></div></form>' +
      '<hr class="divider" />' +
      '<div style="display: flex; gap: var(--tc-space-3); align-items: center;"><span class="text-sm text-muted">Global sync: <b id="global-status">checking…</b></span>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="global-retry">Recheck</button></div>' +
      '<p class="text-muted text-sm">Global sync is optional and never required for chat. ' +
      'Appearance stays on this device; only an explicitly configured global service is contacted.</p>' +
      '<hr class="divider" />' +
      '<div style="display: flex; gap: var(--tc-space-3);"><button class="btn btn-ghost btn-sm" id="clear-local" type="button">Clear favorites &amp; recent</button>' +
      '<button class="btn btn-danger btn-sm" id="logout-btn2" type="button">Log out</button></div>' +
      '<p class="text-muted text-sm" style="margin-top: var(--tc-space-4);" id="client-version-line">Trycord client</p></div></section>' +

      '<section class="card" aria-labelledby="set-about"><div class="card-header"><h2 id="set-about">About &amp; Updates</h2></div>' +
      '<div class="card-body"><p class="text-muted" style="margin:0 0 var(--tc-space-3);"><b id="about-version">Trycord</b> — a self-hostable community chat platform.</p>' +
      '<p style="display:flex;gap:var(--tc-space-3);flex-wrap:wrap;margin:0 0 var(--tc-space-4);">' +
      '<a class="btn btn-ghost btn-sm" href="https://github.com/LanxTheShowmaker/.trycord" target="_blank" rel="noopener">Source code</a>' +
      '<a class="btn btn-ghost btn-sm" href="https://github.com/LanxTheShowmaker/.trycord#readme" target="_blank" rel="noopener">Documentation</a>' +
      '<a class="btn btn-ghost btn-sm" href="https://github.com/LanxTheShowmaker/.trycord/issues" target="_blank" rel="noopener">Report a problem</a></p>' +
      '<div id="updater-block">' +
      '<div class="form-group"><label class="form-label" for="upd-channel">Release channel</label>' +
      '<select id="upd-channel" class="form-input"><option value="latest">Stable</option><option value="beta">Beta</option></select></div>' +
      '<div class="form-check" style="margin-bottom: var(--tc-space-3);"><input type="checkbox" id="upd-auto" class="form-check-input" checked />' +
      '<label class="form-check-label" for="upd-auto">Automatically install updates</label></div>' +
      '<div style="display: flex; gap: var(--tc-space-3); align-items: center; flex-wrap: wrap;">' +
      '<button class="btn btn-secondary btn-sm" type="button" id="upd-check">Check for updates</button>' +
      '<span id="upd-status" class="text-sm text-muted" role="status">Last checked: never</span></div>' +
      '<div class="progress" id="upd-progress" hidden style="margin-top: var(--tc-space-3);"><div class="progress-bar" id="upd-bar" style="width: 0%;"></div></div>' +
      '</div>' +
      '<p class="text-muted text-sm" id="upd-note" style="margin-top: var(--tc-space-3);">Desktop updates are delivered by the installed Trycord app. This web view checks through the desktop bridge when available.</p>' +
      '</div></section>' +
      '</div>';

    document.getElementById('set-theme').value = s.theme || 'dark';
    document.getElementById('set-density').value = s.density || 'comfortable';

    document.getElementById('name-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var input = document.getElementById('set-display');
      if (!Ui.fieldError(input, input.value.trim() ? '' : 'Display name cannot be empty.')) return;
      try {
        var updated = await TrycordApi.patchMe({ displayName: input.value.trim() });
        TrycordState.user = updated;
        C.renderUser();
        Ui.toast('Display name saved.', 'success');
      } catch (err) { Ui.toast(err.message, 'error'); }
    });

    document.getElementById('pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var cur = document.getElementById('pw-cur');
      var neu = document.getElementById('pw-new');
      var ok = Ui.fieldError(cur, cur.value ? '' : 'Enter your current password.');
      ok = Ui.fieldError(neu, neu.value.length >= 6 ? '' : 'New password must be 6+ characters.') && ok;
      if (!ok) return;
      try {
        await TrycordApi.changePassword({ currentPassword: cur.value, newPassword: neu.value });
        cur.value = '';
        neu.value = '';
        Ui.toast('Password changed.', 'success');
      } catch (err) {
        Ui.fieldError(cur, err.message);
      }
    });

    document.getElementById('set-theme').addEventListener('change', (e) => {
      TrycordState.settings.theme = e.target.value;
      TrycordState.saveSettings();
    });
    document.getElementById('set-density').addEventListener('change', (e) => {
      TrycordState.settings.density = e.target.value;
      TrycordState.saveSettings();
    });

    document.getElementById('api-form').addEventListener('submit', (e) => {
      e.preventDefault();
      var raw = document.getElementById('set-api').value.trim();
      if (raw && !TrycordApi.normalizeUrl(raw)) {
        Ui.fieldError(document.getElementById('set-api'), 'Use an http(s) URL like http://51.79.44.111:9971');
        return;
      }
      TrycordState.access.apiBase = raw;
      TrycordState.saveAccess();
      location.reload();
    });

    document.getElementById('api-test').onclick = async (e) => {
      var btn = e.currentTarget;
      var status = document.getElementById('api-status');
      Ui.setLoading(btn, true, 'Testing…');
      status.textContent = '';
      var raw = document.getElementById('set-api').value.trim();
      var r = await TrycordApi.testConnection(raw || TrycordApi.baseUrl());
      Ui.setLoading(btn, false);
      if (!r.url) status.textContent = '⚠ ' + r.message;
      else if (r.ok) status.textContent = '✓ Connected to Trycord (' + r.latencyMs + ' ms)';
      else status.textContent = '✕ ' + r.message;
    };

    document.getElementById('clear-local').onclick = async () => {
      var yes = await Ui.confirmDialog({
        title: 'Clear local data?',
        message: 'This removes your favorites and recent servers on this device.',
        confirmText: 'Clear',
      });
      if (yes) {
        TrycordState.clearLocal();
        Ui.toast('Local data cleared.', 'success');
      }
    };
    document.getElementById('logout-btn2').onclick = () => Trycord.logout();

    // About & Updates (desktop bridge; no-ops safely in the browser).
    // One failure => one notice. Identical repeat failures are deduplicated
    // so a broken release or flaky network can never toast-loop the user.
    (function wireUpdater() {
      var bridge = (window.trycordDesktop && window.trycordDesktop.updater) || null;
      var ver = (window.trycordDesktop && window.trycordDesktop.version) || 'web client';
      var line = document.getElementById('client-version-line');
      if (line) line.textContent = 'Trycord ' + ver + ' · instance-aware access points.';
      var about = document.getElementById('about-version');
      if (about) about.textContent = 'Trycord ' + ver;
      var status = document.getElementById('upd-status');
      var bar = document.getElementById('upd-bar');
      var prog = document.getElementById('upd-progress');
      var checkBtn = document.getElementById('upd-check');
      var autoBox = document.getElementById('upd-auto');
      var chanSel = document.getElementById('upd-channel');
      if (!bridge) {
        if (status) status.textContent = 'Desktop updater not present (browser mode).';
        if (checkBtn) checkBtn.disabled = true;
        return;
      }
      var lastErrorSig = '';
      var lastErrorAt = 0;
      var updateModalOpen = false;
      function applyPrefs(prefs) {
        if (!prefs) return;
        if (autoBox && typeof prefs.autoInstall === 'boolean') autoBox.checked = prefs.autoInstall;
        if (chanSel && prefs.channel) chanSel.value = prefs.channel;
        if (status && prefs.lastChecked) status.textContent = 'Last checked: ' + prefs.lastChecked;
      }
      try {
        var maybePrefs = bridge.getPrefs ? bridge.getPrefs() : null;
        if (maybePrefs && typeof maybePrefs.then === 'function') {
          maybePrefs.then(applyPrefs, function () {});
        } else {
          applyPrefs(maybePrefs);
        }
      } catch (e) { /* prefs are best-effort */ }
      if (autoBox) autoBox.onchange = function () { try { bridge.setPrefs({ autoInstall: autoBox.checked }); } catch (e) {} };
      if (chanSel) chanSel.onchange = function () { try { bridge.setPrefs({ channel: chanSel.value }); } catch (e) {} };
      if (checkBtn) checkBtn.onclick = function () {
        Ui.setLoading(checkBtn, true, 'Checking…');
        if (status) status.textContent = 'Checking for updates…';
        try { bridge.check(); } catch (e) { Ui.setLoading(checkBtn, false); }
      };
      function showDetails(ev) {
        var rows = [
          ['App version', ev.version || ver],
          ['Channel', ev.channel || 'latest'],
          ['Provider', (ev.provider || 'github')],
          ['Repository', (ev.owner || '') + '/' + (ev.repo || '')],
          ['Failure', ev.kind || 'unknown'],
        ];
        var body = document.createElement('div');
        body.innerHTML =
          '<dl style="display:grid;grid-template-columns:auto 1fr;gap:.35rem .9rem;font-size:var(--tc-text-sm);margin:0 0 var(--tc-space-3);">' +
          rows.map(function (r) {
            return '<dt class="text-muted">' + Ui.esc(r[0]) + '</dt><dd style="margin:0;">' + Ui.esc(String(r[1])) + '</dd>';
          }).join('') + '</dl>' +
          '<p class="text-muted text-sm" style="margin:0;">Technical detail (from the update log, safe to share when reporting a bug):</p>' +
          '<pre class="code-chip" style="display:block;white-space:pre-wrap;margin-top:var(--tc-space-2);">' +
          Ui.esc(ev.message || 'unknown error') + '</pre>';
        Ui.openModal({
          title: 'Update details',
          body: body,
          actions: [{ id: 'close', label: 'Close', primary: true }],
          onClose: function () { updateModalOpen = false; },
        });
      }
      bridge.onEvent(function (ev) {
        if (!ev || !ev.type) return;
        if (ev.type === 'checking') {
          if (status) status.textContent = 'Checking for updates…';
        } else if (ev.type === 'available') {
          Ui.setLoading(checkBtn, false);
          if (status) status.textContent = 'Trycord ' + (ev.version || '') + ' is available. Downloading update…';
          if (prog) prog.hidden = false;
        } else if (ev.type === 'not-available') {
          Ui.setLoading(checkBtn, false);
          if (status) status.textContent = "You're up to date." + (ev.lastChecked ? ' Last checked: ' + ev.lastChecked : '');
          if (prog) prog.hidden = true;
        } else if (ev.type === 'progress') {
          if (bar && typeof ev.percent === 'number') bar.style.width = Math.max(0, Math.min(100, ev.percent)) + '%';
          if (prog) prog.hidden = false;
          if (status) status.textContent = 'Downloading update… ' + Math.round(ev.percent || 0) + '%';
        } else if (ev.type === 'downloaded') {
          Ui.setLoading(checkBtn, false);
          if (prog) prog.hidden = true;
          if (status) status.textContent = 'Update ready. Restart Trycord to install v' + (ev.version || '') + '.';
          var modalRoot = document.getElementById('modal-root');
          if (modalRoot && !modalRoot.firstChild) updateModalOpen = false;
          if (updateModalOpen) return;
          updateModalOpen = true;
          Ui.openModal({
            title: 'Trycord ' + (ev.version || '') + ' is ready to install',
            body: '<p class="body-text">The update is downloaded and verified. Restart now to install it, or install later from Settings.</p>',
            actions: [
              { id: 'later', label: 'Later' },
              { id: 'restart', label: 'Restart Trycord', primary: true, onClick: function (close) { try { bridge.install(); } catch (e) {} close(); } },
            ],
            onClose: function () { updateModalOpen = false; },
          });
        } else if (ev.type === 'error') {
          Ui.setLoading(checkBtn, false);
          if (prog) prog.hidden = true;
          if (status) status.textContent = "Couldn't check for updates. Try again later.";
          // Dedupe: same failure signature within 10 minutes stays silent
          // in the UI (it is still logged in the main process).
          var sig = String(ev.kind || 'unknown') + '|' + String(ev.message || '').slice(0, 120);
          var nowTs = Date.now();
          if (sig === lastErrorSig && nowTs - lastErrorAt < 10 * 60 * 1000) return;
          lastErrorSig = sig;
          lastErrorAt = nowTs;
          var body = document.createElement('div');
          body.innerHTML =
            '<p class="body-text" style="margin-top:0;">Couldn\'t update Trycord.</p>' +
            '<p class="text-muted text-sm">You can continue using the current version. Try again later.</p>';
          var detailsBtn = document.createElement('button');
          detailsBtn.type = 'button';
          detailsBtn.className = 'btn btn-ghost btn-sm';
          detailsBtn.textContent = 'Details';
          detailsBtn.onclick = function () { showDetails(ev); };
          body.appendChild(detailsBtn);
          Ui.openModal({
            title: 'Update failed',
            body: body,
            actions: [{ id: 'close', label: 'Close', primary: true }],
          });
        }
      });
    })();

    var refreshGlobal = async () => {
      var el = document.getElementById('global-status');
      if (!el) return;
      el.textContent = 'checking…';
      var r = await TrycordGlobal.check();
      var g = TrycordGlobal.globalUrl();
      el.textContent = TrycordGlobal.describe(r.status) + (g ? ' (' + g + ')' : '');
    };
    document.getElementById('global-retry').onclick = refreshGlobal;
    refreshGlobal();
  }

  window.TrycordPagesAccount = { profile, settings };
})();
