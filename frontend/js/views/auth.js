// Signing in, and the four screens that exist so it is recoverable.
//
// All of them share one shape - a statement of purpose, a form, a way onward -
// so they share one module. They render outside the workspace, because a person
// who is not signed in has no workspace to be inside.
//
// Module structure:
//   - lockup(): brand mark and name
//   - brandSide(): left panel with pitch and features
//   - input(): form input factory
//   - loginForm(), registerForm(), forgotForm(), resetForm(), verifyPanel(), twoStepForm()
//   - renderAuth(): router entry point

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { brandSymbolUrl } from '../../packages/brand.js';
import Api from '../../packages/api.js';
import { currentQuery, navigate, publicPath } from '../../packages/nav.js';
import { applyToken, loadSession, logout, refreshServers } from '../../packages/store.js';
import { connect } from '../../packages/realtime.js';
import { toast } from '../ui/overlays.js';

// -- brand elements -----------------------------------------------------------

function lockup() {
  return el('div', { class: 'auth-lockup' },
    el('img', { class: 'auth-lockup-mark', alt: '', src: brandSymbolUrl, width: '38', height: '38' }),
    el('span', { class: 'auth-lockup-name' }, 'Trycord'),
  );
}

function brandSide() {
  return el('aside', { class: 'auth-brandside' },
    lockup(),
    el('div', { class: 'auth-pitch' },
      el('h2', {}, 'Communities that own their communication.'),
      el('p', {}, 'Trycord is a self-hostable chat and voice platform. Your instance, your members, your data - no middle layer.'),
      el('div', { class: 'auth-points' },
        point('shield', 'Runs on your own hardware'),
        point('users', 'Communities, channels and roles'),
        point('volume', 'Voice and video, when you want them'),
      ),
    ),
    el('div', { class: 'auth-foot' }, 'Trycord - open source, self-hosted, unaffiliated.'),
  );
}

function point(name, text) {
  return el('div', { class: 'auth-point' }, icon(name, { size: 20 }), el('span', {}, text));
}

// -- form helpers ------------------------------------------------------------

function input(name, options) {
  const opts = options || {};
  return el('input', {
    class: 'input', name, type: opts.type || 'text',
    placeholder: opts.placeholder || null,
    autocomplete: opts.autocomplete || 'off',
    required: opts.required !== false,
    autofocus: opts.autofocus ? '' : null,
    spellcheck: 'false', autocapitalize: 'none',
  });
}

function busy(form, isBusy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = isBusy;
  form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

function errorElHide(form) {
  const el = form.querySelector('.form-error');
  if (el) el.hidden = true;
}

function showError(form, error) {
  const el = form.querySelector('.form-error');
  if (el) { el.hidden = false; el.textContent = (error && error.message) || 'Something went wrong.'; }
}

async function afterSignIn(next) {
  let user;
  try {
    user = await loadSession();
  } catch (error) {
    if (error && error.code === 'MFA_REQUIRED') {
      navigate('/two-step', { replace: true });
      return;
    }
    throw error;
  }
  if (!user) return;
  await Promise.all([refreshServers().catch(() => {})]);
  connect();
  navigate(next || '/home', { replace: true });
}

function nextTarget() {
  const query = currentQuery();
  const next = query.get('next');
  if (!next) return '/home';
  if (next.charAt(0) !== '/' || next.indexOf('//') === 0) return '/home';
  return next;
}

// -- login -------------------------------------------------------------------

function loginForm() {
  const username = input('username');
  const password = Object.assign(input('password'), { type: 'password' });
  const code = Object.assign(input('code', { required: false }), { type: 'text' });
  const mfaField = el('label', { class: 'field', hidden: true }, el('span', {}, 'Two-step code'), code);

  const form = el('form', { class: 'auth-form' },
    el('label', { class: 'field' }, el('span', {}, 'Username or email'), username),
    el('label', { class: 'field' }, el('span', {}, 'Password'), password),
    mfaField,
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Sign in'),
  );

  let challenge = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    errorElHide(form);
    try {
      if (challenge) {
        const out = await Api.twoFactorVerify({ challengeToken: challenge, code: code.value.trim() });
        applyToken(out.token, out.user);
        toast('Signed in.', { type: 'success' });
        await afterSignIn(nextTarget());
        return;
      }
      const out = await Api.login({ username: username.value.trim(), password: password.value });
      if (out && out.mfaRequired) {
        challenge = out.challengeToken;
        mfaField.hidden = false;
        code.required = true;
        code.focus();
        return;
      }
      applyToken(out.token, out.user);
      toast('Signed in.', { type: 'success' });
      await afterSignIn(nextTarget());
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });

  return [
    form,
    el('p', { class: 'auth-alt' },
      'New here? ',
      el('a', { href: publicPath('/register') }, 'Create an account'),
      ' \u00b7 ',
      el('a', { href: publicPath('/forgot') }, 'Forgot password?'),
    ),
  ];
}

