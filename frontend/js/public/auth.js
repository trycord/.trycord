import Api from '../api.js';
import { esc, el, clear, toast, btn } from '../ui.js';
import { applyAuth } from '../state.js';
import { renderContextHeader } from '../shell.js';
import { navigate, route } from '../nav.js';
import Realtime from '../realtime.js';
import { AUTH_LOGO, legalVersions } from './legal.js';
import { renderBackendSelector } from './backend.js';
// box. There is deliberately NO QR/device-login panel here, because the server
// exposes no such endpoint - a decorative code scanner would promise a feature
export function mountAuthPage(page) {
  for (const stray of document.querySelectorAll('body > .auth-page')) stray.remove();
  document.body.appendChild(page);
}

export function authShell({ title, lede, secondary, contextTitle }) {
  if (contextTitle) renderContextHeader({ title: contextTitle });
  document.documentElement.dataset.authPage = '1';
  const page = el('div', { class: 'auth-page' });
  page.appendChild(el('div', { class: 'auth-background', 'aria-hidden': 'true' }));

  const inner = el('div', { class: 'auth-page__inner' });

  const brand = el('a', { class: 'auth-brand', href: route('/home'), 'aria-label': 'Trycord' });
  brand.appendChild(el('img', { class: 'auth-brand__mark', src: AUTH_LOGO, alt: '' }));
  brand.appendChild(el('span', { class: 'auth-brand__word' }, 'Trycord'));
  inner.appendChild(brand);

  const card = el('div', { class: 'auth-card' });
  const main = el('div', { class: 'auth-main' });
  const heading = el('h1', { class: 'auth-title' }, title);
  main.appendChild(heading);
  if (lede) main.appendChild(el('p', { class: 'auth-lede' }, lede));
  card.appendChild(main);
  if (secondary) card.appendChild(secondary);

  inner.appendChild(card);
  page.appendChild(inner);
  return { page, main, card };
}

function authFooter(...nodes) {
  return el('div', { class: 'auth-footer' }, ...nodes);
}

// The only redirect a sign-in or sign-up may honour: an application path that
// stays on this instance. The rules are a deny-list rather than a whitelist so
// valid destinations never need registering, while anything that would carry
// the reader off the instance is refused. navigate() matches routes internally
// and never hands the string to the address bar, so the worst a bad value can
// do is hit the app's own "no such page".
function safeNext() {
  let next = null;
  try { next = new URLSearchParams(window.location.search).get('next'); } catch (e) { return null; }
  if (!next || typeof next !== 'string') return null;
  if (!next.startsWith('/')) return null;
  // A protocol-relative URL, whether written with slashes or the backslash that
  // some browsers quietly read as one. Both leave the instance.
  if (/^\/[\\/]/.test(next)) return null;
  // The API, uploads and the socket are not pages. Sending a freshly signed-in
  // member 'somewhere' that parses as a page is how a redirect becomes a leak.
  if (next.startsWith('/api/') || next.startsWith('/uploads') || next.startsWith('/ws')) return null;
  return next;
}

// One labelled password input with a visibility switch, used on every signed-out
// surface so the control, the wording, and the autofill hints cannot drift
// between sign in, registration and reset.
function passwordField({ id, label, placeholder, autocomplete, hint }) {
  const input = el('input', {
    class: 'input', id, type: 'password',
    autocomplete, placeholder, required: true, minlength: 8,
  });
  const toggle = el('button', {
    class: 'pw-toggle', type: 'button', 'aria-pressed': 'false',
    'aria-controls': id, 'aria-label': 'Show password',
  }, 'Show');
  toggle.addEventListener('click', () => {
    const nowShown = input.type === 'text';
    input.type = nowShown ? 'password' : 'text';
    toggle.textContent = nowShown ? 'Show' : 'Hide';
    toggle.setAttribute('aria-pressed', nowShown ? 'false' : 'true');
    toggle.setAttribute('aria-label', (nowShown ? 'Show' : 'Hide') + ' password');
    input.focus();
  });
  const wrap = el('div', { class: 'pw' }, input, toggle);
  return {
    input, toggle,
    field: el('div', { class: 'field' },
      el('label', { for: id }, label), wrap,
      hint ? el('span', { class: 'hint' }, hint) : null),
  };
}

