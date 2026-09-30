
import Api from './api.js';
import { esc, el, clear, toast, qs } from './ui.js';
import State, { applyAuth, isAuthed, clearSession } from './state.js';
import { renderContextHeader } from './shell.js';
import { TrycordConfig, BACKEND_URL } from './config.js';
import Realtime from './realtime.js';
import { navigate, route } from './nav.js';;

let legal = { termsVersion: '1.0', privacyVersion: '1.0' };
Api.legal().then((l) => { if (l) legal = l; }).catch(() => {});

const AUTH_BG = '/assets/trycord-login-bg.png';
const AUTH_LOGO = '/assets/trycord-logo.png';

// box. There is deliberately NO QR/device-login panel here, because the server
// exposes no such endpoint - a decorative code scanner would promise a feature
function mountAuthPage(page) {
  for (const stray of document.querySelectorAll('body > .auth-page')) stray.remove();
  document.body.appendChild(page);
}

function authShell({ title, lede, secondary, contextTitle }) {
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

function loginForm(container) {
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

  const err = el('div', { class: 'form-error', hidden: true });
  const username = el('input', { class: 'input', id: 'login-username', type: 'text', autocomplete: 'username', placeholder: 'Username', required: true });
  const password = el('input', { class: 'input', id: 'login-password', type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

  const form = el('form', { class: 'auth-form' }, err,
    el('div', { class: 'field' }, el('label', { for: 'login-username' }, 'Username'), username),
    el('div', { class: 'field' }, el('label', { for: 'login-password' }, 'Password'), password),
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
      const res = await Api.login({ username: username.value.trim(), password: password.value });
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
      navigate('/home');
      Realtime.connect();
    } catch (ex) {
      err.hidden = false;
      clear(err);
      err.appendChild(el('span', {}, ex.message || 'Sign in failed'));
      const actionId = ex && ex.details && ex.details.actionId;
      if (ex && ex.code === 'ACCOUNT_ENFORCED' && actionId) {
        err.appendChild(el('div', { style: { marginTop: 'var(--t-d-2)' } },
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

function registerForm(container) {
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

  const err = el('div', { class: 'form-error', hidden: true });
  const username = el('input', { class: 'input', id: 'reg-username', type: 'text', autocomplete: 'username', placeholder: 'username', minlength: 2, maxlength: 32, required: true });
  const display = el('input', { class: 'input', id: 'reg-display', type: 'text', autocomplete: 'nickname', placeholder: 'Display name (optional)', maxlength: 32 });
  const password = el('input', { class: 'input', id: 'reg-password', type: 'password', autocomplete: 'new-password', placeholder: 'Password (8+ characters)', minlength: 8, required: true });
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
    el('div', { class: 'field' }, el('label', { for: 'reg-password' }, 'Password'), password),
    emailField,
    el('p', { class: 'small muted' },
      'By continuing you agree to the ',
      el('a', { href: '/terms', 'data-document': '', target: '_blank', rel: 'noopener' }, 'Terms of Service'),
      ' and ', el('a', { href: '/privacy', 'data-document': '', target: '_blank', rel: 'noopener' }, 'Privacy Policy'),
      '. (v' + esc(legal.termsVersion) + ' / v' + esc(legal.privacyVersion) + ')'),
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
        password: password.value,
        displayName: display.value.trim() || undefined,
        email: email.value.trim() || undefined,
        termsVersion: legal.termsVersion,
        privacyVersion: legal.privacyVersion,
      });
      applyAuth(res);
      toast('Account created.', 'ok');
      navigate('/home');
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

function forgotForm(container) {
  clear(container);
  const { page, main } = authShell({
    title: 'Forgot password',
    lede: "Tell us the email on your account and we'll send a reset link if it exists.",
    contextTitle: 'Reset password',
  });

  const ok = el('div', { class: 'form-success', hidden: true });
  const err = el('div', { class: 'form-error', hidden: true });
  const email = el('input', { class: 'input', id: 'forgot-email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', required: true });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Send reset link');

  const form = el('form', { class: 'auth-form' }, ok, err,
    el('div', { class: 'field' }, el('label', { for: 'forgot-email' }, 'Email'), email),
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    ok.hidden = true;
    try {
      const res = await Api.forgotPassword({ email: email.value.trim() });
      ok.hidden = false;
      ok.textContent = (res && res.message) || "If an account exists for that email, you'll receive a reset link.";
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Request failed';
    }
  });

  main.appendChild(form);
  main.appendChild(authFooter(
    el('span', {}, el('a', { href: route('/login') }, 'Back to sign in'), ' · ', el('a', { href: route('/support') }, 'Support')),
  ));
  mountAuthPage(page);
}

function resetPasswordPage(container, token) {
  clear(container);
  const { page, main } = authShell({
    title: 'Choose a new password',
    lede: 'Set a new password for your Trycord account.',
    contextTitle: 'Reset password',
  });
  const err = el('div', { class: 'form-error', hidden: true });
  const ok = el('div', { class: 'form-success', hidden: true });
  const password = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true, placeholder: 'New password' });
  const confirm = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true, placeholder: 'Repeat new password' });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Reset password');
  const form = el('form', { class: 'auth-form' }, ok, err,
    el('div', { class: 'field' }, el('label', {}, 'New password'), password),
    el('div', { class: 'field' }, el('label', {}, 'Confirm password'), confirm),
    submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true; ok.hidden = true;
    if (!token) { err.hidden = false; err.textContent = 'This reset link is missing its token.'; return; }
    if (password.value !== confirm.value) { err.hidden = false; err.textContent = 'Passwords do not match.'; return; }
    submit.setAttribute('aria-busy', 'true');
    try {
      const res = await Api.resetPassword({ token, newPassword: password.value, confirmPassword: confirm.value });
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

function legalPage(container, kind) {
  clear(container);
  const titles = { terms: 'Terms of Service', privacy: 'Privacy Policy' };
  const isTerms = kind === 'terms';
  const docPath = isTerms ? '/terms' : '/privacy';
  const wrap = el('div', { class: 'pub-page pub-page--narrow' });
  wrap.appendChild(el('h1', { class: 'pub-title' }, titles[kind] || 'Legal'));
  const body = el('div', { class: 'pub-prose' });
  body.appendChild(el('p', {},
    'This instance manages its own legal documents. Signing in or registering records your acceptance of the versions this server exposes (v'
    + esc(legal.termsVersion) + ' terms, v' + esc(legal.privacyVersion) + ' privacy).'));
  const cta = el('div', { class: 'pub-links' });
  cta.appendChild(el('a', { class: 'pub-link', href: docPath, 'data-document': '' },
    el('div', { class: 'pub-link__title' }, 'Read the full ' + (titles[kind] || 'document')),
    el('div', { class: 'pub-link__desc' }, 'Opens the complete ' + (isTerms ? 'terms' : 'privacy policy') + ' published by this instance.')));
  body.appendChild(cta);
  wrap.appendChild(body);
  container.appendChild(wrap);
}

// verification happens with or without a session and never reveals whether a
function verifyEmailPage(container, token) {
  clear(container);
  const { page, main } = authShell({
    title: 'Confirm your email',
    lede: 'Confirming your recovery address…',
    contextTitle: 'Verify email',
  });
  const msg = el('div', { class: 'muted small', 'aria-live': 'polite' });
  const err = el('div', { class: 'form-error', hidden: true });
  const actions = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)' } });
  main.appendChild(err);
  main.appendChild(msg);
  main.appendChild(actions);
  mountAuthPage(page);

  (async () => {
    try {
      await Api.verifyEmail({ token });
      let me = null;
      if (isAuthed()) {
        try { me = await Api.me(); State.me = me; } catch { /* keep local session state */ }
      }
      msg.textContent = me
        ? 'Your email ' + esc(me.email) + ' is verified.'
        : 'Your email is verified and saved to your account.';
      actions.appendChild(el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => { navigate(me ? '/settings' : '/login'); },
      }, me ? 'Open your account' : 'Sign in'));
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'This verification link is no longer valid. Request a new one from your settings.';
      actions.appendChild(el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => { navigate(isAuthed() ? '/settings' : '/login'); },
      }, isAuthed() ? 'Open your account' : 'Sign in'));
    }
  })();
}

