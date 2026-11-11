// The front door.
//
// Sign in, create an account, answer the two-step challenge. The screens are
// raw — the shell's doors mean nothing until there is a session — and they
// stand on the ember wash, because this page is the brand before it is the app.

import { el } from '../../../packages/dom.js';
import { brandMark } from '../../../packages/brand.js';
import Api from '../../../packages/api.js';
import { withLegalVersions } from '../../../packages/legal.js';
import { State, loadSession, refreshServers, refreshDms, refreshFriends, refreshNotifications } from '../../../packages/store.js';
import realtime from '../../../packages/realtime.js';
import { publicPath } from '../../../packages/nav.js';
import { navigate, path } from '../../../packages/nav.js';
import { field, toast, failed } from '../ui.js';
import * as encrypted from '../../../js/ui/encrypted.js';
import { setLocalUserId } from '../../../packages/voiceSession.js';

export function renderAuth(ctx) {
  // Every gate is raw: the doors mean nothing until there is a session, so
  // the screen stands alone. The router reads the answer and hides the chrome.
  const screen = (ctx && ctx.screen) || 'login';
  let node;
  if (screen === 'register') node = registerScreen();
  else if (screen === 'twoStep') node = twoStepScreen(ctx);
  else if (screen === 'forgot') node = forgotScreen();
  else if (screen === 'resetPassword') node = resetScreen(ctx);
  else if (screen === 'verifyEmail') node = verifyScreen(ctx);
  else node = signInScreen();
  return { node, raw: true };
}

// The letter's token proves the address; one press confirms it.
function verifyScreen(ctx) {
  const token = (ctx && ctx.params && ctx.params.token) || (ctx && ctx.query && ctx.query.token) || '';
  const go = el('button', { class: 'm-go m-go--block', type: 'submit' }, 'Confirm the address');
  const error = el('p', { class: 'm-error', hidden: true });

  async function submit() {
    go.disabled = true;
    error.hidden = true;
    try {
      await Api.verifyEmail({ token });
      toast('The address is confirmed. Sign in.', { type: 'success' });
      navigate(path('/login'));
    } catch (e) {
      error.textContent = (e && e.message) || 'That token was not the one.';
      error.hidden = false;
    } finally { go.disabled = false; }
  }

  return authShell('Confirm the address', 'The letter carried a token; this confirms it.',
    { nodes: [error, go], submit }, null);
}

function afterSignIn() {
  try { document.documentElement.dataset.session = 'in'; } catch { /* no document */ }
  setLocalUserId(() => (State.user && State.user.id) || '');
  encrypted.ready().catch(() => { /* the You screen reports it */ });
  Promise.allSettled([refreshServers(), refreshDms(), refreshFriends(), refreshNotifications()])
    .then(() => realtime.connect());
}

function authShell(title, lede, form, swap) {
  return el('div', { class: 'm-auth' },
    el('div', { class: 'm-auth__brand' },
      brandMark({ size: 44 }),
      el('div', { class: 'm-auth__wordmark' }, 'Trycord'),
      el('p', { class: 'm-auth__lede' }, lede)),
    el('div', { class: 'm-auth__title' }, el('h1', { style: { 'font-size': 'var(--fs-h2)' } }, title)),
    el('form', { class: 'm-auth__form', onSubmit: (event) => { event.preventDefault(); form.submit(); } }, form.nodes),
    swap);
}

