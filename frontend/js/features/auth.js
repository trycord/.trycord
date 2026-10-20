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
import { State, applyToken, loadLegal, loadSession, refreshServers } from '../../packages/store.js';
import { withLegalVersions, isStaleLegalError } from '../../packages/legal.js';
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
    el('div', { class: 'form-error', role: 'alert', hidden: true }),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, submitLabel),
  );
}

function busy(form, isBusy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = isBusy;
  form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

// The whole-form answer, with an optional control beside it: some refusals
// need an action (reload the page), not only a sentence.
function showError(form, error, action) {
  const node = form.querySelector('.form-error');
  if (!node) return;
  node.hidden = false;
  // The children are filtered rather than passed as they are:
  // `replaceChildren` renders a null argument as the text "null", and a sign-in
  // form that says "null" under the message is a bug somebody will report.
  node.replaceChildren(
    ...[
      el('span', {}, (error && error.message) || 'Something went wrong.'),
      action || null,
    ].filter(Boolean),
  );
}

function clearError(form) {
  const node = form.querySelector('.form-error');
  if (!node) return;
  node.hidden = true;
  node.replaceChildren();
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

// The acceptance of the documents.
//
// This is the one control on the registration form that a reader cannot do
// without, and it used to be the last line of a long form: a checkbox below
// five fields, with the submit button disabled and nothing saying why. On a
// phone that is below the fold, so the form simply looked broken.
//
// It is now a block of its own, above the fields, with a heading that says
// what it is, the two documents named as links that open in a new tab, the
// versions in force stated, and the state of the acceptance said in words
// rather than only shown by a tick.
//
// The server records the exact versions the reader accepted and refuses a
// registration whose versions are not the ones in force, so the form says
// which versions they are rather than sending a constant.
function legalAcceptance() {
  const accepted = el('input', {
    type: 'checkbox', name: 'legal', id: 'gate-legal-accepted',
  });
  const versions = el('span', { class: 'gate-legal-version' });
  const state = el('span', { class: 'gate-legal-state' });

  const terms = el('a', {
    href: publicPath('/terms'), target: '_blank', rel: 'noopener',
  }, 'Terms of Service');
  const privacy = el('a', {
    href: publicPath('/privacy'), target: '_blank', rel: 'noopener',
  }, 'Privacy Policy');

  const label = el('label', { class: 'checkbox gate-legal' },
    accepted,
    el('span', { class: 'gate-legal-text' },
      el('span', { class: 'gate-legal-title' },
        'I accept the ', terms, ' and the ', privacy),
      el('span', { class: 'gate-legal-meta' }, versions, ' ', state)));

  // The block around the control. It is what makes the control look like the
  // thing it is rather than another line of a form.
  const block = el('section', { class: 'gate-legal-block', 'aria-labelledby': 'gate-legal-heading' },
    el('h2', { class: 'gate-legal-heading', id: 'gate-legal-heading' },
      'Before you can join'),
    el('p', { class: 'gate-legal-lede' },
      'This instance runs on its own rules, and an account here is bound by them. '
      + 'Read both documents, then accept them.'),
    label);

  const paintVersions = () => {
    const legal = State.legal;
    versions.textContent = legal && legal.termsVersion
      ? 'Terms v' + legal.termsVersion + ', Privacy v' + legal.privacyVersion
        + (legal.updated ? ', updated ' + legal.updated : '') + '.'
      : 'This instance has not said which version is in force.';
    versions.classList.toggle('is-missing', !legal);
  };

  const paintState = () => {
    const on = !!accepted.checked;
    state.textContent = on ? 'Accepted.' : 'Not accepted yet.';
    block.classList.toggle('is-accepted', on);
  };

  accepted.addEventListener('change', paintState);
  paintVersions();
  paintState();

  return { accepted, label, block, paintVersions, paintState };
}

// Exported so a check can draw the registration form on its own. The form is
// the one screen every reader meets, and the one screen that cannot be
// checked through the router without a session and a mount.
export function registerGate() {
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

  const legal = legalAcceptance();

  const form = gateForm([
    field('Username', username),
    field('Display name (optional)', display),
    field('Email (optional)', email),
    field('Password', password),
    field('Confirm password (optional)', confirm),
  ], 'Create account');
  form.insertBefore(instanceNote, form.firstChild);
  // The documents come before the fields. A reader who is asked to accept
  // something after a form is asked to accept it after the form.
  form.insertBefore(legal.block, form.querySelector('.field'));

  const submit = form.querySelector('button[type="submit"]');
  // The button says why it is closed. A disabled control with no reason is
  // the control everybody works around.
  const submitNote = el('p', { class: 'gate-submit-note', role: 'status' });
  submit.insertAdjacentElement('afterend', submitNote);

  const syncSubmit = () => {
    submit.disabled = !legal.accepted.checked;
    submitNote.textContent = legal.accepted.checked
      ? ''
      : 'Accept the Terms of Service and the Privacy Policy to create an account.';
    legal.paintState();
  };
  legal.accepted.addEventListener('change', syncSubmit);
  syncSubmit();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!legal.accepted.checked) {
      showError(form, { message: 'Accept the Terms of Service and the Privacy Policy to continue.' });
      return;
    }
    busy(form, true);
    clearError(form);
    if (confirm.value !== password.value) {
      showError(form, { message: 'Passwords do not match.' });
      busy(form, false);
      return;
    }
    // The versions come from the instance, never from this file. The boot
    // sequence reads them; if that read failed, the form asks again rather
    // than sending a registration that could only be refused.
    if (!State.legal) {
      try { await loadLegal(); } catch { /* the refusal below says so */ }
      legal.paintVersions();
    }
    if (!State.legal) {
      showError(form, { message: 'This instance did not say which terms are in force. Reload the page and try again.' });
      busy(form, false);
      return;
    }
    try {
      const out = await Api.register(withLegalVersions({
        username: username.value.trim(),
        displayName: display.value.trim() || undefined,
        email: email.value.trim() || undefined,
        password: password.value,
      }, State.legal));
      if (out && out.token) {
        applyToken(out.token, out.user);
        toast('Account created.', { type: 'success' });
        await afterSignIn(nextTarget());
      } else {
        navigate('/login', { replace: true });
      }
    } catch (error) {
      if (isStaleLegalError(error)) {
        // The documents changed while this form was open. Nothing the reader
        // typed is wrong, so the answer says what to do about it.
        showError(form, {
          message: 'The Terms or Privacy Policy changed since this page was opened. Reload to read the current version.',
        }, el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => window.location.reload(),
        }, 'Reload'));
      } else {
        showError(form, error);
      }
    } finally {
      busy(form, false);
      // The button is closed again until the documents are accepted, whatever
      // the request did.
      syncSubmit();
    }
  });

  return [form, altLine('Already here? ', el('a', { href: publicPath('/login') }, 'Sign in'))];
}

