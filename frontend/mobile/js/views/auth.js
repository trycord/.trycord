// Signing in, and the four screens that exist so it is recoverable.
//
// All of them share one shape - a statement of purpose, a form, a way onward - so
// they share one module. They render outside the shell, because a person who is
// not signed in has no shell to be inside. This is the Mobile module's own sign-in
// flow, drawn for a phone.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { brandMark } from '../../../packages/brand.js';
import Api from '../../../packages/api.js';
import { currentQuery, navigate, path } from '../../../packages/nav.js';
import { applyToken, loadSession, logout, refreshServers } from '../../../packages/store.js';
import { connect } from '../../../packages/realtime.js';
import { toast } from '../ui.js';
import { textInput, field } from './util.js';

function lockup() {
  return el('div', { class: 'm-auth__lockup' },
    brandMark({ size: 36 }),
    el('span', { class: 'm-auth__name' }, 'Trycord'));
}

function busy(form, isBusy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = isBusy;
  form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

function showError(form, error) {
  const message = error && error.message ? error.message : 'That did not work.';
  let box = form.querySelector('.m-form-error');
  if (!box) {
    box = el('div', { class: 'm-form-error', role: 'alert' });
    form.insertBefore(box, form.firstChild);
  }
  box.textContent = message;
}

function nextTarget() {
  const next = currentQuery().get('next');
  if (!next) return '/home';
  if (next.charAt(0) !== '/' || next.indexOf('//') === 0) return '/home';
  return next;
}

async function afterSignIn(next) {
  let user;
  try {
    user = await loadSession();
  } catch (error) {
    if (error && error.code === 'MFA_REQUIRED') { navigate('/two-step', { replace: true }); return; }
    throw error;
  }
  if (!user) return;
  await refreshServers().catch(() => {});
  connect();
  navigate(next || '/home', { replace: true });
}

function loginForm() {
  const username = textInput({ name: 'username', autocomplete: 'username' });
  const password = textInput({ name: 'password', type: 'password', autocomplete: 'current-password' });
  const code = textInput({ name: 'code', inputmode: 'numeric' });
  const mfaField = field({ label: 'Two-step code', control: code });
  mfaField.hidden = true;

  const form = el('form', { class: 'm-auth__form' },
    field({ label: 'Username or email', control: username }),
    field({ label: 'Password', control: password }),
    mfaField,
    el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'submit' }, 'Sign in'));

  let challenge = null;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    try {
      if (challenge) {
        const out = await Api.twoFactorVerify({ challengeToken: challenge, code: code.value.trim() });
        applyToken(out.token, out.user);
        await afterSignIn(nextTarget());
        return;
      }
      const out = await Api.login({ username: username.value.trim(), password: password.value });
      if (out && out.mfaRequired) {
        challenge = out.challengeToken;
        mfaField.hidden = false;
        code.focus();
        return;
      }
      applyToken(out.token, out.user);
      await afterSignIn(nextTarget());
    } catch (error) { showError(form, error); }
    finally { busy(form, false); }
  });

  return [form, el('p', { class: 'm-auth__alt' },
    'New here? ', el('a', { href: path('/register') }, 'Create an account'), ' \u00b7 ',
    el('a', { href: path('/forgot') }, 'Forgot password?'))];
}

function registerForm() {
  const username = textInput({ name: 'username', autocomplete: 'username' });
  const display = textInput({ name: 'displayName' });
  const email = textInput({ name: 'email', type: 'email' });
  const password = textInput({ name: 'password', type: 'password', autocomplete: 'new-password' });
  const form = el('form', { class: 'm-auth__form' },
    field({ label: 'Username', control: username }),
    field({ label: 'Display name', control: display }),
    field({ label: 'Email (optional)', control: email }),
    field({ label: 'Password', control: password }),
    el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'submit' }, 'Create account'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    try {
      const out = await Api.register({
        username: username.value.trim(),
        displayName: display.value.trim() || undefined,
        email: email.value.trim() || undefined,
        password: password.value,
        termsVersion: '1.0',
        privacyVersion: '1.0',
      });
      if (out && out.token) {
        applyToken(out.token, out.user);
        await afterSignIn('/home');
      } else {
        toast('Account created. Check your email to continue.', { type: 'success' });
        navigate('/login', { replace: true });
      }
    } catch (error) { showError(form, error); }
    finally { busy(form, false); }
  });
  return [form, el('p', { class: 'm-auth__alt' }, 'Already have an account? ', el('a', { href: path('/login') }, 'Sign in'))];
}

function forgotForm() {
  const email = textInput({ name: 'email', type: 'email' });
  const form = el('form', { class: 'm-auth__form' },
    field({ label: 'Email address', control: email }),
    el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'submit' }, 'Send reset link'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    try {
      await Api.forgotPassword({ email: email.value.trim() });
      toast('If that address exists, a reset link is on its way.', { type: 'success' });
      navigate('/login');
    } catch (error) { showError(form, error); }
    finally { busy(form, false); }
  });
  return [form, el('p', { class: 'm-auth__alt' }, el('a', { href: path('/login') }, 'Back to sign in'))];
}