function signInScreen() {
  const username = el('input', { class: 'm-input', type: 'text', autocomplete: 'username', placeholder: 'you or you@example.com', 'aria-label': 'Username or email' });
  const password = el('input', { class: 'm-input', type: 'password', autocomplete: 'current-password', placeholder: 'Your password', 'aria-label': 'Password' });
  const go = el('button', { class: 'm-go m-go--block', type: 'submit' }, 'Sign in');
  const error = el('p', { class: 'm-error', hidden: true });
  let challenge = null;

  const code = el('input', { class: 'm-input', type: 'text', inputmode: 'numeric', placeholder: '6-digit code', 'aria-label': 'Two-step code' });
  const codeField = field('Two-step code', code);
  codeField.hidden = true;

  const form = { submit: submit };

  async function submit() {
    go.disabled = true;
    error.hidden = true;
    try {
      if (challenge) {
        await Api.twoFactorVerify({ challengeToken: challenge, code: code.value.trim() });
        await loadSession();
        afterSignIn();
        navigate(path('/dms'));
        return;
      }
      const out = await Api.login({ username: username.value.trim(), password: password.value });
      if (out && out.mfaRequired) {
        challenge = out.challengeToken || out.challenge || null;
        codeField.hidden = false;
        code.focus();
        return;
      }
      await loadSession();
      afterSignIn();
      navigate(path('/dms'));
    } catch (e) {
      error.textContent = (e && e.message) || 'That sign-in did not go through.';
      error.hidden = false;
    } finally {
      go.disabled = false;
    }
  }

  const node = authShell('Welcome back', 'The places and people you keep, on the instance you trust.',
    { nodes: [username, password, codeField, error, go], submit },
    el('p', { class: 'm-auth__swap' },
      'New here? ', el('button', { type: 'button', onClick: () => navigate(path('/register')) }, 'Create an account'),
      el('span', null, ' · '),
      el('a', { href: publicPath('/forgot') }, 'Forgot your password?')));
  return node;
}

function registerScreen() {
  const username = el('input', { class: 'm-input', type: 'text', autocomplete: 'username', name: 'username', placeholder: 'A name people will type', 'aria-label': 'Username' });
  const email = el('input', { class: 'm-input', type: 'email', autocomplete: 'email', name: 'email', placeholder: 'you@example.com', 'aria-label': 'Email' });
  const password = el('input', { class: 'm-input', type: 'password', autocomplete: 'new-password', name: 'password', placeholder: 'Something long', 'aria-label': 'Password' });
  // A way to read what was typed, and a reading of the phrase that is
  // guidance rather than a gate.
  const reveal = el('button', { class: 'm-auth__reveal', type: 'button' }, 'Show');
  reveal.addEventListener('click', () => {
    const shown = password.getAttribute('type') === 'text';
    password.setAttribute('type', shown ? 'password' : 'text');
    reveal.textContent = shown ? 'Show' : 'Hide';
  });
  const strength = el('p', { class: 'm-auth__strength' });
  password.addEventListener('input', () => {
    const words = password.value.length;
    strength.textContent = words === 0 ? ''
      : words < 10 ? 'Short. Ten marks or more, and mixed.' : 'That will hold.';
  });
  // The papers are agreed to, not merely shown: the form refuses to send
  // until the box is ticked.
  const accepted = el('input', { class: 'm-auth__accept-box', type: 'checkbox', name: 'accepted' });
  const accept = el('label', { class: 'm-auth__accept' }, accepted,
    el('span', null, 'I agree to the ',
      el('a', { href: publicPath('/terms'), target: '_blank', rel: 'noopener' }, 'Terms'),
      ' and the ',
      el('a', { href: publicPath('/privacy'), target: '_blank', rel: 'noopener' }, 'Privacy notice'), '.'));
  const go = el('button', { class: 'm-go m-go--block', type: 'submit' }, 'Create account');
  const error = el('p', { class: 'm-error', hidden: true });

  async function submit() {
    go.disabled = true;
    error.hidden = true;
    try {
      if (!accepted.checked) {
        error.textContent = 'The papers are agreed to before an account is made.';
        error.hidden = false;
        return;
      }
      if (!State.legal) {
        error.textContent = 'This instance did not say which terms are in force. Reload and try again.';
        error.hidden = false;
        return;
      }
      await Api.register(withLegalVersions({
        username: username.value.trim(),
        email: email.value.trim(),
        password: password.value,
      }, State.legal));
      await loadSession();
      afterSignIn();
      navigate(path('/dms'));
    } catch (e) {
      error.textContent = (e && e.message) || 'That account could not be made.';
      error.hidden = false;
    } finally {
      go.disabled = false;
    }
  }

  return authShell('Join', 'An account on this instance is a name, an address and a long password.',
    { nodes: [username, email, password, reveal, strength, accept, error, go], submit },
    el('p', { class: 'm-auth__swap' },
      'Already here? ', el('button', { type: 'button', onClick: () => navigate(path('/login')) }, 'Sign in')));
}

