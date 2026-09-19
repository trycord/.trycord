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
      '<section class="settings-card"><div class="row wrap">' + Ui.avatarHtml(u.displayName || u.username, 'lg') +
      '<div><h2 style="margin:0">' + Ui.esc(u.displayName || u.username) + '</h2>' +
      '<p class="muted" style="margin:0">@' + Ui.esc(u.username) + ' · member since ' + Ui.fullDate(u.createdAt) + '</p></div>' +
      '</div></section>' +
      '<div class="stats" style="margin-top:1rem">' +
      '<div class="stat"><div class="num">' + mine.length + '</div><div class="lbl">Servers joined</div></div>' +
      '<div class="stat"><div class="num">' + owned + '</div><div class="lbl">Servers owned</div></div>' +
      '<div class="stat"><div class="num">' + TrycordState.favorites.length + '</div><div class="lbl">Favorites</div></div>' +
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
      box.innerHTML = '<div class="grid-cards">' + mine.map((s) => C.serverCard(s)).join('') + '</div>';
      C.wireCards(box);
    }
  }

  function settings(root) {
    var u = TrycordState.user;
    var s = TrycordState.settings;
    C.setTopbar('Settings', 'Account, appearance, and application.');
    root.innerHTML =
      '<div class="settings-grid">' +
      '<section class="settings-card" aria-labelledby="set-account"><h2 id="set-account">Account</h2>' +
      '<p class="hint">Signed in as <b>@' + Ui.esc(u.username) + '</b>.</p>' +
      '<form id="name-form"><label class="field"><span>Display name</span>' +
      '<input type="text" id="set-display" maxlength="32" value="' + Ui.esc(u.displayName || '') + '" /></label>' +
      '<button class="btn btn-primary btn-sm" type="submit">Save display name</button></form>' +
      '<hr class="divider" />' +
      '<form id="pw-form"><label class="field"><span>Current password</span>' +
      '<input type="password" id="pw-cur" autocomplete="current-password" /></label>' +
      '<label class="field"><span>New password (6+ characters)</span>' +
      '<input type="password" id="pw-new" autocomplete="new-password" /></label>' +
      '<button class="btn btn-sm" type="submit">Change password</button></form></section>' +

      '<section class="settings-card" aria-labelledby="set-appear"><h2 id="set-appear">Appearance</h2>' +
      '<div class="form-row"><label class="small muted" for="set-theme">Theme</label>' +
      '<select id="set-theme"><option value="dark">Dark</option><option value="light">Light</option></select></div>' +
      '<div class="form-row" style="margin-top:0.6rem"><label class="small muted" for="set-density">Density</label>' +
      '<select id="set-density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div>' +
      '<p class="hint">Saved instantly on this device.</p></section>' +

      '<section class="settings-card" aria-labelledby="set-app"><h2 id="set-app">Application</h2>' +
      '<form id="api-form"><label class="field"><span>Server URL (blank = auto)</span>' +
      '<input type="url" id="set-api" placeholder="http://localhost:9971" value="' + Ui.esc((TrycordState.access && TrycordState.access.apiBase) || '') + '" /></label>' +
      '<div class="form-row"><button class="btn btn-sm" type="submit">Save &amp; reload</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="api-test">Test connection</button>' +
      '<span id="api-status" class="small muted" role="status"></span></div></form>' +
      '<hr class="divider" />' +
      '<div class="form-row"><span class="small muted">Global sync: <b id="global-status">checking…</b></span>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="global-retry">Recheck</button></div>' +
      '<p class="hint">Global sync is optional and never required for chat. ' +
      'Appearance stays on this device; only an explicitly configured global service is contacted.</p>' +
      '<hr class="divider" />' +
      '<div class="form-row"><button class="btn btn-ghost btn-sm" id="clear-local" type="button">Clear favorites &amp; recent</button>' +
      '<button class="btn btn-ghost btn-sm" id="logout-btn2" type="button">Log out</button></div>' +
      '<p class="hint">Trycord web client v0.4.0 · instance-aware access points.</p></section>' +
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
        Ui.toast('Display name saved.', 'good');
      } catch (err) { Ui.toast(err.message, 'bad'); }
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
        Ui.toast('Password changed.', 'good');
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
        Ui.toast('Local data cleared.', 'good');
      }
    };
    document.getElementById('logout-btn2').onclick = () => Trycord.logout();

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