function resetForm(token) {
  const next = textInput({ name: 'newPassword', type: 'password', autocomplete: 'new-password' });
  const confirm = textInput({ name: 'confirmPassword', type: 'password', autocomplete: 'new-password' });
  const form = el('form', { class: 'm-auth__form' },
    field({ label: 'New password', control: next }),
    field({ label: 'Confirm new password', control: confirm }),
    el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'submit' }, 'Set new password'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    try {
      await Api.resetPassword({ token, newPassword: next.value, confirmPassword: confirm.value });
      toast('Password set. Sign in with it.', { type: 'success' });
      navigate('/login', { replace: true });
    } catch (error) { showError(form, error); }
    finally { busy(form, false); }
  });
  return [form, el('p', { class: 'm-auth__alt' }, el('a', { href: path('/login') }, 'Back to sign in'))];
}

function verifyPanel(token) {
  const status = el('p', { class: 'm-auth__sub' }, 'Checking this link...');
  const form = el('form', { class: 'm-auth__form' });
  (async () => {
    try {
      await Api.verifyEmail({ token });
      status.textContent = 'Your email is verified.';
      form.appendChild(el('a', { class: 'm-btn m-btn--primary m-btn--block', href: path('/login') }, 'Sign in'));
    } catch (error) {
      status.textContent = error && error.message ? error.message : 'That link did not work.';
      form.appendChild(el('a', { class: 'm-btn m-btn--block', href: path('/login') }, 'Go to sign in'));
    }
  })();
  return [status, form];
}

function twoStepPanel() {
  const host = el('div', { class: 'm-auth__form' });
  const saved = { password: '' };
  function swap(node) { host.replaceChildren(node); }

  function passwordStep() {
    const password = textInput({ name: 'password', type: 'password', autocomplete: 'current-password' });
    const form = el('form', { class: 'm-auth__form' },
      field({ label: 'Password', control: password }),
      el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'submit' }, 'Continue'));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      busy(form, true);
      try {
        const out = await Api.twoFactorSetup({ password: password.value });
        saved.password = password.value;
        swap(codeStep(out && out.secret ? out.secret : ''));
      } catch (error) { showError(form, error); }
      finally { busy(form, false); }
    });
    return form;
  }

  function codeStep(secret) {
    const code = textInput({ name: 'code', inputmode: 'numeric' });
    const form = el('form', { class: 'm-auth__form' },
      field({ label: 'Secret', control: el('code', { class: 'm-secret' }, secret) }),
      field({ label: 'Code from your app', control: code }),
      el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'submit' }, 'Turn on two-step sign-in'));
    code.focus();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      busy(form, true);
      try {
        const out = await Api.twoFactorEnable({ password: saved.password, code: code.value.trim() });
        swap(codesStep(out && out.recoveryCodes ? out.recoveryCodes : []));
      } catch (error) { showError(form, error); }
      finally { busy(form, false); }
    });
    return form;
  }

  function codesStep(codes) {
    const done = el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'button' }, 'Sign in again');
    done.addEventListener('click', async () => {
      try { await logout(); } catch { /* dropped locally either way */ }
      navigate('/login', { replace: true });
    });
    return el('div', { class: 'm-auth__form' },
      el('p', { class: 'm-auth__sub' }, 'Save these now. Each signs you in once if you lose your authenticator.'),
      el('div', { class: 'm-codes' }, codes.map((value) => el('code', { class: 'm-secret' }, value))),
      done);
  }

  const signOut = el('button', {
    class: 'm-btn m-btn--ghost m-btn--block', type: 'button',
    onClick: async () => {
      try { await logout(); } catch { /* dropped locally either way */ }
      navigate('/login', { replace: true });
    },
  }, 'Sign out');

  swap(passwordStep());
  return [host, signOut];
}

export function renderAuth(page, params) {
  let built;
  let title;
  switch (page.id) {
    case 'register': {
      const [form, alt] = registerForm();
      built = [el('h1', { class: 'm-auth__title' }, 'Create your account'), form, alt];
      title = 'Create account';
      break;
    }
    case 'forgot': {
      const [form, alt] = forgotForm();
      built = [el('h1', { class: 'm-auth__title' }, 'Reset your password'), form, alt];
      title = 'Reset password';
      break;
    }
    case 'resetPassword': {
      const [form, alt] = resetForm(params.token);
      built = [el('h1', { class: 'm-auth__title' }, 'Choose a new password'), form, alt];
      title = 'New password';
      break;
    }
    case 'verifyEmail': {
      const [status, form] = verifyPanel(params.token);
      built = [el('h1', { class: 'm-auth__title' }, 'Verify your email'), status, form];
      title = 'Verify email';
      break;
    }
    case 'twoStep': {
      const [form, alt] = twoStepPanel();
      built = [
        el('h1', { class: 'm-auth__title' }, 'Two-step sign-in required'),
        el('p', { class: 'm-auth__sub' }, 'This instance asks every account for a second factor. Set one up to continue, or sign out.'),
        form, alt,
      ];
      title = 'Two-step sign-in';
      break;
    }
    default: {
      const [form, alt] = loginForm();
      built = [
        el('h1', { class: 'm-auth__title' }, 'Welcome back'),
        el('p', { class: 'm-auth__sub' }, 'Sign in to your communities.'),
        form, alt,
      ];
      title = 'Sign in';
    }
  }
  const node = el('div', { class: 'm-auth' },
    el('div', { class: 'm-auth__card' }, lockup(), ...built));
  return { raw: true, node, title };
}

export default { renderAuth };
