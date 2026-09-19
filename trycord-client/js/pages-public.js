/* Public pages: landing, login, register. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  function landing(root) {
    C.setTopbar('', '', '');
    root.innerHTML =
      '<section class="hero">' +
      '<h1>Community chat, <span class="accent">self-hosted</span>.</h1>' +
      '<p class="lead">Trycord is a real-time chat platform you run yourself: ' +
      'create servers, organize channels, and talk — no cloud account required.</p>' +
      '<div class="hero-cta">' +
      '<a class="btn btn-primary" href="#/register">Get started</a>' +
      '<a class="btn btn-ghost" href="#/login">Log in</a>' +
      '</div></section>' +
      '<section class="feature-grid" aria-label="Features">' +
      '<div class="feature"><h3>🛡 Your server, your rules</h3><p>Create servers with invite codes, manage members, and control visibility.</p></div>' +
      '<div class="feature"><h3>⚡ Real-time chat</h3><p>Channel-based messaging delivered instantly over WebSockets.</p></div>' +
      '<div class="feature"><h3>◌ Discover</h3><p>List public servers so new members can find and join them.</p></div>' +
      '<div class="feature"><h3>🖥 Desktop app</h3><p>Run the same client as a native-style desktop window via Electron.</p></div>' +
      '</section>';
  }

  function login(root) {
    root.innerHTML =
      '<div class="auth-wrap"><h1>Welcome back</h1>' +
      '<p class="muted">Log in to open your Trycord home.</p>' +
      '<form id="login-form" novalidate>' +
      '<label class="field"><span>Username</span><input type="text" id="li-user" autocomplete="username" /></label>' +
      '<label class="field"><span>Password</span><input type="password" id="li-pass" autocomplete="current-password" /></label>' +
      '<button class="btn btn-primary btn-block" type="submit" id="li-btn">Log in</button>' +
      '</form>' +
      '<p class="auth-alt muted">No account? <a href="#/register">Create one</a></p>' +
      C.serverSwitcher() +
      '<p class="auth-alt small muted">Running your own server? <code>npm run seed</code> in trycord-server creates a demo login.</p></div>';
    C.wireServerSwitcher(root);

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var u = document.getElementById('li-user');
      var p = document.getElementById('li-pass');
      var ok = Ui.fieldError(u, u.value.trim() ? '' : 'Enter your username.');
      ok = Ui.fieldError(p, p.value ? '' : 'Enter your password.') && ok;
      if (!ok) return;
      var btn = document.getElementById('li-btn');
      Ui.setLoading(btn, true, 'Logging in…');
      try {
        var r = await TrycordApi.login({ username: u.value.trim(), password: p.value });
        TrycordApi.token = r.token;
        TrycordState.user = r.user;
        await Trycord.refreshServers();
        location.hash = '#/home';
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.fieldError(p, err.message);
      }
    });
  }

  function register(root) {
    root.innerHTML =
      '<div class="auth-wrap"><h1>Create your account</h1>' +
      '<p class="muted">Pick a username — you can change your display name later.</p>' +
      '<form id="reg-form" novalidate>' +
      '<label class="field"><span>Username</span><input type="text" id="rg-user" autocomplete="username" maxlength="32" /></label>' +
      '<label class="field"><span>Password (6+ characters)</span><input type="password" id="rg-pass" autocomplete="new-password" /></label>' +
      '<button class="btn btn-primary btn-block" type="submit" id="rg-btn">Create account</button>' +
      '</form>' +
      '<p class="auth-alt muted">Have an account? <a href="#/login">Log in</a></p>' +
      C.serverSwitcher() + '</div>';
    C.wireServerSwitcher(root);

    document.getElementById('reg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var u = document.getElementById('rg-user');
      var p = document.getElementById('rg-pass');
      var ok = Ui.fieldError(u, /^[A-Za-z0-9_.]{2,32}$/.test(u.value.trim())
        ? '' : '2-32 chars: letters, numbers, _ or .');
      ok = Ui.fieldError(p, p.value.length >= 6 ? '' : 'Password must be 6+ characters.') && ok;
      if (!ok) return;
      var btn = document.getElementById('rg-btn');
      Ui.setLoading(btn, true, 'Creating…');
      try {
        var r = await TrycordApi.register({ username: u.value.trim(), password: p.value });
        TrycordApi.token = r.token;
        TrycordState.user = r.user;
        await Trycord.refreshServers();
        Ui.toast('Account created — welcome to Trycord.', 'good');
        location.hash = '#/home';
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.fieldError(u, err.message);
      }
    });
  }

  window.TrycordPagesPublic = { landing, login, register };
})();
