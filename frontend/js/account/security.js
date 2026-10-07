// security — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import Api from '../api.js';
import Realtime from '../realtime.js';
import State, { clearSession } from '../state.js';
import { el, clear, toast, confirmDialog, passwordDialog } from '../ui.js';
import { navigate } from '../nav.js';
import { loadingState, errorState } from '../view-states.js';
import { sectionCard, settingRow, setEmpty, dangerButton } from '../settings-ui.js';

export function renderPasswordSection(wrap, repaint) {
  wrap.appendChild(el('div', { class: 'section-label' }, 'Password'));
  wrap.appendChild(el('p', { class: 'muted small' }, 'Changing your password signs out every other session immediately. This device stays signed in.'));
  const err = el('div', { class: 'form-error', hidden: true });
  const cur = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Change password');
  const form = el('form', { class: 'card card--auth' }, err,
    el('div', { class: 'field' }, el('label', {}, 'Current password'), cur),
    el('div', { class: 'field' }, el('label', {}, 'New password'), next,
      el('span', { class: 'hint' }, '8+ characters. All other sessions will be signed out.')),
    el('div', {}, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      const res = await Api.changePassword({ currentPassword: cur.value, newPassword: next.value });
      // res carries a fresh token (others invalidated) with the new secret — apply it.
      State.token = res.token;
      localStorage.setItem('trycord.token', res.token);
      State.me = res.user;
      repaint();
      toast('Password changed. Other sessions signed out.', 'ok');
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });
  wrap.appendChild(form);
}