function forgotScreen() {
  const email = el('input', { class: 'm-input', type: 'email', name: 'email', autocomplete: 'email', placeholder: 'The address the account uses', 'aria-label': 'Email' });
  const go = el('button', { class: 'm-go m-go--block', type: 'submit' }, 'Send the way back in');
  const error = el('p', { class: 'm-error', hidden: true });

  async function submit() {
    go.disabled = true;
    error.hidden = true;
    try {
      await Api.forgotPassword({ email: email.value.trim() });
      toast('If that address holds an account, a letter is on its way.', { type: 'success' });
      navigate(path('/login'));
    } catch (e) {
      error.textContent = (e && e.message) || 'The letter could not be sent.';
      error.hidden = false;
    } finally { go.disabled = false; }
  }

  return authShell('Locked out', 'The instance sends a letter with a way back in.',
    { nodes: [email, error, go], submit },
    el('p', { class: 'm-auth__swap' },
      'Remembered it? ', el('button', { type: 'button', onClick: () => navigate(path('/login')) }, 'Sign in')));
}

function resetScreen(ctx) {
  const token = (ctx && ctx.params && ctx.params.token) || (ctx && ctx.query && ctx.query.token) || '';
  const next = el('input', { class: 'm-input', type: 'password', name: 'newPassword', autocomplete: 'new-password', placeholder: 'The new phrase', 'aria-label': 'New password' });
  const again = el('input', { class: 'm-input', type: 'password', name: 'confirmPassword', autocomplete: 'new-password', placeholder: 'The same phrase again', 'aria-label': 'Repeat the new password' });
  const go = el('button', { class: 'm-go m-go--block', type: 'submit' }, 'Set the phrase');
  const error = el('p', { class: 'm-error', hidden: true });

  async function submit() {
    go.disabled = true;
    error.hidden = true;
    try {
      const out = await Api.resetPassword({ token, newPassword: next.value, confirmPassword: again.value });
      toast(out && out.mfaRequired ? 'Two steps is waiting at the door.' : 'The phrase is set. Sign in.', { type: 'success' });
      navigate(path('/login'));
    } catch (e) {
      error.textContent = (e && e.message) || 'That phrase could not be set.';
      error.hidden = false;
    } finally { go.disabled = false; }
  }

  return authShell('A new phrase', 'The letter carried a token; the token carried the right to set this.',
    { nodes: [next, again, error, go], submit },
    null);
}

function twoStepScreen(ctx) {
  const code = el('input', { class: 'm-input', type: 'text', inputmode: 'numeric', placeholder: 'The code from your second factor', 'aria-label': 'Two-step code' });
  const go = el('button', { class: 'm-go m-go--block', type: 'submit' }, 'Verify');
  const error = el('p', { class: 'm-error', hidden: true });

  async function submit() {
    go.disabled = true;
    try {
      await Api.twoFactorVerify({ challengeToken: (ctx && ctx.challengeToken) || (State.user || {}).challengeToken, code: code.value.trim() });
      await loadSession();
      afterSignIn();
      navigate(path('/dms'));
    } catch (e) {
      error.textContent = (e && e.message) || 'That code was not the one.';
      error.hidden = false;
    } finally { go.disabled = false; }
  }

  return authShell('Two steps', 'This account keeps a second factor. The code proves it is you.',
    { nodes: [code, error, go], submit },
    null);
}
