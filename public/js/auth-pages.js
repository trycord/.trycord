// The public site's account gate.
//
// One script draws the four screens that have no workspace behind them:
// creating an account, asking for a recovery link, applying a reset, and
// confirming an address. They are the same calls the application's gate
// makes, so a reader never has to leave the site to finish a sign-up or
// recover an account.
//
// The token in a recovery or verification link is read from the path, never
// copied into another address on the page. It stays in memory and goes only
// to the endpoint it belongs to. Nothing here mints a token or writes one into
// a URL.

(function () {
  'use strict';

  var Api = window.TrycordApi;
  var page = document.querySelector('[data-auth-page]');
  if (!page || !Api) return;

  var kind = page.getAttribute('data-auth-page');

  function find(selector, root) {
    return (root || page).querySelector(selector);
  }

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function say(box, text, tone) {
    if (!box) return;
    box.textContent = text;
    box.setAttribute('data-tone', tone || 'error');
    box.hidden = false;
  }

  function hush(box) {
    if (!box) return;
    box.textContent = '';
    box.hidden = true;
  }

  function setBusy(button, value) {
    if (!button) return;
    button.disabled = value;
    button.setAttribute('aria-busy', value ? 'true' : 'false');
  }

  function focus(node) {
    if (node && typeof node.focus === 'function') node.focus();
  }

  function reveal(node) {
    if (!node) return;
    node.hidden = false;
    focus(node);
  }

  function messageOf(error, fallback) {
    return (error && error.message) || fallback;
  }

  function readToken(segment) {
    try {
      var path = String(window.location.pathname || '');
      var prefix = '/' + segment + '/';
      if (path.indexOf(prefix) !== 0) return '';
      var raw = path.slice(prefix.length).replace(/\/+$/, '');
      if (!raw || raw.indexOf('/') !== -1) return '';
      return decodeURIComponent(raw);
    } catch (e) {
      return '';
    }
  }

  function appAddress(route) {
    return Api.appHref(String(route || '').replace(/^\/+/, ''));
  }

  function openApp(route) {
    return appAddress(route).then(function (href) {
      window.location.assign(href);
    });
  }

  function byteLength(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
    try { return unescape(encodeURIComponent(value)).length; } catch (e) { return value.length; }
  }

  function passwordProblem(value) {
    if (typeof value !== 'string' || value.length < 8) {
      return 'Use at least 8 characters for the password. A long passphrase works well.';
    }
    if (byteLength(value) > 72) {
      return 'That password is longer than passwords here can keep. Trim it a little and try again.';
    }
    return '';
  }

  function emailLooksValid(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
  }

  // The password field's Show/Hide control. The button names the field it
  // controls, so this works for every form on the site rather than knowing
  // which id a page happened to use.
  function installPasswordToggle(button) {
    if (!button) return;
    var id = button.getAttribute('aria-controls');
    var input = id ? document.getElementById(id) : null;
    if (!input) return;
    button.addEventListener('click', function () {
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.textContent = showing ? 'Show' : 'Hide';
      button.setAttribute('aria-pressed', showing ? 'false' : 'true');
      focus(input);
    });
  }

  function resolveAppLinks() {
    var links = all('[data-app-link]');
    if (!links.length) return;
    appAddress('').then(function (href) {
      links.forEach(function (link) { link.setAttribute('href', href); });
    }).catch(function () { /* the markup's fallback still resolves */ });
  }

  function remember(answer, alertBox) {
    return Api.rememberSession(answer.token).then(function (stored) {
      if (stored) return true;
      say(alertBox,
        'This browser blocked local storage, so the session could not be kept. '
        + 'Allow storage for this site, then try again.', 'error');
      return false;
    });
  }

  // -- creating an account ----------------------------------------------------

  function setupRegister() {
    var form = find('[data-register-form]');
    if (!form) return;

    var closed = find('[data-register-closed]');
    var done = find('[data-register-done]');
    var doneTitle = find('[data-register-done-title]');
    var doneText = find('[data-register-done-text]');
    var continueLink = find('[data-register-continue]');
    var signOut = find('[data-register-signout]');
    var alertBox = find('[data-register-alert]');
    var approvalNote = find('[data-approval-note]');
    var username = form.querySelector('input[name="username"]');
    var displayName = form.querySelector('input[name="displayName"]');
    var email = form.querySelector('input[name="email"]');
    var emailOptional = find('[data-email-optional]');
    var emailHint = find('[data-email-hint]');
    var password = form.querySelector('input[name="password"]');
    var confirm = form.querySelector('input[name="confirm"]');
    var accepted = form.querySelector('[data-legal-accepted]');
    var versions = find('[data-legal-versions]');
    var retry = find('[data-legal-retry]');
    var submitNote = find('[data-submit-note]');
    var submit = find('[data-submit]');
    var instanceNames = all('[data-instance-name]');
    var legal = null;
    var busy = false;

    installPasswordToggle(find('[data-password-toggle]'));

    function syncSubmit() {
      var ready = !!legal && !!accepted && !!accepted.checked;
      if (submit) submit.disabled = !ready || busy;
      if (!submitNote) return;
      if (!legal) {
        submitNote.textContent = 'The terms in force could not be loaded. Check again before creating an account.';
      } else if (!accepted || !accepted.checked) {
        submitNote.textContent = 'Accept the Terms of Service and the Privacy Policy to create an account.';
      } else {
        submitNote.textContent = '';
      }
    }

    function paintVersions(info) {
      legal = info && info.termsVersion && info.privacyVersion ? info : null;
      if (!versions) return;
      if (!legal) {
        versions.textContent = 'This instance has not said which terms are in force.';
        versions.classList.add('is-missing');
      } else {
        versions.textContent = 'Terms v' + legal.termsVersion + ', Privacy v' + legal.privacyVersion
          + (legal.updated ? ', updated ' + legal.updated : '') + '.';
        versions.classList.remove('is-missing');
      }
      if (retry) retry.hidden = !!legal;
    }

    function loadLegal() {
      if (versions) versions.textContent = 'Checking which terms are in force\u2026';
      if (retry) retry.hidden = true;
      return Api.legal().then(function (info) {
        paintVersions(info);
        syncSubmit();
      }).catch(function () {
        paintVersions(null);
        syncSubmit();
      });
    }

    if (accepted) {
      accepted.addEventListener('change', function () {
        hush(alertBox);
        syncSubmit();
      });
    }
    if (retry) retry.addEventListener('click', loadLegal);
    paintVersions(null);
    syncSubmit();
    loadLegal();

    if (typeof Api.instance === 'function') {
      Api.instance().then(function (info) {
        var name = info && info.name ? String(info.name) : '';
        if (name) instanceNames.forEach(function (node) { node.textContent = name; });

        var registration = (info && info.registration) || {};
        if (registration.enabled === false) {
          form.hidden = true;
          if (closed) closed.hidden = false;
          focus(closed && find('[data-register-closed-title]'));
          return;
        }
        if (registration.approvalRequired && approvalNote) {
          approvalNote.hidden = false;
        }
        if (registration.emailVerificationRequired) {
          if (email) email.required = true;
          if (emailOptional) emailOptional.hidden = true;
          if (emailHint) emailHint.textContent = 'This instance requires a verified email address for every account.';
        }
      }).catch(function () { /* the form's own refusal is the answer */ });
    }

    if (signOut) {
      signOut.addEventListener('click', function () {
        Api.clearSession().then(function () {
          window.location.assign('/login');
        }).catch(function () {
          window.location.assign('/login');
        });
      });
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (busy) return;

      var wantedName = String(username && username.value || '').trim();
      var wantedDisplay = String(displayName && displayName.value || '').trim();
      var wantedEmail = String(email && email.value || '').trim();
      var wantedPassword = String(password && password.value || '');
      var wantedConfirm = String(confirm && confirm.value || '');

      hush(alertBox);
      if (!legal) {
        say(alertBox, 'This instance did not say which terms are in force. Check the terms again before creating an account.', 'error');
        if (retry) retry.hidden = false;
        return;
      }
      if (!accepted || !accepted.checked) {
        say(alertBox, 'Accept the Terms of Service and the Privacy Policy to continue.', 'error');
        focus(accepted);
        return;
      }
      if (!/^[A-Za-z0-9_.]{2,32}$/.test(wantedName)) {
        say(alertBox, 'A username is 2 to 32 characters: letters, numbers, _ or .', 'error');
        focus(username);
        return;
      }
      if (wantedDisplay.length > 32) {
        say(alertBox, 'The display name can be at most 32 characters.', 'error');
        focus(displayName);
        return;
      }
      if (wantedEmail && !emailLooksValid(wantedEmail)) {
        say(alertBox, 'Enter a valid email address, or leave it empty.', 'error');
        focus(email);
        return;
      }
      if (!wantedEmail && email && email.required) {
        say(alertBox, 'This instance requires an email address on every account.', 'error');
        focus(email);
        return;
      }
      var pwProblem = passwordProblem(wantedPassword);
      if (pwProblem) {
        say(alertBox, pwProblem, 'error');
        focus(password);
        return;
      }
      if (wantedConfirm !== wantedPassword) {
        say(alertBox, 'The two passwords do not match. Type them again and try once more.', 'error');
        focus(confirm);
        return;
      }

      busy = true;
      setBusy(submit, true);
      try {
        var answer = await Api.register({
          username: wantedName,
          displayName: wantedDisplay || undefined,
          email: wantedEmail || undefined,
          password: wantedPassword,
          termsVersion: legal.termsVersion,
          privacyVersion: legal.privacyVersion,
        });
        if (!answer || !answer.token) {
          say(alertBox, 'The instance created no session. Sign in with your new account.', 'error');
          return;
        }
        if (!(await remember(answer, alertBox))) return;
        if (answer.pendingApproval) {
          form.hidden = true;
          if (closed) closed.hidden = true;
          if (doneTitle) doneTitle.textContent = 'Your account is waiting.';
          if (doneText) {
            doneText.textContent = 'This instance asks an administrator to approve new accounts before they open. '
              + 'You can check back by opening the app.';
          }
          if (continueLink) continueLink.hidden = false;
          reveal(done);
          resolveAppLinks();
          return;
        }
        await openApp('');
        return;
      } catch (error) {
        if (error && error.code === 'REGISTRATION_DISABLED') {
          form.hidden = true;
          if (closed) closed.hidden = false;
          focus(closed && find('[data-register-closed-title]'));
          return;
        }
        say(alertBox, messageOf(error, 'That did not work. Check the details and try again.'), 'error');
      } finally {
        busy = false;
        setBusy(submit, false);
        syncSubmit();
      }
    });
  }

  // -- asking for a recovery link --------------------------------------------

  function setupForgot() {
    var form = find('[data-forgot-form]');
    if (!form) return;
    var alertBox = find('[data-forgot-alert]');
    var email = form.querySelector('input[name="email"]');
    var submit = find('[data-forgot-submit]');
    var result = find('[data-forgot-result]');
    var resultNote = find('[data-forgot-result-note]');
    var busy = false;

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (busy) return;
      var wanted = String(email && email.value || '').trim();
      hush(alertBox);
      if (!emailLooksValid(wanted)) {
        say(alertBox, 'Enter the email address on your account.', 'error');
        focus(email);
        return;
      }

      busy = true;
      setBusy(submit, true);
      try {
        var answer = await Api.forgotPassword({ email: wanted });
        form.hidden = true;
        if (resultNote) {
          resultNote.textContent = (answer && answer.message)
            || "If an account exists for that email, you'll receive a password reset link.";
        }
        reveal(result);
      } catch (error) {
        say(alertBox, messageOf(error, 'That did not work. Try again.'), 'error');
      } finally {
        busy = false;
        setBusy(submit, false);
      }
    });
  }

  // -- applying a reset -------------------------------------------------------

  function setupReset() {
    var form = find('[data-reset-form]');
    if (!form) return;
    var token = readToken('reset-password');
    var invalid = find('[data-reset-invalid]');
    var invalidText = find('[data-reset-invalid-text]');
    var done = find('[data-reset-done]');
    var doneText = find('[data-reset-done-text]');
    var alertBox = find('[data-reset-alert]');
    var password = form.querySelector('input[name="password"]');
    var confirm = form.querySelector('input[name="confirm"]');
    var submit = find('[data-reset-submit]');
    var busy = false;

    installPasswordToggle(find('[data-password-toggle]'));

    function showInvalid(text) {
      form.hidden = true;
      if (invalidText) invalidText.textContent = text;
      reveal(invalid);
    }

    function showDone(text) {
      form.hidden = true;
      if (doneText) doneText.textContent = text;
      reveal(done);
    }

    if (!token) {
      showInvalid('This reset link is missing its token. Request a new link to continue.');
      return;
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (busy) return;
      var wanted = String(password && password.value || '');
      var wantedConfirm = String(confirm && confirm.value || '');
      hush(alertBox);
      var pwProblem = passwordProblem(wanted);
      if (pwProblem) {
        say(alertBox, pwProblem, 'error');
        focus(password);
        return;
      }
      if (wantedConfirm !== wanted) {
        say(alertBox, 'The two passwords do not match. Type them again and try once more.', 'error');
        focus(confirm);
        return;
      }

      busy = true;
      setBusy(submit, true);
      try {
        var answer = await Api.resetPassword({
          token: token,
          newPassword: wanted,
          confirmPassword: wantedConfirm,
        });
        if (answer && answer.mfaRequired) {
          showDone('Your password is reset. Sign in with your two-step code to finish.');
          return;
        }
        if (!answer || !answer.token) {
          showDone('Your password is reset. Sign in with your new password.');
          return;
        }
        var stored = await Api.rememberSession(answer.token);
        if (!stored) {
          showDone('Your password is reset, but this browser blocked local storage. Sign in with your new password.');
          return;
        }
        await openApp('');
      } catch (error) {
        if (error && error.code === 'AUTH_REQUIRED') {
          showInvalid(messageOf(error, 'This reset link is no longer valid. Request a new one.'));
          return;
        }
        say(alertBox, messageOf(error, 'That did not work. Try again.'), 'error');
      } finally {
        busy = false;
        setBusy(submit, false);
      }
    });
  }

  // -- confirming an address --------------------------------------------------

  function setupVerify() {
    var alertBox = find('[data-verify-status]');
    var actions = find('[data-verify-actions]');
    var appLink = find('[data-verify-app]');
    var loginLink = find('[data-verify-login]');
    var resend = find('[data-verify-resend]');
    var note = find('[data-verify-note]');
    var token = readToken('verify-email');
    var email = '';
    var busy = false;

    function showActions() {
      if (actions) actions.hidden = false;
    }

    function signedInActions() {
      return Api.signedIn().then(function (signedIn) {
        if (loginLink) loginLink.hidden = signedIn;
        if (appLink) appLink.hidden = !signedIn;
        if (!signedIn) {
          showActions();
          return;
        }
        resolveAppLinks();
        return Api.me().then(function (me) {
          email = me && me.email ? String(me.email) : '';
          if (resend && email) {
            resend.hidden = false;
            resend.textContent = 'Send a new link to ' + email;
          } else if (note) {
            note.textContent = email
              ? ''
              : 'Add a recovery email in your account settings before asking for another link.';
          }
          showActions();
        }).catch(function () {
          showActions();
        });
      }).catch(function () {
        if (loginLink) loginLink.hidden = false;
        showActions();
      });
    }

    function failure(error) {
      say(alertBox, messageOf(error, 'That confirmation did not go through.'), 'error');
      signedInActions();
    }

    if (!token) {
      failure(new Error('This confirmation link is missing its token. Sign in and request a new one.'));
      return;
    }

    Api.verifyEmail({ token: token }).then(function () {
      say(alertBox, 'Email confirmed. You can continue now.', 'success');
      signedInActions();
    }).catch(failure);

    if (resend) {
      resend.addEventListener('click', async function () {
        if (busy || !email) return;
        busy = true;
        resend.disabled = true;
        try {
          await Api.verifyEmailResend({ email: email });
          say(alertBox, 'A new link is on its way to ' + email + '. If it does not arrive, look in the spam folder.', 'success');
          resend.hidden = true;
        } catch (error) {
          say(alertBox, messageOf(error, 'The new link could not be sent. Try again.'), 'error');
          resend.disabled = false;
        } finally {
          busy = false;
        }
      });
    }
  }

  if (kind === 'register') setupRegister();
  else if (kind === 'forgot') setupForgot();
  else if (kind === 'reset') setupReset();
  else if (kind === 'verify') setupVerify();

  resolveAppLinks();
})();
