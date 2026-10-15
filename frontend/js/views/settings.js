// Account settings.
//
// One page per destination in the You scope, each a band and then panels. The
// left column is built from the registry, so a settings page that exists is a
// page the navigation offers and the other way round.

import { el } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, bannerNode } from '../components.js';
import { State, loadSession } from '../store.js';
import Api from '../api.js';
import { TrycordConfig } from '../config.js';
import { path, publicPath } from '../nav.js';
import { scopeNav } from '../pages/registry.js';
import { toast, errorToast, confirmDialog, openDialog } from '../ui.js';
import { currentTheme, setTheme } from '../theme.js';
import { page, band, panel, prow, notice, loading, failure, empty, relative } from './util.js';

const SCOPES = [
  { value: 'anyone', label: 'Anyone' },
  { value: 'friends', label: 'Friends' },
  { value: 'nobody', label: 'Nobody' },
];

// The server owns which notification kinds exist; these are the labels for the
// ones it sends today.
const NOTIFICATION_KINDS = [
  ['dm', 'Direct messages', 'When someone messages you one to one.'],
  ['mention', 'Mentions', 'When someone writes your name.'],
  ['friend', 'Friends', 'Requests you receive and acceptances.'],
  ['moderation', 'Moderation', 'When a moderator acts where you are.'],
  ['announcement', 'Announcements', 'When a community announces something.'],
];

// -- controls ----------------------------------------------------------------

