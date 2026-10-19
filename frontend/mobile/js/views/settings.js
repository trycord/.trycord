// Account settings, on a phone.
//
// One screen per destination in the account scope, with the scope's own list as
// a horizontal strip above it. The strip is built from the registry, so a
// settings page that exists is a page the strip offers and the other way round.
// This is the Mobile module's own settings tree; it shares the platform packages
// and nothing else.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar, empty, loading, failure } from '../components.js';
import { State, loadSession, applyToken } from '../../../packages/store.js';
import Api from '../../../packages/api.js';
import { TrycordConfig } from '../../../packages/config.js';
import { path, publicPath } from '../../../packages/nav.js';
import { scopeNav } from '../../../packages/registry.js';
import { toast, confirm, sheet } from '../ui.js';
import { currentTheme, setTheme, THEMES } from '../../../packages/theme.js';
import { relativeTime } from '../../../packages/format.js';
import { screen } from './util.js';

function field(label, control, note) {
  return el('label', { class: 'm-field' },
    el('span', { class: 'm-field__label' }, label),
    control,
    note ? el('span', { class: 'm-field__note' }, note) : null);
}

const SCOPES = [
  { value: 'anyone', label: 'Anyone' },
  { value: 'friends', label: 'Friends' },
  { value: 'nobody', label: 'Nobody' },
];

const NOTIFICATION_KINDS = [
  ['dm', 'Direct messages', 'When someone messages you one to one.'],
  ['mention', 'Mentions', 'When someone writes your name.'],
  ['friend', 'Friends', 'Requests you receive and acceptances.'],
  ['moderation', 'Moderation', 'When a moderator acts where you are.'],
  ['announcement', 'Announcements', 'When a community announces something.'],
];

function switchRow(label, hint, initial, onChange) {
  let value = !!initial;
  const control = el('button', {
    class: 'm-switch' + (value ? ' is-on' : ''), type: 'button', role: 'switch',
    'aria-checked': String(value), 'aria-label': label,
  });
  control.addEventListener('click', () => {
    value = !value;
    control.setAttribute('aria-checked', String(value));
    control.classList.toggle('is-on', value);
    onChange(value);
  });
  return el('div', { class: 'm-row' },
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title' }, label),
      hint ? el('span', { class: 'm-row__sub' }, hint) : null),
    el('span', { class: 'm-row__actions' }, control));
}

function selectRow(label, hint, options, value, onChange) {
  const select = el('select', { class: 'm-input m-input--select', 'aria-label': label });
  for (const option of options) select.appendChild(el('option', { value: option.value, selected: option.value === value ? true : null }, option.label));
  select.addEventListener('change', () => onChange(select.value));
  return el('div', { class: 'm-row' },
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title' }, label),
      hint ? el('span', { class: 'm-row__sub' }, hint) : null),
    el('span', { class: 'm-row__actions' }, select));
}

function group(title, children) {
  return el('section', { class: 'm-section' },
    el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, title)),
    children);
}

// -- profile -----------------------------------------------------------------