export function renderTwoFactorSection(wrap) {
  wrap.appendChild(el('div', { class: 'section-label' }, 'Two-factor authentication'));
  const err = el('div', { class: 'form-error', hidden: true });
  const body = el('div', { class: 'card' });
  wrap.appendChild(body);
  wrap.appendChild(err);

  const fail = (ex) => {
    err.hidden = false;
    // Fall back to the server's own wording; only when there is none, say
    // what to do rather than that something happened.
    err.textContent = (ex && ex.message) || 'Could not save that change. Check your connection and try again.';
  };

  // Status drives the whole section, so it is fetched rather than assumed: a
  // stale local guess would offer to "enable" a factor that is already on.
  Api.twoFactorStatus().then((st) => {
    clear(body);
    if (st && st.enabled) renderEnabled(body, st);
    else renderDisabled(body);
  }).catch(fail);

  function passwordField(label) {
    return el('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  }

  function renderDisabled(host) {
    host.appendChild(el('p', { class: 'muted small' },
      'Require a 6-digit code from an authenticator app in addition to your password. '
      + 'A stolen password alone will not be enough to sign in.'));
    const start = el('button', { class: 'btn primary', type: 'button' }, 'Set up two-factor');
    start.addEventListener('click', async () => {
      err.hidden = true;
      start.setAttribute('aria-busy', 'true');
      // The password is re-confirmed server-side on every management call: a
      // stolen session token must not be enough to turn the factor off.
      const pw = await passwordDialog({
        title: 'Confirm your password',
        message: 'Two-factor setup asks for your password again, so a stolen session token is not enough on its own.',
        confirmText: 'Continue',
      });
      if (pw === null) { start.removeAttribute('aria-busy'); return; }
      Api.twoFactorSetup({ password: pw })
        .then((setup) => { clear(host); renderConfirm(host, setup); })
        .catch(fail)
        .finally(() => start.removeAttribute('aria-busy'));
    });
    host.appendChild(el('div', { class: 'card-actions' }, start));
  }

  function renderConfirm(host, setup) {
    // Shown as text rather than a QR image: the app renders no canvas and no
    // external image, and a secret the member can type is what they would
    // otherwise be reading off the screen with an authenticator's manual entry.
    const secretInput = el('input', { class: 'input mono', type: 'text', readonly: true, value: setup.secret });
    const code = el('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, required: true });
    const confirm = el('button', { class: 'btn primary', type: 'submit' }, 'Turn on two-factor');
    const form = el('form', { class: 'card card--auth' },
      el('div', { class: 'field' }, el('label', {}, '1. Add this key to your authenticator'),
        secretInput,
        el('span', { class: 'hint' }, 'Or use the setup link: ')),
      el('div', { class: 'field' }, el('label', {}, '2. Enter the 6-digit code it shows'), code),
      el('div', {}, confirm));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        const pw = await passwordDialog({
          title: 'Confirm your password',
          confirmText: 'Turn on two-factor',
        });
        if (pw === null) return;
        const out = await Api.twoFactorEnable({ password: pw, code: code.value.trim() });
        clear(host);
        renderRecoveryCodes(host, out.recoveryCodes, 'Two-factor is on.');
      } catch (ex) { fail(ex); }
    });
    host.appendChild(el('p', { class: 'muted small' },
      'Add the key below to your authenticator app, then enter the code it shows. '
      + 'Nothing is turned on until that code works.'));
    host.appendChild(form);
    setTimeout(() => code.focus(), 0);
  }

  function renderEnabled(host, st) {
    host.appendChild(el('p', { class: 'muted small' },
      'Two-factor is on. Signing in needs your password and a code from your authenticator app.'));
    if (st.lockedUntil) {
      host.appendChild(el('p', { class: 'form-error' },
        'Too many failed sign-in attempts. Try again after ' + new Date(st.lockedUntil).toLocaleString() + '.'));
    }
    const pw = passwordField('Confirm your password');
    const code = el('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
    const turnOff = el('button', { class: 'btn danger', type: 'submit' }, 'Turn off two-factor');
    const form = el('form', { class: 'card card--auth' },
      el('div', { class: 'field' }, el('label', {}, 'Confirm your password'), pw),
      el('div', { class: 'field' }, el('label', {}, 'Current code'), code,
        el('span', { class: 'hint' }, 'Required, so a borrowed session cannot switch this off.')),
      el('div', {}, turnOff));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      confirmDialog({
        title: 'Turn off two-factor?',
        message: 'Your account will be protected by your password alone. Every other session stays signed in.',
        danger: true, confirmText: 'Turn off',
        onConfirm: async () => {
          try {
            await Api.twoFactorDisable({ password: pw.value, code: code.value.trim() });
            clear(host);
            renderDisabled(host);
            toast('Two-factor is off.', 'ok');
          } catch (ex) { fail(ex); }
        },
      });
    });

    const reissue = el('button', { class: 'btn', type: 'button' }, 'New recovery codes');
    reissue.addEventListener('click', async () => {
      err.hidden = true;
      try {
        const out = await Api.twoFactorRecoveryCodes({ password: pw.value });
        clear(host);
        renderRecoveryCodes(host, out.recoveryCodes, 'New recovery codes. The previous ones no longer work.');
        renderEnabled(host, st);
      } catch (ex) { fail(ex); }
    });

    host.appendChild(form);
    host.appendChild(el('div', { class: 'card-actions' }, reissue));
  }

  // Shown once and never retrievable again: only hashes are stored server-side.
  function renderRecoveryCodes(host, codes, headline) {
    host.appendChild(el('div', { class: 'section-label' }, headline));
    host.appendChild(el('p', { class: 'muted small' },
      'Each code works once. Save them somewhere you can reach without this device - '
      + 'they are not shown again, and they are the only way back in if you lose your authenticator.'));
    host.appendChild(el('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap' } }, codes.join('\n')));
    const done = el('button', { class: 'btn primary', type: 'button' }, 'I have saved them');
    done.addEventListener('click', () => { clear(host); renderEnabled(host, {}); });
    host.appendChild(el('div', { class: 'card-actions' }, done));
  }
}