function fieldBlock(label, hint, control) {
  return el('label', { class: 'field-block' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
  );
}

function switchRow(label, hint, initial, onChange) {
  const control = el('button', {
    class: 'switch', type: 'button', role: 'switch',
    'aria-checked': String(!!initial), 'aria-label': label,
  });
  control.addEventListener('click', () => {
    const next = control.getAttribute('aria-checked') !== 'true';
    control.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return prow({ title: label, sub: hint, control });
}

function selectRow(label, hint, options, value, onChange) {
  const select = el('select', { class: 'input input--compact', 'aria-label': label });
  for (const option of options) select.appendChild(el('option', { value: option.value }, option.label));
  select.value = value || options[0].value;
  select.addEventListener('change', () => onChange(select.value));
  return prow({ top: true, title: label, sub: hint, control: select });
}

// One dialog for everything that needs the current password, because the server
// asks for it on each of these calls and a page that forgot to would only fail
// after the reader had chosen a new code.
function passwordDialog(options) {
  const opts = options || {};
  const password = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Your password' });
  const error = el('div', { class: 'form-error', role: 'status' });
  let dialog;
  const confirm = el('button', { class: 'btn btn--' + (opts.danger ? 'danger' : 'primary'), type: 'button' }, opts.confirmLabel || 'Continue');
  confirm.addEventListener('click', async () => {
    error.textContent = '';
    if (!password.value) { error.textContent = 'Enter your password.'; return; }
    confirm.disabled = true;
    try { await opts.onConfirm(password.value, dialog); }
    catch (err) { error.textContent = err.message || 'That did not work.'; }
    finally { confirm.disabled = false; }
  });
  dialog = openDialog({
    title: opts.title,
    sub: opts.sub,
    body: [fieldBlock('Password', opts.hint || null, password), error],
    foot: [
      el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      confirm,
    ],
  });
  return dialog;
}

// -- profile -----------------------------------------------------------------

function profileSection() {
  const host = el('div', { class: 'stack' });
  const me = State.user || {};

  const displayName = el('input', { class: 'input', maxlength: '60' });
  displayName.value = me.displayName || '';
  const bio = el('textarea', { class: 'input', rows: '3', maxlength: '400' });
  bio.value = me.bio || '';
  const statusText = el('input', { class: 'input', maxlength: '128' });
  statusText.value = me.statusText || '';

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save profile');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await Api.updateMe({ displayName: displayName.value.trim(), bio: bio.value, statusText: statusText.value });
      await loadSession();
      toast('Profile saved.', { type: 'success' });
    } catch (error) { errorToast(error); } finally { save.disabled = false; }
  });

  function imageRow(title, hint, mediaUrl, kind, label) {
    const preview = mediaUrl
      ? (kind === 'banner' ? bannerNode(mediaUrl, 'media-img') : avatar({ ...me, avatarUrl: mediaUrl }, { size: 'lg' }))
      : el('span', { class: 'prow-lead-placeholder' }, icon('image', { size: 20 }));
    const input = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', 'aria-label': label, tabindex: '-1' });
    const upload = el('button', { class: 'btn btn--default btn--sm', type: 'button' }, label);
    upload.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      upload.disabled = true;
      try {
        await Api.uploadProfileImage(kind, file);
        await loadSession();
        toast('Saved.', { type: 'success' });
        paint();
      } catch (error) { errorToast(error); } finally { upload.disabled = false; }
    });
    const remove = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Remove');
    remove.disabled = !mediaUrl;
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await Api.removeProfileImage(kind);
        await loadSession();
        toast('Removed.', { type: 'success' });
        paint();
      } catch (error) { errorToast(error); remove.disabled = false; }
    });
    return prow({ top: true, lead: preview, title, sub: hint, actions: [upload, remove, input] });
  }

  const resend = el('button', {
    class: 'btn btn--default btn--sm', type: 'button',
    onClick: async (event) => {
      event.currentTarget.disabled = true;
      try { await Api.verifyEmailResend(); toast('Verification link sent.', { type: 'success' }); }
      catch (error) { errorToast(error); } finally { event.currentTarget.disabled = false; }
    },
  }, 'Resend link');

  const deletion = el('button', { class: 'btn btn--danger btn--sm', type: 'button' }, 'Erase account');
  deletion.addEventListener('click', async () => {
    const sure = await confirmDialog({
      title: 'Delete your account?',
      body: 'This schedules your account and its content for erasure. You can cancel while the window is open.',
      confirmLabel: 'Request deletion',
      danger: true,
    });
    if (!sure) return;
    try { await Api.requestDeletion({ confirm: true }); toast('Deletion requested.', { type: 'success' }); }
    catch (error) { errorToast(error); }
  });

  function paint() {
    const current = State.user || {};
    host.replaceChildren(
      panel({
        title: 'Profile',
        note: 'How you appear to others',
        body: [
          fieldBlock('Display name', 'The name people see.', displayName),
          fieldBlock('About', 'A short description on your profile.', bio),
          fieldBlock('Status', 'Shown beside your name.', statusText),
        ],
        foot: save,
        footEnd: true,
      }),
      panel({
        title: 'Images',
        note: 'One photo, one banner',
        rows: [
          imageRow('Profile photo', 'Shown beside your name everywhere.', current.avatarUrl, 'avatar', 'Upload photo'),
          imageRow('Banner', 'The wide image at the top of your profile.', current.bannerUrl, 'banner', 'Upload banner'),
        ],
      }),
      panel({
        title: 'Email',
        note: current.emailVerified ? 'Verified' : 'Not verified',
        rows: [
          prow({
            lead: icon('mail', { size: 17 }),
            title: current.email || 'No email on file',
            sub: current.emailVerified
              ? 'Confirmed. Used only for sign-in and account mail.'
              : 'Confirm it so you can recover this account if you lose the password.',
            actions: current.emailVerified ? null : resend,
          }),
        ],
      }),
      panel({
        title: 'Delete account',
        dashed: true,
        rows: [
          prow({
            top: true,
            title: 'Erase this account',
            sub: 'Schedules your account and its content for deletion. You can cancel while the window is open.',
            actions: deletion,
          }),
        ],
      }),
    );
  }
  paint();
  return [host];
}

// -- privacy -----------------------------------------------------------------