function profileBody() {
  const host = el('div', { class: 'm-stack' });
  const me = State.user || {};
  const displayName = el('input', { class: 'm-input', maxlength: '60', value: me.displayName || '', 'aria-label': 'Display name' });
  const bio = el('textarea', { class: 'm-input m-input--area', rows: '3', maxlength: '400', 'aria-label': 'About' }, me.bio || '');
  const statusText = el('input', { class: 'm-input', maxlength: '128', value: me.statusText || '', 'aria-label': 'Status' });
  const save = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Save profile');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await Api.updateMe({ displayName: displayName.value.trim(), bio: bio.value, statusText: statusText.value });
      await loadSession();
      toast('Profile saved.', { type: 'success' });
    } catch (error) { toast(error.message, { type: 'danger' }); }
    finally { save.disabled = false; }
  });

  function imageRow(title, hint, url, kind, label) {
    const preview = url ? avatar({ ...(State.user || {}), avatarUrl: url }, { size: 'lg', decorative: true })
      : el('span', { class: 'm-mark' }, icon('image', { size: 20 }));
    const input = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', 'aria-label': label, tabindex: '-1' });
    const upload = el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button' }, label);
    upload.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      upload.disabled = true;
      try { await Api.uploadProfileImage(kind, file); await loadSession(); toast('Image updated.', { type: 'success' }); paint(); }
      catch (error) { toast(error.message, { type: 'danger' }); }
      finally { upload.disabled = false; }
    });
    const remove = el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button' }, 'Remove');
    remove.addEventListener('click', async () => {
      try { await Api.removeProfileImage(kind); await loadSession(); paint(); toast('Image removed.', { type: 'success' }); }
      catch (error) { toast(error.message, { type: 'danger' }); }
    });
    return el('div', { class: 'm-media-row' },
      el('div', { class: 'm-media-preview' }, preview),
      el('div', { class: 'm-media-controls' },
        el('div', { class: 'm-media-controls__title' }, title),
        el('div', { class: 'm-media-controls__hint' }, hint),
        input, el('div', { class: 'm-actions' }, upload, url ? remove : null)));
  }

  const resend = el('button', {
    class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
    onClick: async (event) => {
      event.currentTarget.disabled = true;
      try { await Api.verifyEmailResend(); toast('Verification link sent.', { type: 'success' }); }
      catch (error) { toast(error.message, { type: 'danger' }); }
      finally { event.currentTarget.disabled = false; }
    },
  }, 'Resend link');

  const deletion = el('button', { class: 'm-btn m-btn--ghost m-btn--danger', type: 'button' }, 'Request deletion');
  deletion.addEventListener('click', async () => {
    const sure = await confirm({
      title: 'Delete your account?',
      text: 'This schedules your account and its content for erasure. You can cancel while the window is open.',
      confirmLabel: 'Request deletion', danger: true,
    });
    if (!sure) return;
    try { await Api.requestDeletion({ confirm: true }); toast('Deletion requested.', { type: 'success' }); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  });

  function paint() {
    const current = State.user || {};
    host.replaceChildren(
      group('Profile', el('div', { class: 'm-stack' },
        field('Display name', displayName, 'The name people see.'),
        field('About', bio, 'A short description on your profile.'),
        field('Status', statusText, 'Shown beside your name.'),
        save)),
      group('Images', el('div', { class: 'm-stack' },
        imageRow('Profile photo', 'Shown beside your name everywhere.', current.avatarUrl, 'avatar', 'Upload photo'),
        imageRow('Banner', 'A wide image on your profile.', current.bannerUrl, 'banner', 'Upload banner'))),
      group('Email', el('div', { class: 'm-list' },
        el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, current.email || 'No email on file'),
            el('span', { class: 'm-row__sub' }, current.emailVerified ? 'Verified' : 'Not verified')),
          current.emailVerified ? null : el('span', { class: 'm-row__actions' }, resend)))),
      group('Delete your account',
        el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'Every channel, message and membership goes.')),
          el('span', { class: 'm-row__actions' }, deletion))),
    );
  }

  paint();
  return host;
}

// -- security ----------------------------------------------------------------

