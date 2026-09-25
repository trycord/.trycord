// Public + authentication surfaces. Rendered into the current view region.

import Api from './api.js';
import { esc, el, clear, toast, qs } from './ui.js';
import State, { applyAuth, isAuthed, clearSession } from './state.js';
import { renderContextHeader } from './shell.js';
import { TrycordConfig, BACKEND_URL } from './config.js';
import Realtime from './realtime.js';

let legal = { termsVersion: '1.0', privacyVersion: '1.0' };
Api.legal().then((l) => { if (l) legal = l; }).catch(() => {});

function loginForm(container) {
  clear(container);
  renderContextHeader({ title: 'Welcome back' });
  const box = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  card.appendChild(el('h1', {}, 'Sign in'));
  card.appendChild(el('p', { class: 'auth-sub' }, 'Back to your communities, conversations and presence.'));

  const err = el('div', { class: 'form-error', hidden: true });
  const username = el('input', { class: 'input', type: 'text', autocomplete: 'username', placeholder: 'Username', required: true });
  const password = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

  const form = el('form', {}, err,
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
      applyAuth(res);
      toast('Signed in.', 'ok');
      location.hash = '#/home';
      // Fresh sign-in (not a boot restore): bring the realtime gateway up
      // now instead of waiting for the next reload.
      Realtime.connect();
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Sign in failed';
    } finally {
      busy = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Sign in';
    }
  });

  card.appendChild(form);
  const backendBox = el('div', { style: { marginTop: 'var(--t-d-5)' } });
  renderBackendSelector(backendBox);
  card.appendChild(backendBox);
  card.appendChild(el('p', { class: 'auth-alt' },
    'New here? ', el('a', { href: '#/register' }, 'Create an account')));
  card.appendChild(el('p', { class: 'auth-alt' },
    el('a', { href: '#/forgot' }, 'Forgot password?')));
  box.appendChild(card);
  container.appendChild(box);
  username.focus();
}

function registerForm(container) {
  clear(container);
  renderContextHeader({ title: 'Create an account' });
  const box = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  card.appendChild(el('h1', {}, 'Join Trycord'));
  card.appendChild(el('p', { class: 'auth-sub' },
    'A self-hosted community chat. Pick a name and agree to the policies to continue.'));

  const err = el('div', { class: 'form-error', hidden: true });
  const username = el('input', { class: 'input', type: 'text', autocomplete: 'username', placeholder: 'username', minlength: 2, maxlength: 32, required: true });
  const display = el('input', { class: 'input', type: 'text', autocomplete: 'nickname', placeholder: 'Display name (optional)', maxlength: 32 });
  const password = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Password (8+ characters)', minlength: 8, required: true });
  const email = el('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
  const emailHint = el('span', { class: 'hint' }, 'Optional. Verification and recovery require email delivery on this instance.');
  const emailField = el('div', { class: 'field' }, el('label', {}, 'Email', el('span', { class: 'badge' }, 'optional')), email, emailHint);
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

  const form = el('form', {}, err,
    el('div', { class: 'field' },
      el('label', { for: 'reg-username' }, 'Username'),
      username,
      el('span', { class: 'hint' }, 'Letters, numbers, dots and underscores. 2–32 characters.')),
    el('div', { class: 'field' }, el('label', { for: 'reg-display' }, 'Display name'), display),
    el('div', { class: 'field' }, el('label', { for: 'reg-password' }, 'Password'), password),
    emailField,
    el('p', { class: 'small muted' },
      'By continuing you agree to the ',
      el('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms of Service'),
      ' and ', el('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'),
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
      location.hash = '#/home';
      // Fresh registration: bring the realtime gateway up now.
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

  card.appendChild(form);
  const backendBox = el('div', { style: { marginTop: 'var(--t-d-5)' } });
  renderBackendSelector(backendBox);
  card.appendChild(backendBox);
  card.appendChild(el('p', { class: 'auth-alt' },
    'Already registered? ', el('a', { href: '#/login' }, 'Sign in')));
  box.appendChild(card);
  container.appendChild(box);
  username.focus();
}

function forgotForm(container) {
  clear(container);
  renderContextHeader({ title: 'Reset password' });
  const box = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  card.appendChild(el('h1', {}, 'Forgot password'));
  card.appendChild(el('p', { class: 'auth-sub' },
    "Tell us the email on your account and we'll send a reset link if it exists."));

  const ok = el('div', { class: 'form-success', hidden: true });
  const err = el('div', { class: 'form-error', hidden: true });
  const email = el('input', { class: 'input', type: 'email', placeholder: 'you@example.com', required: true });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Send reset link');

  const form = el('form', {}, ok, err,
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

  card.appendChild(form);
  card.appendChild(el('p', { class: 'auth-alt' }, el('a', { href: '#/login' }, 'Back to sign in')));
  box.appendChild(card);
  container.appendChild(box);
}

function resetPasswordPage(container, token) {
  clear(container);
  renderContextHeader({ title: 'Reset password' });
  const box = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  card.appendChild(el('h1', {}, 'Choose a new password'));
  card.appendChild(el('p', { class: 'auth-sub' }, 'Set a new password for your Trycord account.'));
  const err = el('div', { class: 'form-error', hidden: true });
  const ok = el('div', { class: 'form-success', hidden: true });
  const password = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true, placeholder: 'New password' });
  const confirm = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true, placeholder: 'Repeat new password' });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Reset password');
  const form = el('form', {}, ok, err,
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
      ok.textContent = 'Password reset successfully. You can now sign in.';
      form.reset();
      submit.hidden = true;
      card.appendChild(el('a', { class: 'btn primary', href: '#/login' }, 'Continue to sign in'));
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'This reset link is no longer valid.';
    } finally { submit.removeAttribute('aria-busy'); }
  });
  card.appendChild(form);
  card.appendChild(el('p', { class: 'auth-alt' }, el('a', { href: '#/login' }, 'Back to sign in')));
  box.appendChild(card); container.appendChild(box);
}

