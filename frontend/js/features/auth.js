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
import { State, applyToken, loadLegal, loadSession, logout, refreshServers } from '../../packages/store.js';
import { withLegalVersions, isStaleLegalError } from '../../packages/legal.js';
import { connect } from '../../packages/realtime.js';
import { toast } from '../ui/overlays.js';
import { waitPhrase, passwordIsOverTheCeiling, signInRefusalWords } from '../../packages/authwords.js';

// -- the gate frame -----------------------------------------------------------

export function gateCard() {
  return el('div', { class: 'gate-card' },
    el('a', { class: 'gate-mark', href: publicPath('/login'), 'aria-label': 'Trycord' },
      el('img', { class: 'gate-mark-img', src: brandSymbolUrl, alt: '', width: '30', height: '30' }),
      el('span', {}, 'Trycord')),
  );
}

// The gate, in two panes.
//
// A sign-in screen used to be one card in the middle of the screen, and the
// middle of the screen is where the eye goes first - which is the wrong
// place, because the reader came here to type something.
//
// So there are two panes: the form, and a panel that says what this is.
// The panel is not decoration: it names the instance the reader is signing
// in to, because an account on one instance is not an account on another,
// and the reader is about to find out which one they are at.
//
// On a narrow screen the panel is a line above the form, because a thumb
// does not need a picture.
function gate(title, lede, body) {
  const card = gateCard();
  card.appendChild(el('h1', { class: 'gate-title' }, title));
  if (lede) card.appendChild(el('p', { class: 'gate-lede' }, lede));
  for (const child of [].concat(body)) card.appendChild(child);

  return {
    raw: true,
    node: el('div', { class: 'auth-page' },
      el('div', { class: 'auth-panes' },
        el('div', { class: 'auth-pane auth-pane--brand' }, brandPane()),
        el('div', { class: 'auth-pane auth-pane--form' }, card))),
    title,
  };
}

// The panel beside the form.
//
// It says what Trycord is and which instance this is, and it is the only
// place the reader is told the second thing - so it is worth the space.
function brandPane() {
  const instance = State.instance || {};
  const name = instance.name || 'Trycord';
  return el('div', { class: 'auth-brand' },
    el('div', { class: 'auth-brand-mark' },
      el('img', { class: 'auth-brand-img', src: brandSymbolUrl, alt: '', width: '44', height: '44' }),
      el('span', { class: 'auth-brand-name' }, 'Trycord')),
    el('p', { class: 'auth-brand-line' },
      'Private community messaging, on an instance you can run yourself.'),
    el('p', { class: 'auth-brand-instance' },
      el('span', { class: 'auth-brand-dot', 'aria-hidden': 'true' }),
      name));
}

function input(name, options) {
  const opts = options || {};
  const node = el('input', {
    class: 'input', name, type: opts.type || 'text',
    placeholder: opts.placeholder || null,
    autocomplete: opts.autocomplete || 'off',
    required: opts.required !== false,
    spellcheck: 'false', autocapitalize: 'none',
  });
  // A field that is prefilled shows what is in it.
  if (opts.value) node.value = opts.value;
  return node;
}

function field(label, control, hint) {
  const node = el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control);
  // A hint says what the field wants before the request is refused for not
  // having it. It is a span, not a note below the form, so it reads as
  // belonging to this field.
  if (hint) node.appendChild(el('span', { class: 'field-hint' }, hint));
  return node;
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
  // The refusal may arrive as { message, action } - the shaped answer
  // signInRefusal builds - or as a bare error, with the action handed in
  // beside it. Both carry an optional control, because some refusals need an
  // action (start the sign-in over) and not only a sentence.
  const control = action || (error && error.action) || null;
  // The children are filtered rather than passed as they are:
  // `replaceChildren` renders a null argument as the text "null", and a sign-in
  // form that says "null" under the message is a bug somebody will report.
  node.replaceChildren(
    ...[
      el('span', {}, (error && error.message) || 'That did not work. Try again.'),
      control,
    ].filter(Boolean),
  );
}

function clearError(form) {
  const node = form.querySelector('.form-error');
  if (!node) return;
  node.hidden = true;
  node.replaceChildren();
}

// -- what a refusal says ------------------------------------------------------