// -- register ----------------------------------------------------------------

function registerForm() {
  const username = input('username');
  const display = input('displayName');
  const email = input('email', { type: 'email', autocomplete: 'email' });
  const password = Object.assign(input('password'), { type: 'password', autocomplete: 'new-password' });
  const confirm = Object.assign(input('confirm'), { type: 'password', autocomplete: 'new-password' });

  const form = el('form', { class: 'auth-form' },
    el('label', { class: 'field' }, el('span', {}, 'Username'), username),
    el('label', { class: 'field' }, el('span', {}, 'Display name (optional)'), display),
    el('label', { class: 'field' }, el('span', {}, 'Email (optional)'), email),
    el('label', { class: 'field' }, el('span', {}, 'Password'), password),
    el('label', { class: 'field' }, el('span', {}, 'Confirm password'), confirm),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Create account'),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    errorElHide(form);
    if (password.value !== confirm.value) {
      showError(form, { message: 'Passwords do not match.' });
      busy(form, false);
      return;
    }
    try {
      const out = await Api.register({
        username: username.value.trim(),
        displayName: display.value.trim() || undefined,
        email: email.value.trim() || undefined,
        password: password.value,
      });
      if (out && out.token) {
        applyToken(out.token, out.user);
        toast('Account created.', { type: 'success' });
        await afterSignIn(nextTarget());
      } else {
        navigate('/login', { replace: true });
      }
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });

  return [
    form,
    el('p', { class: 'auth-alt' }, 'Already have an account? ', el('a', { href: publicPath('/login') }, 'Sign in')),
  ];
}

// -- forgot / reset ----------------------------------------------------------

function forgotForm() {
  const username = input('username');
  const form = el('form', { class: 'auth-form' },
    el('label', { class: 'field' }, el('span', {}, 'Username or email'), username),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Send reset link'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    errorElHide(form);
    try {
      await Api.forgotPassword({ username: username.value.trim() });
      toast('If that account exists, a reset link has been sent.', { type: 'info' });
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });
  return [
    form,
    el('p', { class: 'auth-alt' }, el('a', { href: publicPath('/login') }, 'Back to sign in')),
  ];
}

function resetForm(token) {
  const password = Object.assign(input('password'), { type: 'password', autocomplete: 'new-password' });
  const confirm = Object.assign(input('confirm'), { type: 'password', autocomplete: 'new-password' });
  const form = el('form', { class: 'auth-form' },
    el('label', { class: 'field' }, el('span', {}, 'New password'), password),
    el('label', { class: 'field' }, el('span', {}, 'Confirm password'), confirm),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Reset password'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    errorElHide(form);
    if (password.value !== confirm.value) {
      showError(form, { message: 'Passwords do not match.' });
      busy(form, false);
      return;
    }
    try {
      await Api.resetPassword({ token, password: password.value });
      toast('Password reset. Sign in with your new password.', { type: 'success' });
      navigate('/login', { replace: true });
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });
  return [
    form,
    el('p', { class: 'auth-alt' }, el('a', { href: publicPath('/login') }, 'Back to sign in')),
  ];
}