function privacySection() {
  const reach = el('div', {});
  const blocked = el('div', {});

  function paint(settings) {
    reach.replaceChildren(
      selectRow('Who can send friend requests', 'Requests from outside this group are refused.', SCOPES, settings.friendRequests, (value) => save({ friendRequests: value })),
      selectRow('Who can message you', 'Whether a stranger can open a conversation.', SCOPES, settings.dms, (value) => save({ dms: value })),
      selectRow('Who can see when you are online', null, SCOPES, settings.presence, (value) => save({ presence: value })),
      switchRow('Searchable by username', 'Lets people find you when they type your username.', settings.discoverable, (value) => save({ discoverable: value })),
    );
  }

  function paintBlocks(rows) {
    blocked.replaceChildren();
    if (!rows.length) {
      blocked.appendChild(empty({
        icon: 'shield',
        title: 'Nobody is blocked',
        text: 'People you block cannot message you, add you or see your activity.',
      }));
      return;
    }
    for (const entry of rows) {
      const user = entry.user || entry;
      blocked.appendChild(prow({
        lead: icon('user', { size: 17 }),
        title: user.displayName || user.username,
        sub: '@' + (user.username || ''),
        actions: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: async (event) => {
            event.currentTarget.disabled = true;
            try {
              await Api.unblockUser(user.id);
              paintBlocks(rows.filter((row) => (row.user || row).id !== user.id));
            } catch (error) { errorToast(error); event.currentTarget.disabled = false; }
          },
        }, 'Unblock'),
      }));
    }
  }

  async function save(patch) {
    try {
      paint(await Api.setPrivacy(patch));
      toast('Saved.', { type: 'success' });
    } catch (error) { errorToast(error); }
  }

  async function load() {
    try {
      const [settings, blocks] = await Promise.all([Api.privacy(), Api.blocks()]);
      paint(settings);
      paintBlocks(Array.isArray(blocks) ? blocks : (blocks && blocks.items) || []);
    } catch (error) {
      reach.replaceChildren(failure(error, load));
    }
  }

  const reachPanel = panel({ title: 'Who can reach you', note: 'Saved as you change it', body: reach, tight: true });
  const blockedPanel = panel({ title: 'Blocked accounts', body: blocked, tight: true });
  load();
  return [reachPanel, blockedPanel];
}

// -- notifications -----------------------------------------------------------

function notificationsSection() {
  const kinds = el('div', {});
  const quiet = el('div', {});

  function paintKinds(prefs) {
    kinds.replaceChildren();
    for (const [key, label, hint] of NOTIFICATION_KINDS) {
      kinds.appendChild(switchRow(label, hint, prefs[key] !== false, (value) => saveKinds({ [key]: value })));
    }
  }

  function paintQuiet(w) {
    quiet.replaceChildren();
    quiet.appendChild(switchRow('Do not disturb', 'Silences everything while it is on.', w.dndEnabled, (value) => saveQuiet({ dndEnabled: value })));
    quiet.appendChild(switchRow('Quiet hours', 'Silences between two times of day.', w.quietHoursOn, (value) => saveQuiet({ quietHoursOn: value })));

    const start = el('input', { class: 'input input--compact', type: 'time', 'aria-label': 'Quiet hours start' });
    const end = el('input', { class: 'input input--compact', type: 'time', 'aria-label': 'Quiet hours end' });
    start.value = minutesToTime(w.quietStart);
    end.value = minutesToTime(w.quietEnd);
    start.addEventListener('change', () => saveQuiet({ quietStart: timeToMinutes(start.value) }));
    end.addEventListener('change', () => saveQuiet({ quietEnd: timeToMinutes(end.value) }));
    quiet.appendChild(prow({
      top: true,
      title: 'From and until',
      sub: 'In your own local time.',
      control: el('div', { class: 'row-actions' }, start, el('span', { class: 'prow-sub' }, 'to'), end),
    }));

    quiet.appendChild(switchRow('Reduced motion', 'Fewer animations across the interface.', w.reducedMotion, (value) => saveQuiet({ reducedMotion: value })));
  }

  async function saveKinds(patch) {
    try {
      const out = await Api.setNotificationPrefs(patch);
      paintKinds(out.effective || {});
    } catch (error) { errorToast(error); }
  }

  async function saveQuiet(patch) {
    try { paintQuiet(await Api.setWellbeing(patch)); }
    catch (error) { errorToast(error); }
  }

  async function load() {
    try {
      const [prefs, rest] = await Promise.all([Api.notificationPrefs(), Api.wellbeing()]);
      paintKinds((prefs && (prefs.global || prefs)) || {});
      paintQuiet(rest || {});
    } catch (error) {
      kinds.replaceChildren(failure(error, load));
    }
  }

  const kindsPanel = panel({ title: 'What you are told about', note: 'One switch per kind', body: kinds, tight: true });
  const quietPanel = panel({ title: 'When you are left alone', body: quiet, tight: true });
  load();
  return [kindsPanel, quietPanel];
}