// A live line under a password field stating the server's one real rule and
// marking when the current value meets it. No invented complexity: the server
// requires length only, and asserting that a password needs an uppercase letter
// when the server would accept one without would be a screenful of lies.
function passwordCheck() {
  const line = el('span', { class: 'hint pw-check', 'aria-live': 'polite' }, 'At least 8 characters.');
  function update(value) {
    const ok = String(value || '').length >= 8;
    line.classList.toggle('is-met', ok);
    line.textContent = ok ? 'Meets the 8-character minimum.' : 'At least 8 characters.';
  }
  return { line, update };
}

function secondFactorStep(challengeToken, err) {
  // Replaces the password form in place rather than navigating: the challenge
  // lives in this closure, so there is nothing to pass to another route and no
  // way for the token to end up in a URL or in history.
  const code = el('input', {
    class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: 6, pattern: '[0-9]*', required: true,
  });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Verify');
  const form = el('form', { class: 'card card--auth' },
    el('div', { class: 'field' }, el('label', {}, 'Two-factor code'),
      code,
      el('span', { class: 'hint' }, 'The 6-digit code from your authenticator app, or a recovery code.')),
    el('div', {}, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.setAttribute('aria-busy', 'true');
    try {
      const res = await Api.twoFactorVerify({ challengeToken, code: code.value.trim() });
      applyAuth(res);
      if (res.usedRecoveryCode) {
        // A recovery code is spent. Saying so once, here, is the difference
        // between a member who re-provisions and one who is quietly down to
        // their last one.
        toast('Signed in with a recovery code. That code is now used up.', 'ok');
      } else {
        toast('Signed in.', 'ok');
      }
      navigate('/home');
      Realtime.connect();
    } catch (ex) {
      err.hidden = false;
      clear(err);
      err.appendChild(el('span', {}, ex.message || 'That code is not correct'));
      code.select();
    } finally {
      submit.removeAttribute('aria-busy');
    }
  });
  setTimeout(() => code.focus(), 0);
  return form;
}

export function loginForm(container) {
  clear(container);
  const backendBox = el('div', { class: 'auth-secondary__body' });
  renderBackendSelector(backendBox);
  const secondary = el('div', { class: 'auth-secondary' },
    el('h2', { class: 'auth-secondary__title' }, 'Connect to an instance'),
    el('p', { class: 'auth-secondary__lede' },
      'Running your own? Point Trycord at your instance instead of the default.'),
    backendBox);

  const { page, main } = authShell({
    title: 'Sign in',
    lede: 'Back to your communities, conversations and presence.',
    secondary,
    contextTitle: 'Welcome back',
  });

  const err = el('div', { class: 'form-error', role: 'alert', hidden: true });
  const username = el('input', { class: 'input', id: 'login-username', type: 'text', autocomplete: 'username', placeholder: 'Username', required: true });
  const pw = passwordField({
    id: 'login-password', label: 'Password',
    placeholder: 'Password', autocomplete: 'current-password',
  });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

  const form = el('form', { class: 'auth-form' }, err,
    el('div', { class: 'field' }, el('label', { for: 'login-username' }, 'Username'), username),
    pw.field,
    submit);

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    err.hidden = true;
    busy = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Signing in…';
    try {
      const res = await Api.login({ username: username.value.trim(), password: pw.input.value });
      // A correct password is not a session. When the account has a second
      // factor the response carries a challenge instead of a token, and calling
      // applyAuth on it would store undefined and leave the member looking at a
      // signed-out app with no explanation.
      if (res && res.mfaRequired) {
        clear(form);
        main.appendChild(secondFactorStep(res.challengeToken, err));
        return;
      }
      applyAuth(res);
      toast('Signed in.', 'ok');
      navigate(safeNext() || '/home');
      Realtime.connect();
    } catch (ex) {
      err.hidden = false;
      clear(err);
      err.appendChild(el('span', {}, ex.message || 'Sign in failed'));
      const actionId = ex && ex.details && ex.details.actionId;
      if (ex && ex.code === 'ACCOUNT_ENFORCED' && actionId) {
        err.appendChild(el('div', { style: { marginTop: 'var(--space-2)' } },
          el('a', { class: 'btn sm', href: route('/support/appeals/new?action=') + encodeURIComponent(actionId) }, 'Appeal this decision')));
      }
    } finally {
      busy = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Sign in';
    }
  });

  main.appendChild(form);
  main.appendChild(authFooter(
    el('span', {}, 'New here? ', el('a', { href: route('/register') }, 'Create an account')),
    el('span', {}, el('a', { href: route('/forgot') }, 'Forgot password?'), ' · ', el('a', { href: route('/support') }, 'Support')),
  ));
  mountAuthPage(page);
  username.focus();
}