// `preloaded` is a promise of the sessions the caller has already asked for. The Security
// page needs them twice - once for this list and once for the sidebar beside it - and
// passing the same promise means one request rather than two.
export function renderSessionsSection(wrap, preloaded) {
  wrap.appendChild(el('div', { class: 'section-label' }, 'Sessions'));
  const host = el('div');
  wrap.appendChild(host);
  if (preloaded) paintSessions(host, preloaded);
  else loadSessions(host);

  // Bulk revocation stays, because it is a real answer to "I do not know which
  // one is wrong", but it is no longer the only answer.
  const revokeAll = el('button', { class: 'btn danger', type: 'button' }, 'Sign out all sessions');
  revokeAll.addEventListener('click', () => {
    confirmDialog({
      title: 'Sign out every device?',
      message: 'This signs out this device too. You will need to sign in again.',
      danger: true, confirmText: 'Sign out everywhere',
      onConfirm: async () => {
        try { await Api.revokeAllSessions(); } finally {
          try { Realtime.disconnect(); } catch { /* ignore */ }
          clearSession();
          navigate('/login');
        }
      },
    });
  });
  const revokeOthers = el('button', { class: 'btn', type: 'button' }, 'Sign out other sessions');
  revokeOthers.addEventListener('click', async () => {
    revokeOthers.disabled = true;
    try {
      const res = await Api.revokeOthers();
      // Revoking the others also mints a fresh token for this one, because the
      // server cannot keep a token it has just declared invalid. Without the
      // swap below the reader is signed out of the tab they are looking at.
      State.token = res.token;
      localStorage.setItem('trycord.token', res.token);
      toast('Other sessions signed out.', 'ok');
      loadSessions(host);
    } catch (ex) {
      toast(ex.message || 'Could not sign out other sessions.', 'error');
      revokeOthers.disabled = false;
    }
  });
  wrap.appendChild(el('div', { class: 'row-line' }, revokeOthers, revokeAll));
  wrap.appendChild(el('p', { class: 'muted small' }, 'Token-based sessions expire after 7 days or when revoked.'));
}

// Loaded here rather than by the caller: the sessions list is the only
// thing that has to wait on it, and it is called from exactly one place.
// One in-flight load. The Security page fetches sessions for its sidebar and this
// section fetches them for its own list, in the same paint, so every visit to
// /settings/security asked the server for the same thing twice.
let sessionsInFlight = null;

async function loadSessions(host) {
  if (sessionsInFlight) return sessionsInFlight;
  const run = fetchSessions(host).finally(() => { sessionsInFlight = null; });
  sessionsInFlight = run;
  return run;
}

// Paint a list from a promise of sessions, whichever promise it is.
async function paintSessions(host, sessionsPromise) {
  clear(host);
  host.appendChild(loadingState('Loading your sessions'));
  let sessions;
  try {
    sessions = await sessionsPromise;
  } catch (ex) {
    clear(host);
    host.appendChild(errorState((ex && ex.message) || 'Could not load your sessions.', () => {
      loadSessions(host);
    }));
    return;
  }
  renderSessionRows(host, sessions);
}

async function fetchSessions(host) {
  clear(host);
  host.appendChild(loadingState('Loading your sessions'));
  let sessions;
  try {
    const res = await Api.sessions();
    sessions = res.sessions || [];
  } catch (ex) {
    clear(host);
    host.appendChild(errorState(ex.message || 'Could not load your sessions.', () => {
      loadSessions(host);
    }));
    return;
  }
  renderSessionRows(host, sessions);
}

// Paint the session rows. A fresh fetch and a promise the caller already had both
// arrive here, so the list looks the same whichever way it came.
function renderSessionRows(host, sessions) {
  clear(host);
  if (!sessions.length) {
    host.appendChild(setEmpty('No sessions.'));
    return;
  }
  const card = sectionCard();
  for (const s of sessions) {
    const label = s.label || 'Unknown device';
    const hint = s.current
      ? 'This device'
      : [
        s.lastSeenAt ? 'Last active ' + new Date(s.lastSeenAt).toLocaleString() : null,
        s.ip ? 'from ' + s.ip : null,
      ].filter(Boolean).join(' ');
    // The current session has no revoke button: revoking it is "sign out", which
    // the page already offers, and offering it here too only puts a way to lose
    // the current session where losing it is surprising.
    const control = s.current ? null : dangerButton('Sign out', async () => {
      control.disabled = true;
      try {
        await Api.revokeSession(s.jti);
        toast(label + ' signed out.', 'ok');
        loadSessions(host);
      } catch (ex) {
        toast(ex.message || 'Could not sign that session out.', 'error');
        control.disabled = false;
      }
    }, { variant: 'ghost' });
    card.appendChild(settingRow({ label, hint, control }));
  }
  host.appendChild(card);
}


export default { renderPasswordSection, renderTwoFactorSection, renderSessionsSection };