function securityBody() {
  const host = el('div', { class: 'm-stack' });

  const current = el('input', { class: 'm-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  const next = el('input', { class: 'm-input', type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
  const again = el('input', { class: 'm-input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat new password' });
  const change = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Change password');
  change.addEventListener('click', async () => {
    if (next.value.length < 8) { toast('Use at least 8 characters.', { type: 'info' }); return; }
    if (next.value !== again.value) { toast('The two new passwords do not match.', { type: 'info' }); return; }
    change.disabled = true;
    try {
      const out = await Api.changePassword({ currentPassword: current.value, newPassword: next.value });
      // The server ends every session when the password changes and hands
      // back one for this device. Without taking it, the next request would
      // be refused and the reader signed out by their own password change.
      if (out && out.token) applyToken(out.token, out.user);
      current.value = next.value = again.value = '';
      toast('Password changed.', { type: 'success' });
    } catch (error) { toast(error.message, { type: 'danger' }); }
    finally { change.disabled = false; }
  });

  const devices = el('div', { class: 'm-list' });
  const signOutOthers = el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button' }, 'Sign out other devices');
  signOutOthers.addEventListener('click', async () => {
    const sure = await confirm({ title: 'Sign out other devices?', text: 'Every device except this one will need to sign in again.', confirmLabel: 'Sign out', danger: true });
    if (!sure) return;
    try { await Api.revokeOthers(); toast('Other devices signed out.', { type: 'success' }); loadSessions(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  });

  async function loadSessions() {
    devices.replaceChildren(loading('Loading devices'));
    try {
      const out = await Api.sessions();
      const sessions = (out && out.sessions) || [];
      devices.replaceChildren();
      if (!sessions.length) {
        devices.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'This device only.'))));
        return;
      }
      for (const session of sessions) {
        devices.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('monitor', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, session.label || 'Unknown device'),
            el('span', { class: 'm-row__sub' }, session.lastSeenAt ? 'Last active ' + relativeTime(session.lastSeenAt) : '')),
          el('span', { class: 'm-row__actions' }, session.current
            ? el('span', { class: 'm-row__sub' }, 'This device')
            : el('button', {
              class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
              onClick: async (event) => {
                event.currentTarget.disabled = true;
                try { await Api.revokeSession(session.jti); loadSessions(); }
                catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
              },
            }, 'Sign out'))));
      }
    } catch (error) {
      devices.replaceChildren(failure(error, loadSessions));
    }
  }

  const twoFactor = el('div', { class: 'm-list' });
  async function loadTwoFactor() {
    twoFactor.replaceChildren(loading('Checking two-step sign-in'));
    try {
      const status = await Api.twoFactorStatus();
      twoFactor.replaceChildren();
      if (status && status.enabled) {
        twoFactor.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Two-step sign-in is on')),
          el('span', { class: 'm-row__actions' }, el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            onClick: () => recoveryCodes(loadTwoFactor),
          }, 'Recovery codes'))));
        twoFactor.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Turn off')),
          el('span', { class: 'm-row__actions' }, el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            onClick: () => disableTwoFactor(loadTwoFactor),
          }, 'Turn off'))));
      } else {
        twoFactor.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, 'Two-step sign-in is off'),
            el('span', { class: 'm-row__sub' }, 'A code from an authenticator app adds a second key.')),
          el('span', { class: 'm-row__actions' }, el('button', {
            class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
            onClick: () => enableTwoFactor(loadTwoFactor),
          }, 'Set up'))));
      }
    } catch (error) {
      twoFactor.replaceChildren(failure(error, loadTwoFactor));
    }
  }

  host.append(
    group('Change password', el('div', { class: 'm-stack' },
      field('Current password', current),
      field('New password', next),
      field('Repeat the new password', again),
      change)),
    group('Signed-in devices', el('div', { class: 'm-stack' }, devices,
      el('div', { class: 'm-actions' }, signOutOthers))),
    group('Two-step sign-in', twoFactor));

  loadSessions();
  loadTwoFactor();
  return host;
}

async function enableTwoFactor(reload) {
  const password = el('input', { class: 'm-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const code = el('input', { class: 'm-input', inputmode: 'numeric', 'aria-label': 'Code' });
  const secret = el('code', { class: 'm-secret' }, '');
  let stage = 'password';
  let saved = '';
  const body = el('div', { class: 'm-stack' },
    el('p', { class: 'm-lede' }, 'Confirm your password, then scan the secret in your authenticator app.'),
    field('Password', password),
    el('div', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Secret'), secret),
    field('Code from your app', code));
  const commit = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Continue');
  const layer = sheet({ title: 'Set up two-step sign-in', body, footer: commit });

  async function step() {
    commit.disabled = true;
    try {
      if (stage === 'password') {
        const out = await Api.twoFactorSetup({ password: password.value });
        saved = password.value;
        secret.textContent = (out && out.secret) || '';
        stage = 'code';
        code.focus();
      } else {
        const out = await Api.twoFactorEnable({ password: saved, code: code.value.trim() });
        layer.close();
        toast('Two-step sign-in is on.', { type: 'success' });
        if (out && out.recoveryCodes && out.recoveryCodes.length) showCodes(out.recoveryCodes);
        reload();
      }
    } catch (error) { toast(error.message, { type: 'danger' }); }
    finally { commit.disabled = false; }
  }
  commit.addEventListener('click', step);
}

function showCodes(codes) {
  sheet({
    title: 'Recovery codes',
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'Save these now. Each signs you in once if you lose your authenticator.'),
      el('div', { class: 'm-codes' }, codes.map((value) => el('code', { class: 'm-secret' }, value)))),
    footer: el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button', onClick: () => toast('Kept.', { type: 'success' }) }, 'Done'),
  });
}

function recoveryCodes(reload) {
  const password = el('input', { class: 'm-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const layer = sheet({
    title: 'New recovery codes',
    body: el('div', { class: 'm-stack' }, el('p', { class: 'm-lede' }, 'Your password confirms this change.'), field('Password', password)),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const out = await Api.twoFactorRecoveryCodes({ password: password.value });
          layer.close();
          showCodes((out && out.recoveryCodes) || []);
          reload();
        } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
      },
    }, 'Generate'),
  });
}

