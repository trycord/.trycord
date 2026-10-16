// Signing in, and the four screens that exist so it is recoverable.
//
// All of them share one shape - a statement of purpose, a form, a way onward -
// so they share one module. They render outside the workspace, because a person
// who is not signed in has no workspace to be inside.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { brandSymbolUrl } from '../../packages/brand.js';
import Api from '../../packages/api.js';
import { currentQuery, navigate, path } from '../../packages/nav.js';
import { applyToken, loadSession, logout, refreshServers } from '../../packages/store.js';
import { connect } from '../../packages/realtime.js';
import { toast } from '../ui.js';

function lockup() {
  return el('div', { class: 'auth-lockup' },
    el('img', {
      class: 'auth-lockup-mark', alt: '',
      src: brandSymbolUrl,
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

function fieldBlock(label, control) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control);
}

function busy(form, isBusy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = isBusy;
  form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
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
  if (next.charAt(0) !== '/' || next.indexOf('//') === 0) return '/home';
  return next;
}

// -- login -------------------------------------------------------------------

function loginForm() {
  const username = input('username', { autofocus: true });
  const password = Object.assign(input('password'), { type: 'password' });
  const code = Object.assign(input('code', { required: false }), { type: 'text' });
  const mfaField = el('label', { class: 'field', hidden: true }, el('span', {}, 'Two-step code'), code);

  const form = el('form', { class: 'auth-form' },
    fieldBlock('Username or email', username),
    fieldBlock('Password', password),
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
    el('div', { class: 'auth-card' },
      el('h1', { class: 'auth-title' }, 'Welcome back'),
      el('p', { class: 'auth-sub' }, 'Sign in to your communities.'),
      form),
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
  const username = input('username', { autofocus: true });
  const display = input('displayName');
  const email = Object.assign(input('email', { required: false }), { type: 'email' });
  const password = Object.assign(input('password'), { type: 'password' });
  const form = el('form', { class: 'auth-form' },
    fieldBlock('Username', username),
    fieldBlock('Display name', display),
    fieldBlock('Email (optional)', email),
    fieldBlock('Password', password),
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

  return [
    el('div', { class: 'auth-card' },
      el('h1', { class: 'auth-title' }, 'Create your account'),
      el('p', { class: 'auth-sub' }, 'It takes a moment. You can change everything afterwards.'),
      form),
    el('p', { class: 'auth-alt' }, 'Already have an account? ', el('a', { href: path('/login') }, 'Sign in'))];
}

// -- forgot / reset ----------------------------------------------------------

function forgotForm() {
  const email = Object.assign(input('email', { autofocus: true }), { type: 'email' });
  const form = el('form', { class: 'auth-form' },
    fieldBlock('Email address', email),
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

  return [
    el('div', { class: 'auth-card' },
      el('h1', { class: 'auth-title' }, 'Reset your password'),
      el('p', { class: 'auth-sub' }, 'We will email you a link that expires shortly.'),
      form),
    el('p', { class: 'auth-alt' }, el('a', { href: path('/login') }, 'Back to sign in'))];
}

function resetForm(token) {
  const next = Object.assign(input('newPassword', { autofocus: true }), { type: 'password' });
  const confirm = Object.assign(input('confirmPassword'), { type: 'password' });
  const form = el('form', { class: 'auth-form' },
    fieldBlock('New password', next),
    fieldBlock('Confirm new password', confirm),
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

  return [
    el('div', { class: 'auth-card' },
      el('h1', { class: 'auth-title' }, 'Choose a new password'),
      el('p', { class: 'auth-sub' }, 'At least eight characters.'),
      form),
    el('p', { class: 'auth-alt' }, el('a', { href: path('/login') }, 'Back to sign in'))];
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

// -- two-step enrolment ------------------------------------------------------

function twoStepForm() {
  const host = el('div', { class: 'auth-form' });
  const saved = { password: '' };

  function swap(node) { host.replaceChildren(node); }

  function passwordStep() {
    const password = Object.assign(input('password', { autocomplete: 'current-password' }), { type: 'password' });
    const form = el('form', { class: 'auth-form' },
      fieldBlock('Password', password),
      el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Continue'),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      busy(form, true);
      try {
        const out = await Api.twoFactorSetup({ password: password.value });
        saved.password = password.value;
        swap(codeStep(out && out.secret ? out.secret : ''));
      } catch (error) {
        showError(form, error);
      } finally {
        busy(form, false);
      }
    });
    return form;
  }

  function codeStep(secretValue) {
    const code = Object.assign(input('code', { autocomplete: 'one-time-code' }), { type: 'text', inputmode: 'numeric' });
    const form = el('form', { class: 'auth-form' },
      fieldBlock('Secret', el('code', { class: 'secret-code' }, secretValue)),
      fieldBlock('Code from the app', code),
      el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Turn on two-step sign-in'),
    );
    code.focus();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      busy(form, true);
      try {
        const out = await Api.twoFactorEnable({ password: saved.password, code: code.value.trim() });
        swap(codesStep(out && out.recoveryCodes ? out.recoveryCodes : []));
      } catch (error) {
        showError(form, error);
      } finally {
        busy(form, false);
      }
    });
    return form;
  }

  function codesStep(codes) {
    const done = el('button', { class: 'btn btn--primary btn--block', type: 'button' }, 'Sign in');
    done.addEventListener('click', async () => {
      try { await logout(); } catch { /* the local token is dropped either way */ }
      navigate('/login', { replace: true });
    });
    return el('div', { class: 'auth-form' },
      el('div', { class: 'stack stack--tight' },
        el('p', { class: 'auth-sub' }, 'Save these now. Each one signs you in once if you lose your authenticator, and this is the only time they are shown.'),
        el('div', { class: 'recovery-codes' }, codes.map((value) => el('code', { class: 'secret-code' }, value))),
      ),
      done,
    );
  }

  const signOut = el('button', {
    class: 'btn btn--ghost', type: 'button',
    onClick: async () => {
      try { await logout(); } catch { /* the local token is dropped either way */ }
      navigate('/login', { replace: true });
    },
  }, 'Sign out');

  swap(passwordStep());
  return [
    el('div', { class: 'auth-card' },
      el('h1', { class: 'auth-title' }, 'Two-step sign-in required'),
      el('p', { class: 'auth-sub' }, 'This instance asks every account for a second factor. Set one up to continue, or sign out.'),
      host),
    el('p', { class: 'auth-alt' }, signOut)];
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
      built = [form, alt];
      title = 'Create account';
      break;
    }
    case 'forgot': {
      const [form, alt] = forgotForm();
      built = [form, alt];
      title = 'Reset password';
      break;
    }
    case 'resetPassword': {
      const [form, alt] = resetForm(params.token);
      built = [form, alt];
      title = 'New password';
      break;
    }
    case 'verifyEmail': {
      const [verification, form, alt] = verifyPanel(params.token);
      built = [verification, form, alt];
      title = 'Verify email';
      break;
    }
    case 'twoStep': {
      const [form, alt] = twoStepForm();
      built = [form, alt];
      title = 'Two-step sign-in';
      break;
    }
    default: {
      const [form, alt] = loginForm();
      built = [form, alt];
      title = 'Sign in';
    }
  }
  return { raw: true, node: el('div', { class: 'auth auth-page' }, brandSide(), el('div', { class: 'auth-formside' }, el('div', { class: 'auth-formwrap' }, lockup(), ...built))), title };
}

export default { renderAuth };