export function registerForm(container) {
  clear(container);
  const backendBox = el('div', { class: 'auth-secondary__body' });
  renderBackendSelector(backendBox);
  const secondary = el('div', { class: 'auth-secondary' },
    el('h2', { class: 'auth-secondary__title' }, 'Connect to an instance'),
    el('p', { class: 'auth-secondary__lede' },
      'Already running your own? Point Trycord at your instance before you sign up.'),
    backendBox);

  const { page, main } = authShell({
    title: 'Join Trycord',
    lede: 'A self-hosted community chat. Pick a name and agree to the policies to continue.',
    secondary,
    contextTitle: 'Create an account',
  });

  const err = el('div', { class: 'form-error', role: 'alert', hidden: true });
  const username = el('input', { class: 'input', id: 'reg-username', type: 'text', autocomplete: 'username', placeholder: 'username', minlength: 2, maxlength: 32, required: true });
  const display = el('input', { class: 'input', id: 'reg-display', type: 'text', autocomplete: 'nickname', placeholder: 'Display name (optional)', maxlength: 32 });
  const pw = passwordField({
    id: 'reg-password', label: 'Password',
    placeholder: 'Password (8+ characters)', autocomplete: 'new-password',
  });
  const pwLine = passwordCheck();
  pw.input.addEventListener('input', (e) => pwLine.update(e.target.value));
  pw.field.appendChild(pwLine.line);
  const email = el('input', { class: 'input', id: 'reg-email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
  const emailHint = el('span', { class: 'hint' }, 'Optional. Verification and recovery require email delivery on this instance.');
  const emailField = el('div', { class: 'field' }, el('label', { for: 'reg-email' }, 'Email', el('span', { class: 'badge' }, 'optional')), email, emailHint);
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Create account');

  // The server exposes only a boolean capability. SMTP credentials never leave the server.
  Api.instance().then((info) => {
    const enabled = !!(info && info.features && info.features.email);
    email.disabled = !enabled;
    emailField.classList.toggle('is-disabled', !enabled);
    emailHint.textContent = enabled
      ? 'Optional. A verification link will be sent after signup.'
      : 'Optional email is unavailable until SMTP delivery is configured on this instance.';
  }).catch(() => {
    email.disabled = true;
    emailField.classList.add('is-disabled');
  });

  const form = el('form', { class: 'auth-form' }, err,
    el('div', { class: 'field' },
      el('label', { for: 'reg-username' }, 'Username'),
      username,
      el('span', { class: 'hint' }, 'Letters, numbers, dots and underscores. 2–32 characters.')),
    el('div', { class: 'field' }, el('label', { for: 'reg-display' }, 'Display name'), display),
    pw.field,
    emailField,
    el('p', { class: 'small muted' },
      'By continuing you agree to the ',
      el('a', { href: '/terms', 'data-document': '', target: '_blank', rel: 'noopener' }, 'Terms of Service'),
      ' and ', el('a', { href: '/privacy', 'data-document': '', target: '_blank', rel: 'noopener' }, 'Privacy Policy'),
      '. (v' + esc(legalVersions().termsVersion) + ' / v' + esc(legalVersions().privacyVersion) + ')'),
    submit);

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    err.hidden = true;
    busy = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Creating account…';
    try {
      const res = await Api.register({
        username: username.value.trim(),
        password: pw.input.value,
        displayName: display.value.trim() || undefined,
        email: email.value.trim() || undefined,
        termsVersion: legalVersions().termsVersion,
        privacyVersion: legalVersions().privacyVersion,
      });
      applyAuth(res);
      toast('Account created.', 'ok');
      navigate(safeNext() || '/home');
      Realtime.connect();
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Registration failed';
    } finally {
      busy = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Create account';
    }
  });

  main.appendChild(form);
  main.appendChild(authFooter(
    el('span', {}, 'Already registered? ', el('a', { href: route('/login') }, 'Sign in'), ' · ', el('a', { href: route('/support') }, 'Support')),
  ));
  mountAuthPage(page);
  username.focus();
}

