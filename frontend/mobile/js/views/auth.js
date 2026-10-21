// Signing in, and the four screens that exist so it is recoverable.
//
// All of them share one shape - a statement of purpose, a form, a way onward - so
// they share one module. They render outside the shell, because a person who is
// not signed in has no shell to be inside. This is the Mobile module's own sign-in
// flow, drawn for a phone.

import { el } from '../../../packages/dom.js';
import { brandMark } from '../../../packages/brand.js';
import Api from '../../../packages/api.js';
import TrycordConfig from '../../../packages/config.js';
import { currentQuery, navigate, path, publicPath } from '../../../packages/nav.js';
import { State, applyToken, loadLegal, loadSession, logout, refreshServers } from '../../../packages/store.js';
import { withLegalVersions, isStaleLegalError } from '../../../packages/legal.js';
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

function showError(form, error, action) {
  const message = error && error.message ? error.message : 'That did not work.';
  let box = form.querySelector('.m-form-error');
  if (!box) {
    box = el('div', { class: 'm-form-error', role: 'alert' });
    form.insertBefore(box, form.firstChild);
  }
  // The children are filtered rather than passed as they are: the DOM's own
  // replaceChildren renders a null argument as the text "null", and a sign-in
  // form that says "null" under the message is a bug somebody will report.
  box.replaceChildren(...[el('span', {}, message), action || null].filter(Boolean));
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

// The acceptance control. The server records the exact versions the reader
// accepted and refuses a registration whose versions are not the ones in
// force, so the form states which versions they are and cannot be submitted
// until they are accepted.
function legalAcceptance() {
  const accepted = el('input', { type: 'checkbox', class: 'm-check' });
  const versions = el('span', { class: 'm-auth__legal-version' });
  const state = el('span', { class: 'm-auth__legal-state' });
  const label = el('label', { class: 'm-check-row m-auth__legal' },
    accepted,
    el('span', {},
      el('span', { class: 'm-auth__legal-title' },
        'I accept the ',
        el('a', { href: publicPath('/terms'), target: '_blank', rel: 'noopener' }, 'Terms of Service'),
        ' and the ',
        el('a', { href: publicPath('/privacy'), target: '_blank', rel: 'noopener' }, 'Privacy Policy')),
      el('span', { class: 'm-auth__legal-meta' }, versions, ' ', state)));

  // A block of its own, above the fields. On a phone the bottom of a form is
  // below the fold, and a control a reader cannot do without has to be where
  // they can see it.
  const block = el('section', { class: 'm-auth__legal-block' },
    el('p', { class: 'm-eyebrow' }, 'Before you can join'),
    el('p', { class: 'm-lede' },
      'This instance runs on its own rules, and an account here is bound by them. '
      + 'Read both documents, then accept them.'),
    label);

  const paintVersions = () => {
    const legal = State.legal;
    versions.textContent = legal && legal.termsVersion
      ? 'Terms v' + legal.termsVersion + ', Privacy v' + legal.privacyVersion + '.'
      : 'This instance has not said which version is in force.';
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

function registerForm() {
  const username = textInput({ name: 'username', autocomplete: 'username' });
  const display = textInput({ name: 'displayName' });
  const email = textInput({ name: 'email', type: 'email' });
  const password = textInput({ name: 'password', type: 'password', autocomplete: 'new-password' });
  const legal = legalAcceptance();
  const submit = el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'submit' }, 'Create account');
  const form = el('form', { class: 'm-auth__form' },
    el('p', { class: 'm-auth__instance' },
      'Joining ', el('strong', {}, TrycordConfig.backendUrl())),
    legal.block,
    field({ label: 'Username', control: username }),
    field({ label: 'Display name', control: display }),
    field({ label: 'Email (optional)', control: email }),
    field({ label: 'Password', control: password }),
    submit);

  // The form cannot be sent until the documents are accepted, and the button
  // says why: a disabled control with no reason is the control everybody
  // works around.
  const submitNote = el('p', { class: 'm-auth__submit-note' });
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
    try {
      // The versions come from the instance, never from this file.
      if (!State.legal) {
        try { await loadLegal(); } catch { /* the refusal below says so */ }
        legal.paintVersions();
      }
      if (!State.legal) {
        showError(form, { message: 'This instance did not say which terms are in force. Reload the page and try again.' });
        return;
      }
      const out = await Api.register(withLegalVersions({
        username: username.value.trim(),
        displayName: display.value.trim() || undefined,
        email: email.value.trim() || undefined,
        password: password.value,
      }, State.legal));
      if (out && out.token) {
        applyToken(out.token, out.user);
        await afterSignIn('/home');
      } else {
        toast('Account created. Check your email to continue.', { type: 'success' });
        navigate('/login', { replace: true });
      }
    } catch (error) {
      if (isStaleLegalError(error)) {
        showError(form, {
          message: 'The Terms or Privacy Policy changed since this page was opened. Reload to read the current version.',
        }, el('button', {
          class: 'm-btn m-btn--default', type: 'button',
          onClick: () => window.location.reload(),
        }, 'Reload'));
      } else {
        showError(form, error);
      }
    }
    finally { busy(form, false); syncSubmit(); }
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
      const out = await Api.resetPassword({ token, newPassword: next.value, confirmPassword: confirm.value });
      // An account with a second factor gets a challenge rather than a session:
      // the password is changed, and the sign-in still owes the second step.
      toast(out && out.mfaRequired
        ? 'Password set. Sign in with your two-step code.'
        : 'Password set. Sign in with it.', { type: 'success' });
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