function minutesToTime(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return '22:00';
  const h = Math.floor(value / 60) % 24;
  const m = Math.round(value % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function timeToMinutes(text) {
  const parts = String(text || '').split(':');
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  return h * 60 + m;
}

// -- appearance --------------------------------------------------------------

const THEMES = [
  { value: 'system', label: 'Match the system', hint: 'Follow your operating system.' },
  { value: 'trycord', label: 'Dark', hint: 'The default Trycord look.' },
  { value: 'light', label: 'Light', hint: 'For bright rooms.' },
];

function appearanceSection() {
  const rows = el('div', {});

  function paint() {
    const current = currentTheme();
    rows.replaceChildren();
    for (const option of THEMES) {
      rows.appendChild(prow({
        onClick: () => { setTheme(option.value); paint(); },
        active: current === option.value,
        lead: icon(current === option.value ? 'check' : 'image', { size: 17 }),
        title: option.label,
        sub: option.hint,
      }));
    }
  }
  paint();
  return [panel({ title: 'Theme', note: 'How the interface is coloured', body: rows, flush: true })];
}

// -- server ------------------------------------------------------------------

function backendSection() {
  const url = el('input', { class: 'input', type: 'url', 'aria-label': 'Server address' });
  url.value = TrycordConfig.backendUrl();
  const error = el('div', { class: 'form-error', role: 'status' });
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Use this server');
  save.addEventListener('click', () => {
    error.textContent = '';
    const value = url.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(value)) {
      error.textContent = 'An address starts with http:// or https://.';
      return;
    }
    TrycordConfig.setApiUrl(value);
    location.reload();
  });
  return [panel({
    title: 'Server',
    note: 'Where this client reads and writes',
    body: [fieldBlock('Address', 'The base address of the Trycord server you use.', url), error],
    foot: save,
    footEnd: true,
  })];
}

// -- instance ----------------------------------------------------------------

function updatesSection() {
  const info = State.instance || {};
  return [panel({
    title: 'This instance',
    note: 'What the server reports',
    rows: [
      prow({ title: 'Name', control: el('span', { class: 'prow-sub' }, info.name || 'Trycord') }),
      prow({ title: 'Version', control: el('span', { class: 'prow-sub' }, info.version || 'unknown') }),
      prow({
        title: 'Help',
        sub: 'Reach the people who run this server.',
        actions: el('a', { class: 'btn btn--ghost btn--sm', href: publicPath('/support') }, 'Support'),
      }),
    ],
  })];
}

// -- security ----------------------------------------------------------------

function securitySection() {
  return [notice({
    icon: 'shield',
    title: 'A password is the only key to this account',
    text: 'Changing it, adding a second step and dropping a device each have a section of their own below.',
  })];
}

function passwordSection() {
  const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const error = el('div', { class: 'form-error', role: 'status' });
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Change password');
  save.addEventListener('click', async () => {
    error.textContent = '';
    if (next.value.length < 8) { error.textContent = 'Use at least 8 characters.'; return; }
    if (next.value !== confirm.value) { error.textContent = 'The two new passwords do not match.'; return; }
    save.disabled = true;
    try {
      await Api.changePassword({ currentPassword: current.value, newPassword: next.value });
      current.value = next.value = confirm.value = '';
      toast('Password changed.', { type: 'success' });
    } catch (err) { errorToast(err); } finally { save.disabled = false; }
  });
  return [panel({
    title: 'Change password',
    note: 'Eight characters or more',
    body: [
      fieldBlock('Current password', null, current),
      fieldBlock('New password', null, next),
      fieldBlock('Repeat the new password', null, confirm),
      error,
    ],
    foot: save,
    footEnd: true,
  })];
}

function sessionsSection() {
  const rows = el('div', {});
  const signOutOthers = el('button', { class: 'btn btn--danger btn--sm', type: 'button' }, 'Sign out other devices');
  signOutOthers.addEventListener('click', async () => {
    const sure = await confirmDialog({ title: 'Sign out other devices?', body: 'Every device except this one will need to sign in again.', confirmLabel: 'Sign out', danger: true });
    if (!sure) return;
    try { await Api.revokeOthers(); toast('Other devices signed out.', { type: 'success' }); load(); }
    catch (error) { errorToast(error); }
  });

  function paint(sessions) {
    rows.replaceChildren();
    if (!sessions.length) {
      rows.appendChild(empty({ icon: 'monitor', title: 'This device only', text: 'Sign in somewhere else and it will appear here.' }));
      return;
    }
    for (const session of sessions) {
      rows.appendChild(prow({
        lead: icon('monitor', { size: 17 }),
        title: session.label || 'Unknown device',
        sub: session.lastSeenAt ? 'Last active ' + relative(session.lastSeenAt) : null,
        actions: session.current
          ? el('span', { class: 'prow-sub' }, 'This device')
          : el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: async (event) => {
              event.currentTarget.disabled = true;
              try { await Api.revokeSession(session.jti); load(); }
              catch (error) { errorToast(error); event.currentTarget.disabled = false; }
            },
          }, 'Sign out'),
      }));
    }
  }

  async function load() {
    rows.replaceChildren(loading('Loading devices'));
    try {
      const out = await Api.sessions();
      paint((out && out.sessions) || []);
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }

  const devices = panel({ title: 'Signed-in devices', note: 'Revoke anything you do not recognise', body: rows, flush: true });
  load();
  return [
    devices,
    panel({
      title: 'Everywhere else',
      rows: [
        prow({
          title: 'Keep this device, drop the rest',
          sub: 'A safer move than changing your password.',
          actions: signOutOthers,
        }),
      ],
    }),
  ];
}