function legalPage(container, kind) {
  clear(container);
  const titles = { terms: 'Terms of Service', privacy: 'Privacy Policy' };
  renderContextHeader({ title: titles[kind] || 'Legal' });
  const wrap = el('div', { class: 'page' });
  wrap.appendChild(el('p', {}, 'This instance manages its own legal documents. Login or registration records your acceptance of the versions this server exposes (v' + esc(legal.termsVersion) + '/v' + esc(legal.privacyVersion) + ').'));
  container.appendChild(wrap);
}

// Consumes the single-use link mailed by the recovery service. Public route:
// verification happens with or without a session and never reveals whether a
// given address exists ahead of the attempt.
function verifyEmailPage(container, token) {
  clear(container);
  renderContextHeader({ title: 'Verify email' });
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  card.appendChild(el('h1', {}, 'Confirm your email'));
  card.appendChild(el('p', { class: 'auth-sub' }, 'Confirming your recovery address…'));
  const msg = el('div', { class: 'muted small', 'aria-live': 'polite' });
  const err = el('div', { class: 'form-error', hidden: true });
  const actions = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)' } });
  card.appendChild(err);
  card.appendChild(msg);
  card.appendChild(actions);
  wrap.appendChild(card);
  container.appendChild(wrap);

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
        onClick: () => { location.hash = me ? '#/settings' : '#/login'; },
      }, me ? 'Open your account' : 'Sign in'));
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'This verification link is no longer valid. Request a new one from your settings.';
      actions.appendChild(el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => { location.hash = isAuthed() ? '#/settings' : '#/login'; },
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

// Backend selector: which Trycord server this client talks to. Rendered on
// auth cards (pre-login, where it matters most) and reused by settings.
// Shows the resolved BACKEND_URL + its source, validates input, tests the
// connection against /api/instance, persists the choice, and resets to the
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
      // and reboot against the new backend.
      try { Realtime.disconnect(); } catch { /* ignore */ }
      clearSession();
    }
    toast('Backend switched. Reloading…', 'ok');
    // Reload WITH ?api=: the serving server reflects the configured backend
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