// -- recovery -----------------------------------------------------------------

// The reset link is sent to the address on the account, so the form asks for
// an address and sends it under the name the endpoint reads. A username is
// not accepted here: the endpoint looks the account up by its verified
// address, and a name would silently find nothing.
function forgotGate() {
  const email = input('email', { type: 'email', autocomplete: 'email' });
  const form = gateForm([
    field('Email address', email),
    el('p', { class: 'gate-note' }, 'We send the link to the address on your account.'),
  ], 'Send reset link');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
    try {
      await Api.forgotPassword({ email: email.value.trim() });
      toast('If that address is on an account, a reset link has been sent.', { type: 'info' });
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
      const out = await Api.resetPassword({
        token,
        newPassword: password.value,
        confirmPassword: confirm.value,
      });
      // An account with a second factor gets a challenge rather than a
      // session: the password is changed, and the sign-in still owes the
      // second step.
      if (out && out.mfaRequired) {
        toast('Password reset. Sign in with your two-step code.', { type: 'success' });
      } else {
        toast('Password reset. Sign in with your new password.', { type: 'success' });
      }
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
        const done = await Api.twoFactorEnable({ password: savedPassword, code: code.value.trim() });
        toast('Two-step sign-in is on.', { type: 'success' });
        // The recovery codes are shown once and never again, so they are shown
        // here rather than being left in the answer the server sent.
        const codes = (done && (done.recoveryCodes || done.codes)) || [];
        if (codes.length) {
          form.replaceChildren(
            el('p', { class: 'gate-note' },
              'Save these now. Each one signs you in once if you lose your authenticator.'),
            el('pre', { class: 'recovery-codes' }, codes.join('\n')),
            el('div', { class: 'gate-choices' }, el('a', {
              class: 'btn btn--primary btn--block', href: publicPath('/login'),
            }, 'Sign in')));
          return;
        }
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