// The sentences live in the shared module - the phone has to say exactly
// what the desk says, and one copy of the words cannot drift into two
// truths. This file draws them: the action descriptions become the controls
// the desk has.
export { waitPhrase, passwordIsOverTheCeiling } from '../../packages/authwords.js';

// The desk's drawing of a refusal: the shared sentences arrive as words and
// action descriptions; this turns an action into its control.
function signInRefusal(error, restartChallenge) {
  const restart = typeof restartChallenge === 'function' ? restartChallenge : null;
  const said = signInRefusalWords(error, restart);
  if (!said || !said.action) return said;
  return {
    message: said.message,
    action: said.action.kind === 'restart'
      ? el('button', {
        class: 'btn btn--default btn--sm', type: 'button', onClick: restart,
      }, 'Start again')
      : said.action.kind === 'support'
        ? el('a', { class: 'btn btn--default btn--sm', href: publicPath(said.action.href) }, 'How to reach support')
        : null,
  };
}

// -- landing after a sign-in --------------------------------------------------

// The waiting screen for an account that still needs an administrator's yes.
//
// On an instance with approval required, the account exists from the moment
// of registration but every authenticated path refuses it until the yes.
// After signing in there is no workspace to land in - the token is issued and
// then refused everywhere, which used to mean an error on the form and a
// session that opened nothing. This says the fact where the reader is
// standing: created, waiting, nothing promised about when it ends, because
// nothing here knows that.
export function approvalWaiting() {
  return [
    el('p', { class: 'gate-note' },
      'Your account is created. This instance asks an administrator to approve new '
      + 'accounts before they are opened, so every part of Trycord stays closed '
      + 'until that happens.'),
    el('button', {
      class: 'btn btn--default btn--block', type: 'button',
      onClick: async () => {
        try { await logout(); } catch { /* the token is dropped locally either way */ }
        navigate('/login', { replace: true });
      },
    }, 'Sign out'),
  ];
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

// Whether an address could be an instance.
//
// An instance is a web address, and the reader is told so when the address
// is not one rather than being sent to a page that cannot load.
function looksLikeAnInstance(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !!url.hostname;
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

  // Which instance.
  //
  // An account on one instance is not an account on another, and a reader
  // who keeps several of them cannot tell from a sign-in form which one they
  // are signing in to. So the address is on the form, and it can be typed:
  // the field is prefilled with the instance in force, and a reader who
  // changes it is signing in somewhere else.
  const instance = input('instance', {
    type: 'url',
    value: TrycordConfig.backendUrl(),
    placeholder: 'https://the-instance.example',
    autocomplete: 'url',
  });
  const instanceField = field('Instance', instance);
  instanceField.classList.add('gate-field--instance');

  const form = gateForm([
    field('Username or email', username),
    field('Password', password),
    codeField,
    instanceField,
  ], 'Sign in');

  let challenge = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
    try {
      // A different instance is a different account, and the token belongs to
      // the instance that issued it - so the address is settled before the
      // sign-in, never after.
      const wanted = String(instance.value || '').trim();
      if (wanted && wanted !== TrycordConfig.backendUrl()) {
        if (!looksLikeAnInstance(wanted)) {
          showError(form, {
            message: 'That does not look like an instance address. It is a web address, '
              + 'like https://trycord.example',
          });
          return;
        }
        // The session belongs to the instance that issued it, and a session is
        // kept under the address of that instance - so changing the address
        // needs no carrying, and the page is loaded again against the new one.
        TrycordConfig.setApiUrl(wanted);
        window.location.reload();
        return;
      }
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
      // An approval-gated instance hands out the session and then refuses
      // everything the session can reach with it. Telling that inside the form
      // is not enough - there is nothing to fix in the form - so the waiting
      // screen takes the form's place.
      if (error && error.code === 'ACCOUNT_PENDING') {
        toast('Your account is waiting for an administrator to approve it. Nothing opens until then.', { type: 'info' });
        form.replaceChildren(...approvalWaiting());
        return;
      }
      // A refused sign-in is answered in the words above, with the actions
      // some refusals call for; anything else keeps the server's own
      // message. What was typed stays in the fields either way, because a
      // form that empties itself on a wrong password empties the reader's
      // attention with it.
      // The way back from a stale code challenge is a function rather than a
      // flag: it exists exactly while the reader is in the code step, and it
      // clears only the challenge handoff - five minutes and six digits do
      // not survive an expiry, but the name and password the reader meant
      // were never wrong.
      const refusal = signInRefusal(error, challenge !== null ? () => {
        challenge = null;
        codeField.hidden = true;
        code.required = false;
        code.value = '';
      } : null);
      showError(form, refusal || error);
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
    field('Username', username, '2 to 32 characters: letters, numbers, _ or .'),
    field('Display name (optional)', display),
    field('Email (optional)', email),
    field('Password', password, 'At least 8 characters. A long passphrase works well.'),
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
      showError(form, { message: 'The two passwords do not match. Type them again and try once more.' });
      busy(form, false);
      return;
    }
    // Long passphrases are welcome up to the ceiling the storage can keep.
    // Refused here, the passphrase is still on screen and nothing typed in
    // the other fields has been spent.
    if (passwordIsOverTheCeiling(password.value)) {
      showError(form, { message: 'That passphrase is longer than passwords here can be. Trim it a little and try again.' });
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
        // An approval-gated instance issues the session and then refuses
        // every authenticated path with it. Entering the workspace cannot be
        // what happens next: the waiting screen is, in the gate the reader
        // is standing in.
        if (out.pendingApproval) {
          toast('Account created.', { type: 'success' });
          form.replaceChildren(...approvalWaiting());
          return;
        }
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
    el('p', { class: 'gate-note' }, 'We send the link to the address on your account. If it does not arrive, look in the spam folder.'),
  ], 'Send reset link');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
    try {
      await Api.forgotPassword({ email: email.value.trim() });
      // "On its way" rather than "sent": the request went out, and nothing
      // here has seen a delivery. The phone's gate says the same words.
      toast('If that address is on an account here, a reset link is on its way.', { type: 'info' });
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
    field('New password', password, 'At least 8 characters. A long passphrase works well.'),
    field('Confirm password', confirm),
  ], 'Reset password');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(form, true);
    clearError(form);
    if (confirm.value !== password.value) {
      showError(form, { message: 'The two passwords do not match. Type them again and try once more.' });
      busy(form, false);
      return;
    }
    if (passwordIsOverTheCeiling(password.value)) {
      showError(form, { message: 'That passphrase is longer than passwords here can be. Trim it a little and try again.' });
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
      // A spent reset link is not a mistake the password fields can fix - the
      // link itself is the thing that is gone. The way back is a new link,
      // and that way is offered here rather than left to be figured out.
      if (error && error.code === 'AUTH_REQUIRED') {
        showError(form, {
          message: (error && error.message)
            || 'This reset link is no longer valid. Request a new one to continue.',
        }, el('button', {
          class: 'btn btn--default btn--sm', type: 'button', onClick: () => navigate('/forgot'),
        }, 'Request a new link'));
      } else {
        showError(form, error);
      }
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
      const mine = State.user && State.user.email;
      status.textContent = (error && error.message)
        || 'That confirmation did not go through.';
      // Signed in, the way onward is the workspace itself: the fresh link is
      // offered right here. Signed out, sign-in comes first - the link
      // belongs to an account, and the server refuses to send to whoever
      // asks without one.
      const destination = mine
        ? el('a', { class: 'btn btn--default btn--block', href: publicPath('/home') }, 'Continue to Trycord')
        : el('a', { class: 'btn btn--default btn--block', href: publicPath('/login') }, 'Go to sign in');
      if (mine) {
        const resend = el('button', { class: 'btn btn--default btn--block', type: 'button' }, 'Send a new link to the address on your account');
        resend.addEventListener('click', async () => {
          resend.disabled = true;
          try {
            await Api.verifyEmailResend({ email: mine });
            status.textContent = 'The link is on its way to ' + mine + '. If it does not arrive, look in the spam folder.';
          } catch (resendError) {
            status.textContent = (resendError && resendError.message) || 'That did not work. Try again.';
            resend.disabled = false;
          }
        });
        onward.appendChild(resend);
      }
      onward.appendChild(destination);
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
      // The lock's wait is named the way the sign-in names it: when the
      // server says how long is left, the sentence says that, because a
      // countdown nobody shows is a countdown that might as well not exist.
      error.textContent = (err && err.code === 'ACCOUNT_LOCKED')
        ? 'Too many tries in a row. ' + waitPhrase(err.details && err.details.retryAfterSeconds)
        : (err && err.message) || 'That did not work. Try again.';
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