function disableTwoFactor(reload) {
  const password = el('input', { class: 'm-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const code = el('input', { class: 'm-input', type: 'text', inputmode: 'numeric', maxlength: '6', 'aria-label': 'Code from your app' });
  const layer = sheet({
    title: 'Turn off two-step sign-in',
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'Your password and a code from your app are both needed.'),
      field('Password', password),
      field('Code from your app', code)),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await Api.twoFactorDisable({ password: password.value, code: code.value.trim() });
          layer.close();
          toast('Two-step sign-in is off.', { type: 'success' });
          reload();
        } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
      },
    }, 'Turn off'),
  });
}

// -- privacy -----------------------------------------------------------------

function privacyBody() {
  const host = el('div', { class: 'm-stack' });
  const reach = el('div', { class: 'm-list' });
  const blocked = el('div', { class: 'm-list' });

  function paint(settings) {
    reach.replaceChildren(
      selectRow('Who can send friend requests', 'Requests from outside this group are refused.', SCOPES, settings.friendRequests, (value) => save({ friendRequests: value })),
      selectRow('Who can message you', 'Whether a stranger can open a conversation.', SCOPES, settings.dms, (value) => save({ dms: value })),
      selectRow('Who can see when you are online', null, SCOPES, settings.presence, (value) => save({ presence: value })),
      switchRow('Searchable by username', 'Lets people find you when they type your username.', settings.discoverable, (value) => save({ discoverable: value })));
  }

  function paintBlocks(rows) {
    blocked.replaceChildren();
    if (!rows.length) {
      blocked.appendChild(empty({ icon: 'shield', title: 'Nobody is blocked', text: 'People you block cannot message you, add you or see your activity.' }));
      return;
    }
    for (const entry of rows) {
      const user = entry.user || entry;
      blocked.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, user.displayName || user.username),
          el('span', { class: 'm-row__sub' }, '@' + (user.username || ''))),
        el('span', { class: 'm-row__actions' }, el('button', {
          class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
          onClick: async (event) => {
            event.currentTarget.disabled = true;
            try { await Api.unblockUser(user.id); paintBlocks(rows.filter((row) => (row.user || row).id !== user.id)); }
            catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
          },
        }, 'Unblock'))));
    }
  }

  async function save(patch) {
    try { paint(await Api.setPrivacy(patch)); toast('Saved.', { type: 'success' }); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function load() {
    try {
      const [settings, rows] = await Promise.all([Api.privacy(), Api.blocks()]);
      paint(settings);
      paintBlocks(Array.isArray(rows) ? rows : (rows && rows.items) || []);
    } catch (error) {
      reach.replaceChildren(failure(error, load));
    }
  }

  host.append(group('Who can reach you', reach), group('Blocked accounts', blocked));
  load();
  return host;
}

// -- notifications -----------------------------------------------------------

function minutesToTime(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return '22:00';
  const h = Math.floor(value / 60) % 24;
  const m = Math.round(value % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function timeToMinutes(value) {
  const [h, m] = String(value || '').split(':');
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

function notificationsBody() {
  const host = el('div', { class: 'm-stack' });
  const kinds = el('div', { class: 'm-list' });
  const quiet = el('div', { class: 'm-list' });

  function paintKinds(prefs) {
    kinds.replaceChildren();
    for (const [key, label, hint] of NOTIFICATION_KINDS) {
      kinds.appendChild(switchRow(label, hint, prefs[key] !== false, (value) => saveKinds({ [key]: value })));
    }
  }

  async function saveKinds(patch) {
    try {
      const out = await Api.setNotificationPrefs(patch);
      paintKinds(out.effective || {});
    } catch (error) { toast(error.message, { type: 'danger' }); }
  }

  function paintQuiet(w) {
    quiet.replaceChildren();
    quiet.appendChild(switchRow('Do not disturb', 'Silences everything while it is on.', w.dndEnabled, (value) => saveQuiet({ dndEnabled: value })));
    quiet.appendChild(switchRow('Quiet hours', 'Silences between two times of day.', w.quietHoursOn, (value) => saveQuiet({ quietHoursOn: value })));
    const start = el('input', { class: 'm-input m-input--compact', type: 'time', 'aria-label': 'Quiet hours start', value: minutesToTime(w.quietStart) });
    const end = el('input', { class: 'm-input m-input--compact', type: 'time', 'aria-label': 'Quiet hours end', value: minutesToTime(w.quietEnd) });
    start.addEventListener('change', () => saveQuiet({ quietStart: timeToMinutes(start.value) }));
    end.addEventListener('change', () => saveQuiet({ quietEnd: timeToMinutes(end.value) }));
    quiet.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'From and until'), el('span', { class: 'm-row__sub' }, 'In your own local time.')),
      el('span', { class: 'm-row__actions' }, start, el('span', { class: 'm-row__sub' }, 'to'), end)));
    quiet.appendChild(switchRow('Reduced motion', 'Fewer animations across the interface.', w.reducedMotion, (value) => saveQuiet({ reducedMotion: value })));
  }

  async function saveQuiet(patch) {
    try { paintQuiet(await Api.setWellbeing(patch)); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function load() {
    try {
      const [prefs, w] = await Promise.all([Api.notificationPrefs(), Api.wellbeing()]);
      paintKinds((prefs && (prefs.global || prefs)) || {});
      paintQuiet(w || {});
    } catch (error) {
      kinds.replaceChildren(failure(error, load));
    }
  }

  host.append(group('What you are told about', kinds), group('When you are left alone', quiet));
  load();
  return host;
}

// -- appearance --------------------------------------------------------------

function appearanceBody() {
  const host = el('div', { class: 'm-list' });
  const choices = THEMES.filter((theme) => theme.id !== 'custom');
  function paint() {
    clear(host);
    for (const theme of choices) {
      const active = currentTheme() === theme.id;
      host.appendChild(el('button', {
        class: 'm-row' + (active ? ' is-active' : ''), type: 'button',
        onClick: () => { setTheme(theme.id); paint(); },
      },
        el('span', { class: 'm-row__lead' }, icon(theme.scheme === 'light' ? 'sun' : theme.id === 'system' ? 'monitor' : 'moon', { size: 18 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, theme.label),
          el('span', { class: 'm-row__sub' }, theme.summary)),
        el('span', { class: 'm-row__actions' }, active ? icon('check', { size: 18 }) : null)));
    }
  }
  paint();
  return el('div', { class: 'm-stack' }, group('Theme', host));
}

// -- connection --------------------------------------------------------------

function backendBody() {
  const url = el('input', { class: 'm-input', type: 'url', value: TrycordConfig.backendUrl(), 'aria-label': 'Server address' });
  const error = el('p', { class: 'm-lede' });
  const save = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Use this server');
  save.addEventListener('click', () => {
    error.textContent = '';
    const value = url.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(value)) { error.textContent = 'An address starts with http:// or https://.'; return; }
    TrycordConfig.setApiUrl(value);
    window.location.reload();
  });
  return el('div', { class: 'm-stack' },
    group('Server', el('div', { class: 'm-stack' },
      field('Address', url, 'The base address of the Trycord server you use.'),
      error, save)));
}

// -- this instance -----------------------------------------------------------

function updatesBody() {
  const info = State.instance || {};
  return el('div', { class: 'm-stack' },
    group('This instance', el('div', { class: 'm-list' },
      el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Name')), el('span', { class: 'm-row__actions' }, info.name || 'Trycord')),
      el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Version')), el('span', { class: 'm-row__actions' }, info.version || 'unknown')),
      el('a', { class: 'm-row', href: publicPath('/support') },
        el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Support'), el('span', { class: 'm-row__sub' }, 'Reach the people who run this server.')),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))))));
}

export function renderSettings(ctx) {
  const page = ctx.page || {};
  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Settings' });
  for (const group of scopeNav('account')) {
    for (const item of group.items) {
      strip.appendChild(el('a', {
        class: 'm-seg__item' + (item.id === page.id ? ' is-active' : ''),
        role: 'tab', href: item.route ? path(item.route) : path('/settings'),
        'aria-selected': item.id === page.id ? 'true' : 'false',
      }, item.label));
    }
  }

  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, page.label || 'Settings'),
      el('div', { class: 'm-hero__sub' }, page.blurb || 'Your account on this instance.')),
    strip, host);

  const bodies = {
    settings: profileBody,
    'settings.security': securityBody,
    'settings.privacy': privacyBody,
    'settings.notifications': notificationsBody,
    'settings.appearance': appearanceBody,
    'settings.backend': backendBody,
    'settings.updates': updatesBody,
  };

  return {
    node,
    head: { lead: 'back', title: 'Settings' },
    onMount() {
      const build = bodies[page.id] || profileBody;
      try {
        host.replaceChildren(build());
      } catch (error) {
        host.replaceChildren(failure(error, () => host.replaceChildren(build())));
      }
    },
  };
}

export default { renderSettings };