const PagesPublic = {
  login: loginForm,
  register: registerForm,
  forgot: forgotForm,
  resetPassword: resetPasswordPage,
  verify: verifyEmailPage,
  legal: legalPage,
  currentLegal: () => legal,
};

// configured default. Switching backends while signed in drops the session
// (tokens belong to one backend) and reloads.
export function renderBackendSelector(mount) {
  clear(mount);
  const url = BACKEND_URL();
  const source = TrycordConfig.backendSource();

  mount.appendChild(el('div', { class: 'section-label' }, 'Backend'));
  const current = el('div', { class: 'row-line', style: { marginBottom: 'var(--t-d-2)' } },
    el('span', { class: 'muted small', style: { overflowWrap: 'anywhere' } }, url),
    el('span', { class: 'badge' }, source));
  mount.appendChild(current);

  const input = el('input', { class: 'input', type: 'url', inputmode: 'url', value: url, placeholder: 'https://api.example.com' });
  const status = el('div', { class: 'muted small', 'aria-live': 'polite', style: { minHeight: '1.2em' } },
    'Default: the official backend. Point here at your own instance to self-host.');
  const row = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-2)' } });
  const saveBtn = el('button', { class: 'btn sm', type: 'button' }, 'Save');
  const testBtn = el('button', { class: 'btn ghost sm', type: 'button' }, 'Test connection');
  const resetBtn = el('button', { class: 'btn ghost sm', type: 'button' }, 'Reset to default');
  row.append(saveBtn, testBtn, resetBtn);
  mount.appendChild(el('div', { class: 'field' }, el('label', {}, 'Backend URL'), input, row, status));

  let testing = false;
  testBtn.addEventListener('click', async () => {
    if (testing) return;
    testing = true;
    testBtn.setAttribute('aria-busy', 'true');
    status.textContent = 'Testing connection…';
    const res = await TrycordConfig.testBackend(input.value.trim());
    testing = false;
    testBtn.removeAttribute('aria-busy');
    status.textContent = res.ok ? '● Connected — ' + res.name : res.error;
  });
  saveBtn.addEventListener('click', () => {
    const next = TrycordConfig.setApiUrl(input.value.trim());
    if (!next) {
      status.textContent = 'Enter a valid http(s) URL, e.g. https://api.example.com';
      return;
    }
    if (next === url && !isAuthed()) {
      status.textContent = 'Backend saved — ' + next;
      renderBackendSelector(mount);
      return;
    }
    if (isAuthed()) {
      // Sessions belong to one backend: sign out everywhere in this client
      try { Realtime.disconnect(); } catch { /* ignore */ }
      clearSession();
    }
    toast('Backend switched. Reloading…', 'ok');
    // into its CSP connect-src, so the rebooted page may actually reach it.
    // Hash routing is preserved.
    try {
      const u = new URL(location.href);
      u.searchParams.set('api', next);
      location.href = u.toString();
    } catch {
      location.reload();
    }
  });
  resetBtn.addEventListener('click', () => {
    TrycordConfig.resetBackend();
    if (isAuthed()) {
      try { Realtime.disconnect(); } catch { /* ignore */ }
      clearSession();
      toast('Backend reset. Reloading…', 'ok');
      try {
        const u = new URL(location.href);
        u.searchParams.delete('api');
        location.href = u.toString();
      } catch {
        location.reload();
      }
      return;
    }
    renderBackendSelector(mount);
    toast('Backend reset to default.', 'ok');
  });
}

export default PagesPublic;
