// The gates.
//
// Six screens a reader meets before any workspace exists: sign in, account
// creation, password recovery, applying a reset, confirming an address, and
// enrolling a second factor. They mount into <body> as one .auth-page and the
// shell stays hidden underneath, because there is no workspace to stand in yet.
//
// The composition is new and deliberately plain: one centered gate, the brand
// mark small above it, the form asking for exactly one thing at a time. The
// only flourish is the ember hairline - this is a checkpoint, not a billboard.

import { el } from '../../packages/dom.js';
import { brandSymbolUrl } from '../../packages/brand.js';
import Api from '../../packages/api.js';
import TrycordConfig from '../../packages/config.js';
import { currentQuery, navigate, publicPath } from '../../packages/nav.js';
import { applyToken, loadSession, refreshServers } from '../../packages/store.js';
import { connect } from '../../packages/realtime.js';
import { toast } from '../ui/overlays.js';

// -- the gate frame -----------------------------------------------------------

export function gateCard() {
  return el('div', { class: 'gate-card' },
    el('a', { class: 'gate-mark', href: publicPath('/login'), 'aria-label': 'Trycord' },
      el('img', { class: 'gate-mark-img', src: brandSymbolUrl, alt: '', width: '30', height: '30' }),
      el('span', {}, 'Trycord')),
  );
}

function gate(title, lede, body) {
  const card = gateCard();
  card.appendChild(el('h1', { class: 'gate-title' }, title));
  if (lede) card.appendChild(el('p', { class: 'gate-lede' }, lede));
  for (const child of [].concat(body)) card.appendChild(child);
  return { raw: true, node: el('div', { class: 'auth-page' }, card), title };
}

function input(name, options) {
  const opts = options || {};
  return el('input', {
    class: 'input', name, type: opts.type || 'text',
    placeholder: opts.placeholder || null,
    autocomplete: opts.autocomplete || 'off',
    required: opts.required !== false,
    spellcheck: 'false', autocapitalize: 'none',
  });
}

function field(label, control) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control);
}

function gateForm(fields, submitLabel) {
  return el('form', { class: 'gate-form' },
    fields,
    el('p', { class: 'form-error', hidden: true }),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, submitLabel),
  );
}

function busy(form, isBusy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = isBusy;
  form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

function showError(form, error) {
  const node = form.querySelector('.form-error');
  if (node) { node.hidden = false; node.textContent = (error && error.message) || 'Something went wrong.'; }
}

function clearError(form) {
  const node = form.querySelector('.form-error');
  if (node) node.hidden = true;
}

// -- landing after a sign-in --------------------------------------------------

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
  await refreshServers().catch(() => { /* the workspace loads them again */ });
  connect();
  navigate(next || '/home', { replace: true });
}

// The ?next= value is followed only when it is an in-app path: anything that
// could point at another origin is ignored, not sanitized.
function nextTarget() {
  const next = currentQuery().get('next');
  if (!next) return '/home';
  if (next.charAt(0) !== '/' || next.indexOf('//') === 0) return '/home';
  return next;
}

function altLine(...parts) {
  return el('p', { class: 'gate-alt' }, ...parts);
}

// -- sign in ------------------------------------------------------------------

function loginGate() {
  const username = input('username');
  const password = input('password', { type: 'password', autocomplete: 'current-password' });
  const code = input('code', { type: 'text', required: false, autocomplete: 'one-time-code' });
  const codeField = field('Two-step code', code);
  codeField.hidden = true;

  const form = gateForm([
    field('Username or email', username),
    field('Password', password),
    codeField,
  ], 'Sign in');

  let challenge = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
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
        codeField.hidden = false;
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

  return [form, altLine(
    'New here? ',
    el('a', { href: publicPath('/register') }, 'Create an account'),
    ' \u00b7 ',
    el('a', { href: publicPath('/forgot') }, 'Forgot password?'))];
}

// -- account creation ---------------------------------------------------------

function registerGate() {
  const username = input('username');
  const display = input('displayName', { required: false });
  const email = input('email', { type: 'email', required: false, autocomplete: 'email' });
  const password = input('password', { type: 'password', autocomplete: 'new-password' });
  const confirm = input('confirm', { type: 'password', required: false, autocomplete: 'new-password' });

  // The instance in force, named on the form. An account made here belongs to
  // this instance, so the reader is told which one before they type, and the
  // way to another instance is one click away.
  const instanceNote = el('p', { class: 'gate-instance' },
    el('span', {}, 'Joining '),
    el('strong', { class: 'gate-instance-name' }, TrycordConfig.backendUrl()),
    ' ',
    el('a', { href: publicPath('/instances') }, 'Use another instance'));

  const form = gateForm([
    field('Username', username),
    field('Display name (optional)', display),
    field('Email (optional)', email),
    field('Password', password),
    field('Confirm password', confirm),
  ], 'Create account');
  form.insertBefore(instanceNote, form.firstChild);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
    if (confirm.value !== password.value) {
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

  return [form, altLine('Already here? ', el('a', { href: publicPath('/login') }, 'Sign in'))];
}

// -- recovery -----------------------------------------------------------------

function forgotGate() {
  const username = input('username');
  const form = gateForm([field('Username or email', username)], 'Send reset link');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
    try {
      await Api.forgotPassword({ username: username.value.trim() });
      toast('If that account exists, a reset link has been sent.', { type: 'info' });
    } catch (error) {
      showError(form, error);
    } finally {
      busy(form, false);
    }
  });
  return [form, altLine(el('a', { href: publicPath('/login') }, 'Back to sign in'))];
}

