// Signing in, and the four screens that exist so it is recoverable.
//
// All of them share one shape - a statement of purpose, a form, a way onward -
// so they share one module. They render outside the workspace, because a person
// who is not signed in has no workspace to be inside.

import { el } from '../dom.js';
import { icon } from '../icons.js';
import Api from '../api.js';
import { currentQuery, navigate, path } from '../nav.js';
import { applyToken, loadSession, refreshServers } from '../store.js';
import { connect } from '../realtime.js';
import { toast } from '../ui.js';

function lockup() {
  return el('div', { class: 'auth-lockup' },
    el('img', {
      class: 'auth-lockup-mark', alt: '',
      src: 'assets/trycord-assets/brand/trycord-symbol.svg',
      width: '38', height: '38',
    }),
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

function input(name, options) {
  const opts = options || {};
  return el('input', {
    class: 'input',
    name,
    type: opts.type || 'text',
    placeholder: opts.placeholder || null,
    autocomplete: opts.autocomplete || 'off',
    required: opts.required !== false,
    autofocus: opts.autofocus ? '' : null,
    spellcheck: 'false',
    autocapitalize: 'none',
  });
}

function busy(form, isBusy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = isBusy;
  form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

async function afterSignIn(next) {
  const user = await loadSession();
  if (!user) return;
  await Promise.all([
    refreshServers().catch(() => {}),
  ]);
  connect();
  navigate(next || '/home', { replace: true });
}

function nextTarget() {
  const query = currentQuery();
  const next = query.get('next');
  if (!next) return '/home';
  // Only in-app destinations, so a crafted link cannot bounce someone outward.
  if (next.charAt(0) !== '/' || next.indexOf('//') === 0) return '/home';
  return next;
}

// -- login -------------------------------------------------------------------

function loginForm() {
  const username = input('username');
  const password = Object.assign(input('password'), { type: 'password' });
  const code = Object.assign(input('code'), { type: 'text', hidden: true });
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
      el('a', { href: path('/register') }, 'Create an account'),
      ' - ',
      el('a', { href: path('/forgot') }, 'Forgot password?'),
    ),
  ];
}

// -- register ----------------------------------------------------------------

function registerForm() {
  const username = input('username');
  const display = input('displayName');
  const email = Object.assign(input('email'), { type: 'email' });
  const password = Object.assign(input('password'), { type: 'password' });
  const form = el('form', { class: 'auth-form' },
    el('label', { class: 'field' }, el('span', {}, 'Username'), username),
    el('label', { class: 'field' }, el('span', {}, 'Display name'), display),
    el('label', { class: 'field' }, el('span', {}, 'Email (optional)'), email),
    el('label', { class: 'field' }, el('span', {}, 'Password'), password),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Create account'),
  );

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
        toast('Welcome to Trycord.', { type: 'success' });
        await afterSignIn('/home');
      } else {
        toast('Account created. Check your email to continue.', { type: 'success' });
        navigate('/login', { replace: true });
      }
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });

  return [form, el('p', { class: 'auth-alt' }, 'Already have an account? ', el('a', { href: path('/login') }, 'Sign in'))];
}

// -- forgot / reset ----------------------------------------------------------

function forgotForm() {
  const email = Object.assign(input('email'), { type: 'email' });
  const form = el('form', { class: 'auth-form' },
    el('label', { class: 'field' }, el('span', {}, 'Email address'), email),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Send reset link'),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    try {
      await Api.forgotPassword({ email: email.value.trim() });
      toast('If that address exists, a reset link is on its way.', { type: 'success' });
      navigate('/login');
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });

  return [form, el('p', { class: 'auth-alt' }, el('a', { href: path('/login') }, 'Back to sign in'))];
}

function resetForm(token) {
  const next = Object.assign(input('newPassword'), { type: 'password' });
  const confirm = Object.assign(input('confirmPassword'), { type: 'password' });
  const form = el('form', { class: 'auth-form' },
    el('label', { class: 'field' }, el('span', {}, 'New password'), next),
    el('label', { class: 'field' }, el('span', {}, 'Confirm new password'), confirm),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Set new password'),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    try {
      await Api.resetPassword({ token, newPassword: next.value, confirmPassword: confirm.value });
      toast('Password set. Sign in with it.', { type: 'success' });
      navigate('/login', { replace: true });
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });

  return [form, el('p', { class: 'auth-alt' }, el('a', { href: path('/login') }, 'Back to sign in'))];
}

function verifyPanel(token) {
  const form = el('form', { class: 'auth-form' });
  const status = el('p', { class: 'auth-sub' }, 'Checking this link...');
  const wrap = el('div', {}, status);
  (async () => {
    try {
      await Api.verifyEmail({ token });
      status.textContent = 'Your email is verified.';
      form.appendChild(el('a', { class: 'btn btn--primary btn--block', href: path('/login') }, 'Sign in'));
    } catch (error) {
      status.textContent = error && error.message ? error.message : 'That link did not work.';
      form.appendChild(el('a', { class: 'btn btn--default', href: path('/login') }, 'Go to sign in'));
    }
  })();
  return [wrap, form, el('p', { class: 'auth-alt' }, el('a', { href: path('/login') }, 'Back to sign in'))];
}

// -- shared ------------------------------------------------------------------

function errorElHide(form) {
  const existing = form.querySelector('.form-error');
  if (existing) existing.remove();
}

function showError(form, error) {
  const message = error && error.message ? error.message : 'That did not work.';
  let box = form.querySelector('.form-error');
  if (!box) {
    box = el('div', { class: 'form-error', role: 'alert' });
    form.insertBefore(box, form.firstChild);
  }
  box.textContent = message;
}

// -- the pages ---------------------------------------------------------------

export function renderAuth(page, params) {
  let built;
  let title;
  switch (page.id) {
    case 'register': {
      const [form, alt] = registerForm();
      built = [
        el('h1', { class: 'auth-title' }, 'Create your account'),
        el('p', { class: 'auth-sub' }, 'It takes a moment. You can change everything afterwards.'),
        form, alt,
      ];
      title = 'Create account';
      break;
    }
    case 'forgot': {
      const [form, alt] = forgotForm();
      built = [
        el('h1', { class: 'auth-title' }, 'Reset your password'),
        el('p', { class: 'auth-sub' }, 'We will email you a link that expires shortly.'),
        form, alt,
      ];
      title = 'Reset password';
      break;
    }
    case 'resetPassword': {
      const [form, alt] = resetForm(params.token);
      built = [
        el('h1', { class: 'auth-title' }, 'Choose a new password'),
        el('p', { class: 'auth-sub' }, 'At least eight characters.'),
        form, alt,
      ];
      title = 'New password';
      break;
    }
    case 'verifyEmail': {
      const [verification, form, alt] = verifyPanel(params.token);
      built = [
        el('h1', { class: 'auth-title' }, 'Verify your email'),
        verification, form, alt,
      ];
      title = 'Verify email';
      break;
    }
    default: {
      const [form, alt] = loginForm();
      built = [
        el('h1', { class: 'auth-title' }, 'Welcome back'),
        el('p', { class: 'auth-sub' }, 'Sign in to your communities.'),
        form, alt,
      ];
      title = 'Sign in';
    }
  }
  return { raw: true, node: el('div', { class: 'auth auth-page' }, brandSide(), el('div', { class: 'auth-formside' }, el('div', { class: 'auth-formwrap' }, lockup(), ...built))), title };
}

export default { renderAuth };
