// The site's sign-in door.
//
// The form asks the instance for a session and then hands the reader to the
// application with that session already in place. The token is filed under the
// API's origin, which is the key the client reads - no token ever travels in
// the address bar, and a shared link cannot carry somebody else's session.
//
// The two calls are the same ones the application's own gate makes, so a
// second factor is met with the same challenge here. A reader who is already
// signed in is offered the app instead of a second form, and can still choose
// another account.

(function () {
  'use strict';

  var Api = window.TrycordApi;
  var form = document.querySelector('[data-login-form]');
  if (!form || !Api || typeof Api.signIn !== 'function') return;

  var alertBox = form.querySelector('[data-login-alert]');
  var username = form.querySelector('input[name="username"]');
  var password = form.querySelector('input[name="password"]');
  var code = form.querySelector('input[name="code"]');
  var codeField = form.querySelector('[data-code-field]');
  var submit = form.querySelector('[data-submit]');
  var toggle = form.querySelector('[data-password-toggle]');
  var already = document.querySelector('[data-already]');
  var switchButton = document.querySelector('[data-switch]');
  var continueLink = document.querySelector('[data-continue]');
  var instanceNames = Array.prototype.slice.call(document.querySelectorAll('[data-instance-name]'));

  var challenge = null;
  var busy = false;
  var next = readNext();

  function readNext() {
    try {
      var value = new URLSearchParams(window.location.search).get('next') || '';
      // A next target is a path on this site, never another origin. `//host`
      // is a protocol-relative address to somewhere else, so it is refused
      // with everything that is not rooted.
      if (!value || value.charAt(0) !== '/' || value.slice(0, 2) === '//') return '';
      return value;
    } catch (e) { return ''; }
  }

  function say(text, tone) {
    if (!alertBox) return;
    alertBox.textContent = text;
    alertBox.setAttribute('data-tone', tone || 'error');
    alertBox.hidden = false;
  }

  function hush() {
    if (!alertBox) return;
    alertBox.textContent = '';
    alertBox.hidden = true;
  }

  function setBusy(value) {
    busy = value;
    if (submit) {
      submit.disabled = value;
      submit.setAttribute('aria-busy', value ? 'true' : 'false');
    }
  }

  // The address inside the application, from a route the site was given. A
  // next value that already carries the mount is reduced to the route first,
  // so a mounted address and the route it carries mean the same page.
  function appAddress() {
    return Api.appBase().then(function (base) {
      var wanted = next;
      var mount = '';
      try { mount = new URL(base, window.location.href).pathname.replace(/\/+$/, ''); } catch (e) { mount = ''; }
      if (mount && wanted && (wanted === mount || wanted.indexOf(mount + '/') === 0)) {
        wanted = wanted.slice(mount.length) || '/';
      }
      return Api.appHref(String(wanted).replace(/^\/+/, ''));
    });
  }

  function finish(answer) {
    if (!answer || !answer.token) {
      say('The instance did not return a session. Try signing in again.', 'error');
      setBusy(false);
      return;
    }
    Api.rememberSession(answer.token).then(function (stored) {
      if (!stored) {
        say('This browser blocked local storage, so the session could not be kept. '
          + 'Allow storage for this site, then try again.', 'error');
        setBusy(false);
        return;
      }
      return appAddress().then(function (href) {
        window.location.assign(href);
      });
    }).catch(function () {
      say('The session was created, but the app could not be opened. Try again.', 'error');
      setBusy(false);
    });
  }

  // A second-factor step belongs to one password attempt. Changing the account
  // or the password makes it stale, so it is dropped rather than sent with
  // details it was not minted for.
  function dropChallenge() {
    challenge = null;
    if (codeField) codeField.hidden = true;
    if (code) {
      code.value = '';
      code.required = false;
    }
    if (submit) submit.textContent = 'Sign in';
  }

  function restorePasswordStep() {
    dropChallenge();
    hush();
    if (password) password.focus();
  }

  username.addEventListener('input', function () {
    if (!challenge) return;
    dropChallenge();
    hush();
  });
  password.addEventListener('input', function () {
    if (!challenge) return;
    dropChallenge();
    hush();
  });

  if (toggle && password) {
    toggle.addEventListener('click', function () {
      var showing = password.type === 'text';
      password.type = showing ? 'password' : 'text';
      toggle.textContent = showing ? 'Show' : 'Hide';
      toggle.setAttribute('aria-pressed', showing ? 'false' : 'true');
      password.focus();
    });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;

    var wantedUser = String(username.value || '').trim();
    var wantedPassword = String(password.value || '');
    if (!wantedUser) {
      say('Enter the username or email address for your account.', 'error');
      username.focus();
      return;
    }
    if (!wantedPassword && !challenge) {
      say('Enter the password for your account.', 'error');
      password.focus();
      return;
    }

    setBusy(true);
    hush();
    try {
      if (challenge) {
        var entered = String(code.value || '').replace(/\s+/g, '');
        if (!entered) {
          say('Enter the six-digit code from your authenticator app, or a recovery code.', 'error');
          code.focus();
          setBusy(false);
          return;
        }
        var verified = await Api.verifySecondFactor({ challengeToken: challenge, code: entered });
        finish(verified);
        return;
      }

      var answer = await Api.signIn({ username: wantedUser, password: wantedPassword });
      if (answer && answer.mfaRequired) {
        challenge = answer.challengeToken;
        if (codeField) codeField.hidden = false;
        if (code) {
          code.required = true;
          code.value = '';
          code.focus();
        }
        if (submit) submit.textContent = 'Verify and continue';
        say('Your account has a second factor. Enter the code from your authenticator app to continue.', 'info');
        setBusy(false);
        return;
      }
      finish(answer);
    } catch (error) {
      if (challenge && error && error.code === 'CHALLENGE_EXPIRED') {
        restorePasswordStep();
        say(error.message || 'That code window closed. Sign in again to get a fresh one.', 'error');
        setBusy(false);
        return;
      }
      say((error && error.message) || 'We could not sign you in. Check the details and try again.', 'error');
      setBusy(false);
      if (!challenge && password) password.focus();
    }
  });

  /* ---- the reader who already has a session -------------------------------
     The session is the same one the application reads, so the site does not
     ask for a password again. The form stays one action away, for switching
     accounts on a shared device. */
  if (already && switchButton) {
    switchButton.addEventListener('click', function () {
      already.hidden = true;
      form.hidden = false;
      if (username) username.focus();
    });
    Api.signedIn().then(function (signedIn) {
      if (!signedIn) return;
      already.hidden = false;
      form.hidden = true;
      if (continueLink) {
        appAddress().then(function (href) { continueLink.setAttribute('href', href); })
          .catch(function () { /* the markup's fallback still resolves through the site */ });
      }
    }).catch(function () { /* the form is the safe answer */ });
  }

  /* ---- the instance's own name --------------------------------------------
     The reader is signing in to an instance, not to abstract software. The
     name comes from the instance and is left as the fallback if it cannot
     answer, so a slow API never holds the form hostage. */
  if (instanceNames.length && typeof Api.instance === 'function') {
    Api.instance().then(function (info) {
      var name = info && info.name ? String(info.name) : '';
      if (!name) return;
      instanceNames.forEach(function (node) { node.textContent = name; });
    }).catch(function () { /* the fallback stands */ });
  }
})();
