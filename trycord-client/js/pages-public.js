/* Public pages: landing, login, register. Plain language, no hype. */
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
      '<a class="btn btn-primary btn-lg" href="#/register">Get started</a>' +
      '<a class="btn btn-secondary btn-lg" href="#/login">Log in</a>' +
      '</div></section>' +
      '<section class="feature-grid" aria-label="Features">' +
      '<div class="feature"><h3>Your server, your rules</h3><p>Create servers with invite codes, manage members, and control visibility.</p></div>' +
      '<div class="feature"><h3>Real-time chat</h3><p>Channel-based messaging delivered instantly over WebSockets.</p></div>' +
      '<div class="feature"><h3>Direct messages</h3><p>Private one-to-one conversations with friends, plus friend requests.</p></div>' +
      '<div class="feature"><h3>Discover</h3><p>List public servers so new members can find and join them.</p></div>' +
      '<div class="feature"><h3>Roles &amp; permissions</h3><p>Moderate with granular per-server permissions.</p></div>' +
      '<div class="feature"><h3>Desktop app</h3><p>Run the same client as a desktop window with automatic updates.</p></div>' +
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
      '<p class="auth-alt muted"><a href="#/forgot-password">Forgot your password?</a></p>' +
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
        await Trycord.refreshSocial();
        location.hash = '#/home';
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.fieldError(p, err.message);
      }
    });
  }

  var legalPromise = null;
  function legal() {
    if (!legalPromise) legalPromise = TrycordApi.legal().catch(() => null);
    return legalPromise;
  }

  function register(root) {
    root.innerHTML =
      '<div class="auth-wrap"><h1>Create your account</h1>' +
      '<p class="muted">Pick a username — you can change your display name later.</p>' +
      '<form id="reg-form" novalidate>' +
      '<label class="field"><span>Username</span><input type="text" id="rg-user" autocomplete="username" maxlength="32" /></label>' +
      '<label class="field"><span>Password (8+ characters)</span><input type="password" id="rg-pass" autocomplete="new-password" /></label>' +
      '<div id="rg-legal" class="auth-legal" aria-live="polite">' +
      '<p class="muted">Loading the current terms…</p></div>' +
      '<button class="btn btn-primary btn-block" type="submit" id="rg-btn">Create account</button>' +
      '</form>' +
      '<p class="auth-alt muted">Have an account? <a href="#/login">Log in</a></p>' +
      C.serverSwitcher() + '</div>';
    C.wireServerSwitcher(root);

    var legalInfo = null;
    // Records consent against the exact versions the server enforces.
    legal().then(function (l) {
      legalInfo = l || {};
      var box = document.getElementById('rg-legal');
      if (!box) return;
      var tv = (l && l.termsVersion) || '—';
      var pv = (l && l.privacyVersion) || '—';
      var updated = (l && l.updated) || '';
      box.innerHTML =
        '<span class="auth-legal-label">Required</span>' +
        '<label class="form-check"><input type="checkbox" id="rg-terms" class="form-check-input" autocomplete="off" />' +
        '<span class="form-check-label">I agree to the Terms of Service (version ' + Ui.esc(tv) + (updated ? ', updated ' + Ui.esc(updated) : '') + ')</span></label>' +
        '<label class="form-check" style="margin-top:var(--tc-space-2);"><input type="checkbox" id="rg-privacy" class="form-check-input" autocomplete="off" />' +
        '<span class="form-check-label">I agree to the Privacy Policy (version ' + Ui.esc(pv) + (updated ? ', updated ' + Ui.esc(updated) : '') + ')</span></label>' +
        '<p class="form-hint">Your agreement is recorded with the version you saw at signup.</p>';
    }).catch(function () {
      var box = document.getElementById('rg-legal');
      if (box) box.innerHTML = '<p class="muted">Could not load the current terms. Please try again.</p>';
    });

    document.getElementById('reg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var u = document.getElementById('rg-user');
      var p = document.getElementById('rg-pass');
      var ok = Ui.fieldError(u, /^[A-Za-z0-9_.]{2,32}$/.test(u.value.trim())
        ? '' : '2-32 chars: letters, numbers, _ or .');
      ok = Ui.fieldError(p, p.value.length >= 8 ? '' : 'Password must be 8+ characters.') && ok;
      var t = document.getElementById('rg-terms');
      var pr = document.getElementById('rg-privacy');
      if (t && !t.checked) {
        Ui.fieldError(t, 'You must accept the Terms of Service.');
        ok = false;
      }
      if (pr && !pr.checked) {
        Ui.fieldError(pr, 'You must accept the Privacy Policy.');
        ok = false;
      }
      if (!legalInfo || !legalInfo.termsVersion || !legalInfo.privacyVersion) {
        uiShowLegalFail();
        ok = false;
      }
      if (!ok) return;
      var btn = document.getElementById('rg-btn');
      Ui.setLoading(btn, true, 'Creating…');
      try {
        var r = await TrycordApi.register({
          username: u.value.trim(),
          password: p.value,
          termsVersion: legalInfo.termsVersion,
          privacyVersion: legalInfo.privacyVersion,
        });
        TrycordApi.token = r.token;
        TrycordState.user = r.user;
        await Trycord.refreshServers();
        await Trycord.refreshSocial();
        Ui.toast('Account created — welcome to Trycord.', 'success');
        location.hash = '#/home';
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.fieldError(u, err.message);
      }
    });

    function uiShowLegalFail() {
      var box = document.getElementById('rg-legal');
      if (box) box.innerHTML = '<p class="text-danger">Terms could not be loaded from the server. Please try again.</p>';
    }
  }

  // Request a password reset by recovery email. The response is generic
  // (the server never reveals whether an account exists), so the page
  // always shows the hopeful message.
  function forgotPassword(root) {
    root.innerHTML =
      '<div class="auth-wrap"><h1>Reset your password</h1>' +
      '<p class="muted">Enter your recovery email and we\'ll send a reset link.</p>' +
      '<form id="fg-form" novalidate>' +
      '<label class="field"><span>Recovery email</span><input type="email" id="fg-email" autocomplete="email" /></label>' +
      '<button class="btn btn-primary btn-block" type="submit" id="fg-btn">Send reset link</button>' +
      '</form>' +
      '<p class="auth-alt muted"><a href="#/login">Back to login</a></p>' +
      C.serverSwitcher() + '</div>';
    C.wireServerSwitcher(root);

    document.getElementById('fg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var em = document.getElementById('fg-email');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.value.trim())) {
        Ui.fieldError(em, 'Enter a valid email address.');
        return;
      }
      var btn = document.getElementById('fg-btn');
      Ui.setLoading(btn, true, 'Sending…');
      try {
        var r = await TrycordApi.forgotPassword({ email: em.value.trim() });
        root.innerHTML =
          '<div class="auth-wrap"><h1>Check your email</h1>' +
          '<p class="muted">' + Ui.esc((r && r.message) || 'If an account exists for that email, a reset link is on its way.') + '</p>' +
          '<p class="auth-alt muted"><a href="#/login">Back to login</a></p>' +
          C.serverSwitcher() + '</div>';
        C.wireServerSwitcher(root);
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.fieldError(em, err.message);
      }
    });
  }

  // Set a new password from a single-use reset token. Returns a fresh
  // session, so success drops the user straight into the app.
  function resetPassword(root, token) {
    if (!token) {
      location.hash = '#/forgot-password';
      return;
    }
    root.innerHTML =
      '<div class="auth-wrap"><h1>Choose a new password</h1>' +
      '<p class="muted">At least 8 characters. Other sessions will be signed out.</p>' +
      '<form id="rp-form" novalidate>' +
      '<label class="field"><span>New password</span><input type="password" id="rp-pass1" autocomplete="new-password" /></label>' +
      '<label class="field"><span>Confirm password</span><input type="password" id="rp-pass2" autocomplete="new-password" /></label>' +
      '<button class="btn btn-primary btn-block" type="submit" id="rp-btn">Set new password</button>' +
      '</form>' +
      '<p class="auth-alt muted"><a href="#/login">Back to login</a></p>' +
      C.serverSwitcher() + '</div>';
    C.wireServerSwitcher(root);

    document.getElementById('rp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var p1 = document.getElementById('rp-pass1');
      var p2 = document.getElementById('rp-pass2');
      var ok = Ui.fieldError(p1, p1.value.length >= 8 ? '' : 'Password must be 8+ characters.');
      ok = Ui.fieldError(p2, p2.value === p1.value ? '' : 'Passwords do not match.') && ok;
      if (!ok) return;
      var btn = document.getElementById('rp-btn');
      Ui.setLoading(btn, true, 'Setting…');
      try {
        var r = await TrycordApi.resetPassword({ token: token, newPassword: p1.value });
        TrycordApi.token = r.token;
        TrycordState.user = r.user;
        await Trycord.refreshServers();
        await Trycord.refreshSocial();
        Ui.toast('Password reset — welcome back.', 'success');
        location.hash = '#/home';
      } catch (err) {
        Ui.setLoading(btn, false);
        Ui.fieldError(p1, err.message);
      }
    });
  }

  // Confirm a recovery email from the single-use link in the mail.
  function verifyEmail(root, token) {
    root.innerHTML =
      '<div class="auth-wrap"><h1>Verifying your email…</h1><p class="muted">One moment.</p></div>' +
      C.serverSwitcher();
    C.wireServerSwitcher(root);
    if (!token) {
      root.querySelector('.auth-wrap').innerHTML =
        '<h1>Verification link missing</h1><p class="muted">This link needs its token. Open it from the email you received.</p>' +
        '<p class="auth-alt muted"><a href="#/login">Back to login</a></p>';
      return;
    }
    TrycordApi.verifyEmail({ token: token })
      .then(() => {
        root.innerHTML =
          '<div class="auth-wrap"><h1>Email verified</h1>' +
          '<p class="muted">Thanks! Your recovery email is confirmed.</p>' +
          '<a class="btn btn-primary btn-block" href="#/home">Continue</a></div>' +
          C.serverSwitcher();
        C.wireServerSwitcher(root);
      })
      .catch((err) => {
        root.innerHTML =
          '<div class="auth-wrap"><h1>Verification failed</h1>' +
          '<p class="muted">' + Ui.esc(err.message) + '</p>' +
          '<p class="auth-alt muted"><a href="#/login">Back to login</a></p></div>' +
          C.serverSwitcher();
        C.wireServerSwitcher(root);
      });
  }

  window.TrycordPagesPublic = { landing, login, register, forgotPassword, resetPassword, verifyEmail };
})();
