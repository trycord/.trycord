/* Account: profile overview + two-pane settings (account, appearance,
   application, about). Only real, working controls — nothing decorative. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  var setTab = 'account';

  function settings(root) {
    var u = TrycordState.user;
    var s = TrycordState.settings;
    C.setTopbar('Settings', 'Account, appearance, and application.', '', 'i-cog');
    var cats = [
      ['account', 'Account', 'i-users'],
      ['appearance', 'Appearance', 'i-theme'],
      ['application', 'Application', 'i-globe'],
      ['about', 'About & Updates', 'i-bell'],
    ];
    root.innerHTML =
      '<div class="set-wrap"><nav class="set-cats" aria-label="Settings sections">' +
      cats.map((c) => '<button type="button" class="set-cat' + (setTab === c[0] ? ' active' : '') + '" data-set-tab="' + c[0] + '"' +
        (setTab === c[0] ? ' aria-current="page"' : '') + '>' +
        '<svg aria-hidden="true"><use href="#' + c[2] + '"/></svg>' + Ui.esc(c[1]) + '</button>').join('') +
      '</nav><div class="set-panel" id="set-panel"></div></div>';
    root.querySelectorAll('[data-set-tab]').forEach((b) => {
      b.onclick = () => { setTab = b.dataset.setTab; settings(root); };
    });
    var panel = root.querySelector('#set-panel');
    if (setTab === 'appearance') return appearancePanel(panel, s);
    if (setTab === 'application') return applicationPanel(panel);
    if (setTab === 'about') return aboutPanel(panel);
    return accountPanel(panel, u);
  }

  function accountPanel(panel, u) {
    panel.innerHTML =
      '<h2>Account</h2><p class="lede">Signed in as @' + Ui.esc(u.username) + '.</p>' +
      '<form id="name-form"><div class="form-group"><label class="form-label" for="set-display">Display name</label>' +
      '<input type="text" id="set-display" class="form-input" maxlength="32" value="' + Ui.esc(u.displayName || '') + '" /></div>' +
      '<button class="btn btn-primary btn-sm" type="submit">Save display name</button></form>' +
      '<hr class="divider" />' +
      '<form id="pw-form"><div class="form-group"><label class="form-label" for="pw-cur">Current password</label>' +
      '<input type="password" id="pw-cur" class="form-input" autocomplete="current-password" /></div>' +
      '<div class="form-group"><label class="form-label" for="pw-new">New password (8+ characters)</label>' +
      '<input type="password" id="pw-new" class="form-input" autocomplete="new-password" /></div>' +
      '<span class="form-hint" style="margin:calc(var(--tc-space-2) * -1) 0 var(--tc-space-3);display:block;">Changing your password signs out every other session. This device keeps you logged in.</span>' +
      '<button class="btn btn-secondary btn-sm" type="submit">Change password</button></form>' +
      '<hr class="divider" />' +
      '<div class="set-row"><div class="grow"><strong>Recovery email</strong><small id="email-status">' +
      (u.email ? Ui.esc(u.email) + (u.emailVerified ? ' · verified' : ' · not verified') : 'Not set') +
      '</small></div>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-email-edit>' + (u.email ? 'Change email' : 'Add email') + '</button>' +
      (u.email && !u.emailVerified ? '<button class="btn btn-ghost btn-sm" type="button" data-email-resend>Resend verification</button>' : '') +
      '</div>' +
      '<hr class="divider" />' +
      '<div class="set-row"><div class="grow"><strong>Sessions</strong><small>End sessions you no longer trust.</small></div>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-revoke-other>Sign out other devices</button>' +
      '<button class="btn btn-danger btn-sm" type="button" data-revoke-all>Sign out everywhere</button></div>' +
      '<hr class="divider" />' +
      '<div class="set-row"><div class="grow"><strong>Log out</strong><small>Ends this session on this device.</small></div>' +
      '<button class="btn btn-danger btn-sm" id="logout-btn2" type="button">Log out</button></div>';

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
      ok = Ui.fieldError(neu, neu.value.length >= 8 ? '' : 'New password must be 8+ characters.') && ok;
      if (!ok) return;
      var btn = document.querySelector('#pw-form button[type="submit"]');
      Ui.setLoading(btn, true, 'Saving…');
      try {
        // The secure endpoint invalidates old sessions and returns a fresh
        // token; swap to it so THIS device stays logged in.
        var r = await TrycordApi.changePassword({ currentPassword: cur.value, newPassword: neu.value });
        TrycordApi.token = r.token;
        TrycordState.user = r.user;
        C.renderUser();
        cur.value = '';
        neu.value = '';
        Ui.toast('Password changed. Other sessions were signed out.', 'success');
      } catch (err) {
        Ui.fieldError(cur, err.message);
      } finally {
        Ui.setLoading(btn, false);
      }
    });

    // The account tab shows email recovery state, which lives on /me (private).
    window.TrycordApi.me().then(function (me) {
      if (!me) return;
      TrycordState.user = Object.assign({}, TrycordState.user, me);
      var st = document.getElementById('email-status');
      if (st) st.textContent = me.email
        ? me.email + (me.emailVerified ? ' · verified' : ' · not verified')
        : 'Not set';
      var edit = panel.querySelector('[data-email-edit]');
      if (edit) edit.textContent = me.email ? 'Change email' : 'Add email';
    }).catch(() => {});

    var emailEdit = panel.querySelector('[data-email-edit]');
    if (emailEdit) emailEdit.onclick = () => emailModal();
    var emailResend = panel.querySelector('[data-email-resend]');
    if (emailResend) emailResend.onclick = async () => {
      try {
        var curEmail = (TrycordState.user && TrycordState.user.email) || '';
        await TrycordApi.resendVerification({ email: curEmail });
        Ui.toast('Verification email sent.', 'success');
      } catch (err) { Ui.toast(err.message, 'error'); }
    };
    panel.querySelector('[data-revoke-other]').onclick = async () => {
      var yes = await Ui.confirmDialog({
        title: 'Sign out other devices?',
        message: 'Every session except this one will be ended immediately.',
        confirmText: 'Sign out others',
      });
      if (!yes) return;
      try {
        var r = await TrycordApi.revokeOtherSessions();
        TrycordApi.token = r.token;
        TrycordState.user = r.user;
        C.renderUser();
        Ui.toast('Other sessions signed out.', 'success');
      } catch (err) { Ui.toast(err.message, 'error'); }
    };
    panel.querySelector('[data-revoke-all]').onclick = async () => {
      var yes = await Ui.confirmDialog({
        title: 'Sign out everywhere?',
        message: 'This device and every other session will be signed out.',
        confirmText: 'Sign out everywhere',
        danger: true,
      });
      if (!yes) return;
      try {
        await TrycordApi.revokeAllSessions();
      } catch (err) { /* token may already be dead */ }
      TrycordApi.token = null;
      TrycordState.user = null;
      location.hash = '#/login';
      Ui.toast('Signed out everywhere.', 'success');
    };
    document.getElementById('logout-btn2').onclick = () => Trycord.logout();

    function emailModal() {
      var body = document.createElement('div');
      body.innerHTML =
        '<p class="text-muted text-sm">Used only for password resets and security notices.</p>' +
        '<div class="form-group"><label class="form-label" for="em-email">New recovery email</label>' +
        '<input type="email" id="em-email" class="form-input" autocomplete="email" /></div>' +
        '<div class="form-group"><label class="form-label" for="em-pass">Current password</label>' +
        '<input type="password" id="em-pass" class="form-input" autocomplete="current-password" /></div>';
      Ui.openModal({
        title: (u.email ? 'Change recovery email' : 'Add recovery email'),
        body,
        actions: [{ id: 'cancel', label: 'Cancel' }, {
          id: 'save', label: 'Send verification email', primary: true,
          onClick: (close) => {
            var emailEl = body.querySelector('#em-email');
            var passEl = body.querySelector('#em-pass');
            var email = emailEl.value.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              Ui.fieldError(emailEl, 'Enter a valid email address.');
              return;
            }
            if (!passEl.value) { Ui.fieldError(passEl, 'Enter your current password.'); return; }
            TrycordApi.changeEmail({ currentPassword: passEl.value, newEmail: email })
              .then(() => {
                close();
                Ui.toast('Verification email sent to ' + email + '.', 'success');
              })
              .catch((err) => Ui.toast(err.message, 'error'));
          },
        }],
      });
      setTimeout(() => body.querySelector('#em-email').focus(), 0);
    }
  }

  function appearancePanel(panel, s) {
    var theme = document.documentElement.getAttribute('data-theme') || s.theme || 'dark';
    panel.innerHTML =
      '<h2>Appearance</h2><p class="lede">Saved instantly on this device.</p>' +
      '<div class="set-row"><div class="grow"><strong>Theme</strong><small>Dark is the default. High contrast boosts borders and text.</small></div>' +
      '<select id="set-theme" class="form-input" style="width:auto;" aria-label="Theme">' +
      ['dark', 'light', 'high-contrast'].map((t) => '<option value="' + t + '"' + (theme === t ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select></div>' +
      '<div class="set-row"><div class="grow"><strong>Density</strong><small>Comfortable spacing, or compact for smaller screens.</small></div>' +
      '<select id="set-density" class="form-input" style="width:auto;" aria-label="Density">' +
      ['comfortable', 'compact'].map((d) => '<option value="' + d + '"' + ((s.density || 'comfortable') === d ? ' selected' : '') + '>' + d + '</option>').join('') +
      '</select></div>' +
      '<div class="set-row"><div class="grow"><strong>Text size</strong><small>Scales the whole interface.</small></div>' +
      '<select id="set-font" class="form-input" style="width:auto;" aria-label="Text size">' +
      [['14', 'Small'], ['16', 'Default'], ['18', 'Large']].map((o) => {
        var cur = '16';
        try { cur = localStorage.getItem('trycord-font-scale') || '16'; } catch (e) {}
        return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="set-row"><div class="grow"><strong>Motion</strong><small>Turn off interface animation.</small></div>' +
      '<label class="form-check"><input type="checkbox" id="set-motion" class="form-check-input"' +
      (document.documentElement.getAttribute('data-motion') === 'off' ? ' checked' : '') + ' />' +
      '<span class="form-check-label">Reduce motion</span></label></div>';

    document.getElementById('set-theme').addEventListener('change', (e) => {
      TrycordState.settings.theme = e.target.value;
      TrycordState.saveSettings();
      try { localStorage.setItem('trycord-theme', e.target.value); } catch (err) {}
      document.documentElement.setAttribute('data-theme', e.target.value);
    });
    document.getElementById('set-density').addEventListener('change', (e) => {
      TrycordState.settings.density = e.target.value;
      TrycordState.saveSettings();
    });
    document.getElementById('set-font').addEventListener('change', (e) => {
      try { localStorage.setItem('trycord-font-scale', e.target.value); } catch (err) {}
      document.documentElement.style.fontSize = e.target.value + 'px';
    });
    document.getElementById('set-motion').addEventListener('change', (e) => {
      document.documentElement.toggleAttribute('data-motion', false);
      if (e.target.checked) document.documentElement.setAttribute('data-motion', 'off');
      else document.documentElement.removeAttribute('data-motion');
    });
  }

  function applicationPanel(panel) {
    panel.innerHTML =
      '<h2>Application</h2><p class="lede">Connection, sync, and local data.</p>' +
      '<form id="api-form"><div class="form-group"><label class="form-label" for="set-api">Server URL (blank = auto)</label>' +
      '<input type="url" id="set-api" class="form-input" placeholder="http://localhost:9971" value="' + Ui.esc((TrycordState.access && TrycordState.access.apiBase) || '') + '" /></div>' +
      '<div style="display: flex; gap: var(--tc-space-3); align-items: center; flex-wrap:wrap;"><button class="btn btn-secondary btn-sm" type="submit">Save &amp; reload</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="api-test">Test connection</button>' +
      '<span id="api-status" class="text-sm text-muted" role="status"></span></div></form>' +
      '<hr class="divider" />' +
      '<div class="set-row"><div class="grow"><strong>Global sync</strong><small>Optional and never required for chat. <span id="global-status">checking…</span></small></div>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="global-retry">Recheck</button></div>' +
      '<div class="set-row"><div class="grow"><strong>Local data</strong><small>Favorites and recents stored on this device.</small></div>' +
      '<button class="btn btn-ghost btn-sm" id="clear-local" type="button">Clear favorites &amp; recent</button></div>';

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

  function aboutPanel(panel) {
    var ver = (window.trycordDesktop && window.trycordDesktop.version) || 'web client';
    panel.innerHTML =
      '<h2>About &amp; Updates</h2>' +
      '<p class="lede"><b id="about-version">Trycord ' + Ui.esc(ver) + '</b> — a self-hostable community chat platform.</p>' +
      '<p style="display:flex;gap:var(--tc-space-2);flex-wrap:wrap;margin:0 0 var(--tc-space-5);">' +
      '<a class="btn btn-ghost btn-sm" href="https://github.com/LanxTheShowmaker/.trycord" target="_blank" rel="noopener">Source code</a>' +
      '<a class="btn btn-ghost btn-sm" href="https://github.com/LanxTheShowmaker/.trycord#readme" target="_blank" rel="noopener">Documentation</a>' +
      '<a class="btn btn-ghost btn-sm" href="https://github.com/LanxTheShowmaker/.trycord/issues" target="_blank" rel="noopener">Report a problem</a></p>' +
      '<div class="form-group"><label class="form-label" for="upd-channel">Release channel</label>' +
      '<select id="upd-channel" class="form-input" style="width:auto;"><option value="latest">Stable</option><option value="beta">Beta</option></select></div>' +
      '<div class="form-check" style="margin-bottom:var(--tc-space-3);"><input type="checkbox" id="upd-auto" class="form-check-input" checked />' +
      '<label class="form-check-label" for="upd-auto">Automatically install updates</label></div>' +
      '<div style="display:flex;gap:var(--tc-space-3);align-items:center;flex-wrap:wrap;">' +
      '<button class="btn btn-secondary btn-sm" type="button" id="upd-check">Check for updates</button>' +
      '<span id="upd-status" class="text-sm text-muted" role="status">Last checked: never</span></div>' +
      '<div class="progress" id="upd-progress" hidden style="margin-top:var(--tc-space-3);"><div class="progress-bar" id="upd-bar" style="width:0%;"></div></div>' +
      '<p class="text-muted text-sm" style="margin-top:var(--tc-space-3);">Desktop updates are delivered by the installed Trycord app. This web view checks through the desktop bridge when available.</p>';
    wireUpdater(panel);
  }

  function wireUpdater(panel) {
    var bridge = (window.trycordDesktop && window.trycordDesktop.updater) || null;
    var ver = (window.trycordDesktop && window.trycordDesktop.version) || 'web client';
    var status = panel.querySelector('#upd-status');
    var bar = panel.querySelector('#upd-bar');
    var prog = panel.querySelector('#upd-progress');
    var checkBtn = panel.querySelector('#upd-check');
    var autoBox = panel.querySelector('#upd-auto');
    var chanSel = panel.querySelector('#upd-channel');
    var about = panel.querySelector('#about-version');
    if (about) about.textContent = 'Trycord ' + ver;
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
        ['Provider', ev.provider || 'github'],
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
  }

  window.TrycordPagesAccount = { settings };
})();