// -- two-step sign-in --------------------------------------------------------

function twoFactorSection() {
  const rows = el('div', {});

  async function load() {
    rows.replaceChildren(loading('Checking'));
    try {
      const status = await Api.twoFactorStatus();
      rows.replaceChildren();
      if (status.enabled) {
        rows.appendChild(prow({
          lead: icon('shield', { size: 17 }),
          title: 'Two-step sign-in is on',
          sub: 'The code from your authenticator is asked for when you sign in.',
          actions: el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: reissue }, 'New recovery codes'),
        }));
        rows.appendChild(prow({
          title: 'Turn it off',
          sub: 'Your password alone will sign you in again.',
          actions: el('button', { class: 'btn btn--danger btn--sm', type: 'button', onClick: disable }, 'Turn off'),
        }));
      } else {
        rows.appendChild(notice({
          icon: 'lock',
          title: 'Two-step sign-in is off',
          text: 'A password alone is one guess away from the wrong person. Add a code from an authenticator app as a second step.',
          actions: el('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: setup }, 'Set up'),
        }));
      }
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }

  function showCodes(codes) {
    let dialog;
    dialog = openDialog({
      title: 'Save your recovery codes',
      sub: 'Each one signs you in once if you lose your authenticator. This is the only time they are shown.',
      body: el('div', { class: 'recovery-codes' }, codes.map((code) => el('code', { class: 'secret-code' }, code))),
      foot: [
        el('button', {
          class: 'btn btn--default', type: 'button',
          onClick: () => {
            const text = codes.join('\n');
            try { navigator.clipboard.writeText(text); toast('Codes copied.', { type: 'success' }); }
            catch { toast('Copying is not available here. Write them down.', { type: 'info' }); }
          },
        }, 'Copy all'),
        el('button', { class: 'btn btn--primary', type: 'button', onClick: () => dialog.close() }, 'I saved them'),
      ],
    });
  }

  // Two steps in one dialog: the server will not hand back a secret until the
  // password is confirmed, and it will not enable the factor until a code from
  // that secret proves the app is set up. Asking for both up front would be
  // asking for a code that cannot exist yet.
  function setup() {
    const password = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Your password' });
    const code = el('input', { class: 'input', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': 'Six-digit code' });
    const secret = el('code', { class: 'secret-code' });
    const error = el('div', { class: 'form-error', role: 'status' });
    const body = el('div', { class: 'stack stack--tight' }, fieldBlock('Password', 'Confirm it is you.', password));
    let phase = 1;
    let dialog;

    const next = el('button', { class: 'btn btn--primary', type: 'button' }, 'Continue');
    next.addEventListener('click', async () => {
      error.textContent = '';
      next.disabled = true;
      try {
        if (phase === 1) {
          if (!password.value) { error.textContent = 'Enter your password.'; return; }
          const out = await Api.twoFactorSetup({ password: password.value });
          secret.textContent = out.secret || '';
          body.replaceChildren(
            fieldBlock('Secret', 'Type this into your authenticator app.', secret),
            fieldBlock('Six digits', 'What the app shows once the secret is added.', code));
          next.textContent = 'Turn on';
          phase = 2;
          code.focus();
        } else {
          if (!/^\d{6}$/.test(code.value.trim())) { error.textContent = 'Enter the six digits the app shows.'; return; }
          const out = await Api.twoFactorEnable({ password: password.value, code: code.value.trim() });
          dialog.close();
          toast('Two-step sign-in is on.', { type: 'success' });
          load();
          if (out && out.recoveryCodes && out.recoveryCodes.length) showCodes(out.recoveryCodes);
        }
      } catch (err) {
        error.textContent = err.message || 'That did not work.';
      } finally { next.disabled = false; }
    });

    dialog = openDialog({
      title: 'Set up two-step sign-in',
      sub: 'Add the secret to an authenticator app, then confirm with the code it shows.',
      body: [body, error],
      foot: [
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
        next,
      ],
    });
  }

  function reissue() {
    passwordDialog({
      title: 'New recovery codes',
      sub: 'The old set stops working the moment a new one is made.',
      confirmLabel: 'Make new codes',
      onConfirm: async (password, dialog) => {
        const out = await Api.twoFactorRecoveryCodes({ password });
        dialog.close();
        showCodes(out.recoveryCodes || []);
      },
    });
  }

  function disable() {
    passwordDialog({
      title: 'Turn off two-step sign-in',
      sub: 'Your password alone will sign you in again.',
      confirmLabel: 'Turn off',
      danger: true,
      onConfirm: async (password, dialog) => {
        await Api.twoFactorDisable({ password });
        dialog.close();
        toast('Two-step sign-in is off.', { type: 'success' });
        load();
      },
    });
  }

  const card = panel({ title: 'Two-step sign-in', note: 'A code as well as a password', body: rows, tight: true });
  load();
  return [card];
}

// -- the page ----------------------------------------------------------------

const SECTIONS = {
  profile: profileSection,
  security: securitySection,
  password: passwordSection,
  sessions: sessionsSection,
  twofactor: twoFactorSection,
  privacy: privacySection,
  notifications: notificationsSection,
  appearance: appearanceSection,
  backend: backendSection,
  updates: updatesSection,
};

function settingsNav(activeId) {
  const nav = el('nav', { class: 'settings-nav', 'aria-label': 'Settings' });
  for (const group of scopeNav('account')) {
    nav.appendChild(el('div', { class: 'settings-nav-group' },
      el('div', { class: 'split-label' }, group.group),
      el('div', { class: 'settings-nav-list' },
        group.items.map((item) => prow({
          href: path(item.route),
          lead: icon(item.icon, { size: 17 }),
          title: item.label,
          active: item.id === activeId,
        })))));
  }
  return nav;
}

export function renderSettings(ctx) {
  const content = el('div', { class: 'stack' });
  const node = page({ wide: true },
    band({
      eyebrow: 'Settings',
      icon: 'settings',
      title: ctx.page.label || 'Settings',
      lede: ctx.page.blurb || null,
    }),
    el('div', { class: 'settings-layout' }, settingsNav(ctx.page.id), content));

  for (const tab of ctx.page.tabs || []) {
    const build = SECTIONS[tab];
    if (!build) continue;
    try {
      for (const part of [].concat(build())) if (part) content.appendChild(part);
    } catch (error) {
      content.appendChild(notice({
        tone: 'danger',
        title: 'This section did not build',
        text: String((error && error.message) || error),
      }));
    }
  }

  return { node, head: [], onMount() {} };
}

export default { renderSettings };