export function forgotForm(container) {
  clear(container);
  const { page, main } = authShell({
    title: 'Forgot password',
    lede: "Tell us the email on your account and we'll send a reset link if it exists.",
    contextTitle: 'Reset password',
  });

  const ok = el('div', { class: 'form-success', role: 'status', hidden: true });
  const err = el('div', { class: 'form-error', role: 'alert', hidden: true });
  const email = el('input', { class: 'input', id: 'forgot-email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', required: true });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Send reset link');

  const form = el('form', { class: 'auth-form' }, ok, err,
    el('div', { class: 'field' }, el('label', { for: 'forgot-email' }, 'Email'), email),
    submit);

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    err.hidden = true;
    ok.hidden = true;
    busy = true;
    submit.setAttribute('aria-busy', 'true');
    try {
      const res = await Api.forgotPassword({ email: email.value.trim() });
      ok.hidden = false;
      ok.textContent = (res && res.message) || "If an account exists for that email, you'll receive a reset link.";
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Request failed';
    } finally {
      busy = false;
      submit.removeAttribute('aria-busy');
    }
  });

  main.appendChild(form);
  main.appendChild(authFooter(
    el('span', {}, el('a', { href: route('/login') }, 'Back to sign in'), ' · ', el('a', { href: route('/support') }, 'Support')),
  ));
  mountAuthPage(page);
}

export function resetPasswordPage(container, token) {
  clear(container);
  const { page, main } = authShell({
    title: 'Choose a new password',
    lede: 'Set a new password for your Trycord account.',
    contextTitle: 'Reset password',
  });
  const err = el('div', { class: 'form-error', role: 'alert', hidden: true });
  const ok = el('div', { class: 'form-success', role: 'status', hidden: true });
  const pw = passwordField({
    id: 'reset-password', label: 'New password',
    placeholder: 'New password', autocomplete: 'new-password',
  });
  const pwLine = passwordCheck();
  pw.input.addEventListener('input', (e) => pwLine.update(e.target.value));
  pw.field.appendChild(pwLine.line);
  const confirm = passwordField({
    id: 'reset-confirm', label: 'Confirm password',
    placeholder: 'Repeat new password', autocomplete: 'new-password',
  });
  const matchLine = el('span', { class: 'hint pw-check', 'aria-live': 'polite' },
    'Repeat the password above.');
  confirm.input.addEventListener('input', (e) => {
    const same = e.target.value === pw.input.value;
    matchLine.classList.toggle('is-met', same);
    matchLine.textContent = same ? 'Passwords match.' : 'Passwords do not match yet.';
  });
  confirm.field.appendChild(matchLine);
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Reset password');
  const form = el('form', { class: 'auth-form' }, ok, err,
    pw.field,
    confirm.field,
    submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true; ok.hidden = true;
    if (!token) { err.hidden = false; err.textContent = 'This reset link is missing its token.'; return; }
    if (pw.input.value !== confirm.input.value) {
      err.hidden = false; err.textContent = 'Passwords do not match.';
      confirm.input.focus();
      return;
    }
    submit.setAttribute('aria-busy', 'true');
    try {
      const res = await Api.resetPassword({ token, newPassword: pw.input.value, confirmPassword: confirm.input.value });
      ok.hidden = false;
      ok.textContent = 'Password changed. Sign in with your new one.';
      form.reset();
      submit.hidden = true;
      main.appendChild(el('a', { class: 'btn primary block', href: route('/login') }, 'Continue to sign in'));
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'This reset link is no longer valid.';
    } finally { submit.removeAttribute('aria-busy'); }
  });
  main.appendChild(form);
  main.appendChild(authFooter(el('span', {}, el('a', { href: route('/login') }, 'Back to sign in'))));
  mountAuthPage(page);
}