function resetGate(token) {
  const password = input('password', { type: 'password', autocomplete: 'new-password' });
  const confirm = input('confirm', { type: 'password', required: false, autocomplete: 'new-password' });
  const form = gateForm([
    field('New password', password),
    field('Confirm password', confirm),
  ], 'Reset password');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
    if (confirm.value !== password.value) {
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
  return [form, altLine(el('a', { href: publicPath('/login') }, 'Back to sign in'))];
}

// -- confirming an address ----------------------------------------------------

function verifyGate(token) {
  const status = el('p', { class: 'gate-note', role: 'status' }, 'Confirming your address\u2026');
  const onward = el('div', { class: 'gate-choices' });

  (async () => {
    try {
      await Api.verifyEmail({ token });
      status.textContent = 'Email confirmed. You can sign in now.';
      onward.appendChild(el('a', { class: 'btn btn--primary btn--block', href: publicPath('/login') }, 'Sign in'));
    } catch (error) {
      status.textContent = (error && error.message) || 'That confirmation did not go through.';
      onward.appendChild(el('a', { class: 'btn btn--default', href: publicPath('/login') }, 'Go to sign in'));
    }
  })();

  return [el('div', { class: 'gate-form' }, status, onward)];
}

// -- enrolling a second factor ------------------------------------------------

function twoStepGate() {
  const password = input('password', { type: 'password', autocomplete: 'current-password' });
  const code = input('code', { type: 'text', required: false, autocomplete: 'one-time-code' });
  code.setAttribute('inputmode', 'numeric');
  code.setAttribute('maxlength', '6');

  const secret = el('code', { class: 'gate-secret' });
  const body = el('div', {}, field('Password', password));
  const error = el('p', { class: 'form-error', hidden: true });
  const submit = el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Continue');
  let phase = 1;
  let savedPassword = null;

  async function run() {
    error.hidden = true;
    submit.disabled = true;
    try {
      if (phase === 1) {
        if (!password.value) { error.hidden = false; error.textContent = 'Enter your password first.'; return; }
        const out = await Api.twoFactorSetup({ password: password.value });
        savedPassword = password.value;
        body.replaceChildren(
          field('Secret', secret),
          field('Six digits from the app', code));
        secret.textContent = (out && out.secret) || '';
        submit.textContent = 'Turn on';
        phase = 2;
        code.focus();
      } else {
        if (!/^\d{6}$/.test(code.value.trim())) {
          error.hidden = false; error.textContent = 'Enter the six digits the app shows.'; return;
        }
        await Api.twoFactorEnable({ password: savedPassword, code: code.value.trim() });
        toast('Two-step sign-in is on.', { type: 'success' });
        navigate('/login', { replace: true });
      }
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'That did not work.';
    } finally {
      submit.disabled = false;
    }
  }

  const form = el('form', { class: 'gate-form' }, body, error,
    el('div', { class: 'gate-choices' }, submit,
      el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: () => navigate('/login') }, 'Cancel')));
  form.addEventListener('submit', (event) => { event.preventDefault(); run(); });

  return [form];
}

// -- the gates ----------------------------------------------------------------

const COPIES = {
  register: ['Create your account', 'A username and a password is all it takes.'],
  forgot: ['Reset your password', 'We send a link if the account exists.'],
  resetPassword: ['Choose a new password', 'Eight characters or more.'],
  verifyEmail: ['Confirm your email', 'The link in your message lands here.'],
  twoStep: ['Add a second step', 'A code from an authenticator app, asked at every sign-in.'],
  login: ['Sign in', 'Welcome back.'],
};

export function renderAuth(page, params) {
  const id = page ? page.id : 'login';
  let body;
  switch (id) {
    case 'register': body = registerGate(); break;
    case 'forgot': body = forgotGate(); break;
    case 'resetPassword': body = resetGate(params && params.token); break;
    case 'verifyEmail': body = verifyGate(params && params.token); break;
    case 'twoStep': body = twoStepGate(); break;
    default: body = loginGate();
  }

  const [title, lede] = COPIES[id] || COPIES.login;
  return gate(title, lede, body);
}

export default { renderAuth };