function verifyPanel(token) {
  const wrap = el('div', { class: 'auth-form' });
  const status = el('div', { class: 'auth-note' }, 'Verifying your email\u2026');
  wrap.appendChild(status);
  (async () => {
    try {
      await Api.verifyEmail({ token });
      status.textContent = 'Email verified. You can sign in now.';
      wrap.appendChild(el('a', { class: 'btn btn--primary btn--block', href: publicPath('/login') }, 'Sign in'));
    } catch (error) {
      status.textContent = (error && error.message) || 'Verification failed.';
      wrap.appendChild(el('a', { class: 'btn btn--default', href: publicPath('/login') }, 'Go to sign in'));
    }
  })();
  return [wrap];
}

// -- two-step enrolment ------------------------------------------------------

function twoStepForm() {
  const password = Object.assign(input('password'), { type: 'password', autocomplete: 'current-password' });
  const code = Object.assign(input('code', { required: false }), { type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code' });
  const secret = el('code', { class: 'secret-code' });
  const body = el('div', { class: 'auth-form' }, el('label', { class: 'field' }, el('span', {}, 'Password'), password));
  const error = el('div', { class: 'form-error', hidden: true });
  let phase = 1;
  let savedPassword = null;

  const next = el('button', { class: 'btn btn--primary btn--block', type: 'button' }, 'Continue');
  next.addEventListener('click', async () => {
    error.hidden = true;
    next.disabled = true;
    try {
      if (phase === 1) {
        if (!password.value) { error.hidden = false; error.textContent = 'Enter your password.'; return; }
        const out = await Api.twoFactorSetup({ password: password.value });
        savedPassword = password.value;
        body.replaceChildren(
          el('label', { class: 'field' }, el('span', {}, 'Secret'), secret),
          el('label', { class: 'field' }, el('span', {}, 'Six digits'), code));
        secret.textContent = (out && out.secret) || '';
        next.textContent = 'Turn on';
        phase = 2;
        code.focus();
      } else {
        if (!/^\d{6}$/.test(code.value.trim())) { error.hidden = false; error.textContent = 'Enter the six digits the app shows.'; return; }
        const out = await Api.twoFactorEnable({ password: savedPassword, code: code.value.trim() });
        toast('Two-step sign-in is on.', { type: 'success' });
        navigate('/login', { replace: true });
        if (out && out.recoveryCodes && out.recoveryCodes.length) {
          // Show recovery codes
        }
      }
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'That did not work.';
    } finally {
      next.disabled = false;
    }
  });

  const card = el('div', { class: 'auth-form' },
    body,
    error,
    next,
    el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: () => navigate('/login') }, 'Cancel'),
  );

  return [card];
}

// -- shared ------------------------------------------------------------------
// (showError and errorElHide defined above)

// -- the pages ---------------------------------------------------------------

export function renderAuth(page, params) {
  const next = nextTarget();
  let body;
  switch (page.id) {
    case 'login': body = loginForm(); break;
    case 'register': body = registerForm(); break;
    case 'forgot': body = forgotForm(); break;
    case 'resetPassword': body = resetForm(params && params.token); break;
    case 'verifyEmail': body = verifyPanel(params && params.token); break;
    case 'twoStep': body = twoStepForm(); break;
    default: body = loginForm();
  }

  const brandside = brandSide();
  const formSide = el('div', { class: 'auth-formside' },
    el('div', { class: 'auth-lockup' }, lockup()),
    el('div', { class: 'auth-formwrap' },
      el('h1', { class: 'auth-title' }, titleFor(page.id)),
      el('p', { class: 'auth-sub' }, subtitleFor(page.id)),
      ...body,
    ),
  );

  return el('div', { class: 'auth' }, brandside, formSide);
}

function titleFor(id) {
  switch (id) {
    case 'register': return 'Create your account';
    case 'forgot': return 'Reset your password';
    case 'resetPassword': return 'Choose a new password';
    case 'verifyEmail': return 'Verify your email';
    case 'twoStep': return 'Set up two-step sign-in';
    default: return 'Sign in';
  }
}

function subtitleFor(id) {
  switch (id) {
    case 'register': return 'A username and a password is all it takes.';
    case 'forgot': return 'We will send a link if the account exists.';
    case 'resetPassword': return 'Eight characters or more.';
    case 'verifyEmail': return 'Confirming your address.';
    case 'twoStep': return 'Add a code from an authenticator app as a second step.';
    default: return 'Welcome back.';
  }
}

export default { renderAuth };