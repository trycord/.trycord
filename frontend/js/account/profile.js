// profile — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import Api from '../api.js';
import State, { mustVerifyToPost } from '../state.js';
import { el, clear, toast, confirmDialog } from '../ui.js';
import { avatar, loadAuthedImage, invalidateAuthedImage, statusChip } from '../components.js';
import { renderAllChrome } from '../shell.js';

const DELETION_STATUS_TEXT = {
  DELETION_REQUESTED: 'Requested. An administrator will review it.',
  UNDER_REVIEW: 'Approved and queued for processing.',
  DELETION_PROCESSING: 'Being processed now.',
  DELETED: 'Completed. This account can no longer sign in.',
  CANCELLED: 'Withdrawn.',
  REJECTED: 'Declined. You can submit a new request.',
};

export function renderProfileEditor(wrap) {
  const me = State.me;
  const err = el('div', { class: 'form-error', hidden: true });
  const okBox = el('div', { class: 'form-success', hidden: true });

  const display = el('input', {
    class: 'input', type: 'text', value: me ? (me.displayName || '') : '', maxlength: 32,
  });
  const bio = el('textarea', {
    class: 'input', maxlength: 200, rows: 3, placeholder: 'Tell people about yourself',
  }, (me && me.bio) || '');
  const statusText = el('input', {
    class: 'input', type: 'text', maxlength: 64, placeholder: 'e.g. building something cool',
    value: (me && me.statusText) || '',
  });

  const profileCard = el('div', { class: 'profile-editor' });

  const bannerBox = el('div', { class: 'prof-banner' });
  const avatarHolder = el('div', { class: 'prof-avatar' }, avatar(me, { size: 'lg', withPresence: false }));
  const previewName = el('strong', {}, me ? (me.displayName || me.username) : '');
  const previewSub = el('div', { class: 'muted small' }, me ? '@' + me.username : '');
  const previewStatus = el('div', { class: 'prof-status small' }, (me && me.statusText) || '');
  const previewBio = el('div', { class: 'prof-bio' }, (me && me.bio) || '');
  const paint = () => {
    const cur = State.me;
    previewName.textContent = display.value || (cur && cur.username) || '';
    previewBio.textContent = bio.value.trim();
    previewStatus.textContent = statusText.value.trim();
    previewStatus.hidden = !statusText.value.trim();
  };
  [display, bio, statusText].forEach((n) => n.addEventListener('input', paint));

  const paintMedia = () => {
    const cur = State.me;
    bannerBox.classList.toggle('has-banner', !!(cur && cur.bannerUrl));
    bannerBox.style.backgroundImage = '';
    if (cur && cur.bannerUrl) {
      loadAuthedImage(cur.bannerUrl).then((url) => {
        if (url) {
          bannerBox.style.backgroundImage = 'url("' + url + '")';
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
      });
    }
    // The unsaved pick is a bare URL rather than a user row, so it is handed to
    // the shared primitive as a user-shaped object. The previous version built
    // the span and the <img> here, which is why this file was a second avatar
    // renderer: it had to re-do the authenticated fetch and the blob revoke
    // that avatar() already owns, and a change to either would have applied to
    // the profile preview and not to every other avatar in the app.
    const shown = cur && cur.avatarUrl
      ? { ...State.me, avatar_url: cur.avatarUrl }
      : State.me;
    clear(avatarHolder);
    avatarHolder.appendChild(avatar(shown, { size: 'lg', withPresence: false }));
  };
  paintMedia();

  const preview = el('div', { class: 'prof-preview' }, bannerBox, avatarHolder,
    el('div', { class: 'prof-preview-body' }, previewName, previewSub, previewStatus, previewBio));
  profileCard.appendChild(preview);
  profileCard.appendChild(el('div', { class: 'hr' }));

  // Hidden, and therefore not reachable by keyboard or announced at all unless
  // named: the visible buttons are what a reader uses, and these are only the
  // mechanism behind them.
  const avatarInput = el('input', {
    type: 'file', accept: 'image/*', hidden: true,
    'aria-label': 'Choose an avatar image to upload',
  });
  const bannerInput = el('input', {
    type: 'file', accept: 'image/*', hidden: true,
    'aria-label': 'Choose a banner image to upload',
  });
  const avatarBtn = el('button', { class: 'btn', type: 'button' }, 'Change avatar');
  const avatarRm = el('button', { class: 'btn ghost', type: 'button', hidden: me ? !me.avatarUrl : true }, 'Remove avatar');
  const bannerBtn = el('button', { class: 'btn', type: 'button' }, 'Change banner');
  const bannerRm = el('button', { class: 'btn ghost', type: 'button', hidden: me ? !me.bannerUrl : true }, 'Remove banner');
  const mediaStatus = el('div', { class: 'muted small', 'aria-live': 'polite' });

  async function upload(kind, file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) { toast('Only images can be used.', 'error'); return; }
    mediaStatus.textContent = 'Uploading ' + kind + '…';
    const prev = kind === 'avatar' ? State.me?.avatarUrl : State.me?.bannerUrl;
    try {
      const updated = await Api.uploadProfileImage(kind, file);
      invalidateAuthedImage(prev);
      State.me = { ...State.me, ...updated };
      renderAllChrome();
      okBox.hidden = false;
      if (kind === 'avatar') avatarRm.hidden = !updated.avatarUrl;
      else bannerRm.hidden = !updated.bannerUrl;
      toast(kind === 'avatar' ? 'Avatar updated.' : 'Banner updated.', 'ok');
      paintMedia();
      mediaStatus.textContent = '';
    } catch (ex) {
      mediaStatus.textContent = '';
      toast(ex.message || 'Upload failed', 'error');
    }
  }
  avatarBtn.addEventListener('click', () => avatarInput.click());
  bannerBtn.addEventListener('click', () => bannerInput.click());
  avatarInput.addEventListener('change', () => upload('avatar', avatarInput.files[0]));
  bannerInput.addEventListener('change', () => upload('banner', bannerInput.files[0]));
  avatarRm.addEventListener('click', async () => {
    try {
      const prev = State.me?.avatarUrl;
      const updated = await Api.removeProfileImage('avatar');
      invalidateAuthedImage(prev);
      State.me = { ...State.me, ...updated };
      renderAllChrome();
      avatarRm.hidden = true;
      paintMedia();
      toast('Avatar removed.', 'ok');
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });
  bannerRm.addEventListener('click', async () => {
    try {
      const prev = State.me?.bannerUrl;
      const updated = await Api.removeProfileImage('banner');
      invalidateAuthedImage(prev);
      State.me = { ...State.me, ...updated };
      renderAllChrome();
      bannerRm.hidden = true;
      paintMedia();
      toast('Banner removed.', 'ok');
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });

  profileCard.appendChild(el('div', { class: 'section-label' }, 'Profile picture'));
  profileCard.appendChild(el('div', { class: 'row-line' }, avatarBtn, avatarRm, bannerBtn, bannerRm));
  profileCard.appendChild(avatarInput);
  profileCard.appendChild(bannerInput);
  profileCard.appendChild(mediaStatus);
  profileCard.appendChild(el('div', { class: 'hr' }));

  const saveBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Save profile');
  const form = el('form', {}, err, okBox,
    el('div', { class: 'field' }, el('label', {}, 'Display name'), display,
      el('span', { class: 'hint' }, 'Shown across communities and DMs.')),
    el('div', { class: 'field' }, el('label', {}, 'Status'), statusText,
      el('span', { class: 'hint' }, 'A short line shown on your identity and profile.')),
    el('div', { class: 'field' }, el('label', {}, 'About you'), bio,
      el('span', { class: 'hint' }, bio.value.length + '/200 characters')),
    el('div', {}, saveBtn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    okBox.hidden = true;
    try {
      const updated = await Api.updateMe({
        displayName: display.value.trim() || (me && me.username),
        bio: bio.value.trim(),
        statusText: statusText.value.trim(),
      });
      State.me = { ...State.me, ...updated };
      okBox.hidden = false;
      paint();
      toast('Profile saved.', 'ok');
      renderAllChrome();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });
  profileCard.appendChild(form);

  profileCard.appendChild(el('div', { class: 'section-label' }, 'Account email'));
  const emailBox = el('div', { class: 'field' });
  emailBox.appendChild(el('label', {}, 'Email'));
  const emailLine = el('div', { class: 'muted small' });
  const emailNote = el('div', { class: 'muted small', style: { marginTop: 'var(--space-2)' } });
  const emailActions = el('div', { class: 'row-line', style: { marginTop: 'var(--space-2)' } });

  const paintEmail = (cur) => {
    cur = cur || State.me || {};
    clear(emailLine);
    if (cur.email) {
      emailLine.appendChild(document.createTextNode(String(cur.email) + (cur.emailVerified ? ' · verified' : ' · unverified')));
    } else {
      emailLine.appendChild(document.createTextNode('No recovery email on file.'));
    }
  };
  paintEmail(me);

  const sendTo = async (address) => {
    try {
      await Api.verifyEmailResend({ email: address });
      emailNote.textContent = 'Verification email sent to ' + address + ' — click the link inside to confirm. It is valid for 24 hours and single use.';
      return true;
    } catch (ex) {
      emailNote.textContent = ex.message || 'Could not send the email.';
      return false;
    }
  };

  if (me && me.email && mustVerifyToPost()) {
    const resend = el('button', { class: 'btn sm', type: 'button' }, 'Resend verification');
    resend.addEventListener('click', () => sendTo(me.email));
    emailActions.appendChild(resend);
  }

  const changePanel = el('div', { style: { marginTop: 'var(--space-4)' }, hidden: true });
  const newEmail = el('input', { class: 'input', type: 'email', placeholder: 'new@example.com', required: true });
  const curPass = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Current password', required: true });
  const sendBtn = el('button', { class: 'btn primary sm', type: 'submit' }, (me && me.email ? 'Change' : 'Add') + ' email');
  const changeForm = el('form', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' } },
    el('div', { class: 'field' }, el('label', {}, 'New recovery email'), newEmail),
    el('div', { class: 'field' }, el('label', {}, 'Current password'), curPass,
      el('span', { class: 'hint' }, 'Required to prove this is your account.')),
    el('div', {}, sendBtn));
  changePanel.appendChild(changeForm);
  changeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    sendBtn.setAttribute('aria-busy', 'true');
    try {
      const target = newEmail.value.trim();
      await Api.changeEmail({ currentPassword: curPass.value, newEmail: target });
      changePanel.hidden = true;
      newEmail.value = '';
      curPass.value = '';
      await sendTo(target);
      toast('Email change requested.', 'ok');
    } catch (ex) {
      emailNote.textContent = ex.message || 'Could not request the change.';
    } finally {
      sendBtn.removeAttribute('aria-busy');
    }
  });

  const changeBtn = el('button', { class: 'btn sm', type: 'button' }, (me && me.email) ? 'Change email' : 'Add email');
  changeBtn.addEventListener('click', () => { changePanel.hidden = !changePanel.hidden; });
  emailActions.appendChild(changeBtn);

  emailBox.appendChild(emailLine);
  emailBox.appendChild(emailActions);
  emailBox.appendChild(emailNote);
  emailBox.appendChild(changePanel);
  profileCard.appendChild(emailBox);
  wrap.appendChild(profileCard);
}

export function renderExportSection(wrap) {
  wrap.appendChild(el('div', { class: 'section-label' }, 'Your data'));
  const panel = el('div', { class: 'card stack' });
  wrap.appendChild(panel);

  panel.appendChild(el('p', { class: 'muted small' },
    'Everything this instance holds about you, as a JSON file. It is assembled when you ask, '
    + 'from your own records, so it reflects what is there right now rather than when you signed up.'));

  const status = el('div', { class: 'muted small', role: 'status', 'aria-live': 'polite' });

  const download = el('button', { class: 'btn primary', type: 'button' }, 'Download my data');
  download.addEventListener('click', async () => {
    download.disabled = true;
    status.textContent = 'Gathering your data…';
    try {
      const payload = await Api.exportData();
      if (!payload || typeof payload !== 'object') throw new Error('The server did not return an export.');

      // Counted here rather than trusted from the payload, because the number a
      // reader is shown has to describe the file they are about to receive.
      const sections = Object.keys(payload.data || {}).length;
      const incomplete = payload.incomplete || null;

      const body = JSON.stringify(payload, null, 2);
      const blob = new Blob([body], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', {
        href: url,
        download: 'trycord-export-' + new Date().toISOString().slice(0, 10) + '.json',
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick rather than immediately: Firefox aborts the
      // download if the object URL disappears in the same turn as the click.
      setTimeout(() => URL.revokeObjectURL(url), 30000);

      if (incomplete) {
        status.textContent = 'Saved, but ' + incomplete.length + ' part(s) could not be read: '
          + incomplete.join('; ');
        toast('Export saved with warnings.', 'warn');
      } else {
        status.textContent = 'Saved: ' + sections + ' sections.';
        toast('Export saved.', 'ok');
      }
    } catch (e) {
      status.textContent = e.message || 'Could not gather your data.';
      toast(e.message || 'Could not export your data.', 'error');
    } finally {
      download.disabled = false;
    }
  });
  panel.appendChild(el('div', { class: 'row-line' }, download));
  panel.appendChild(status);

  panel.appendChild(el('p', { class: 'muted small' },
    'Not included, and not retrievable by anyone: your password, your two-factor secret, '
    + 'your recovery codes, and your session tokens. Those are not things you can read back '
    + 'even here - they are credentials, and an export is not a way to obtain one.'));
}

export function renderDeletionSection(wrap) {
  wrap.appendChild(el('div', { class: 'section-label danger' }, 'Delete my account'));
  const panel = el('div', { class: 'card' });
  wrap.appendChild(panel);

  const paint = (req) => {
    clear(panel);
    if (req && DELETION_STATUS_TEXT[req.status]) {
      panel.appendChild(el('div', { class: 'row-line' },
        el('strong', {}, 'Erasure request'),
        statusChip(req.status),
        // The type is rendered from the server's value, never inferred by the
        req.requestType === 'GDPR' ? statusChip('GDPR', 'REQUESTED BY GDPR') : null,
      ));
      panel.appendChild(el('p', { class: 'muted small' }, DELETION_STATUS_TEXT[req.status]));
      panel.appendChild(el('p', { class: 'muted small' },
        'Requested ' + new Date(req.requestedAt).toLocaleString()));

      if (req.status === 'DELETION_REQUESTED' || req.status === 'UNDER_REVIEW') {
        const cancel = el('button', { class: 'btn', type: 'button' }, 'Withdraw request');
        cancel.addEventListener('click', async () => {
          try {
            const res = await Api.cancelAccountDeletion();
            paint(res.request);
            toast('Request withdrawn.', 'ok');
          } catch (e) { toast(e.message || 'Could not withdraw', 'error'); }
        });
        panel.appendChild(el('div', { class: 'row-line' }, cancel));
      }
      return;
    }

    panel.appendChild(el('p', { class: 'muted small' },
      'Asks this instance to erase your account. It opens a request for an administrator to review.'));

    const what = el('div', { class: 'field' });
    what.appendChild(el('strong', {}, 'Erased'));
    what.appendChild(el('p', { class: 'muted small' },
      'Your username, email, display name, bio, avatar and banner, every file you uploaded, your sessions, friendships and notifications.'));
    panel.appendChild(what);

    const kept = el('div', { class: 'field' });
    kept.appendChild(el('strong', {}, 'Kept'));
    kept.appendChild(el('p', { class: 'muted small' },
      'Messages you posted, and any moderation or audit record that names you. These stay so other people’s conversations and any action taken against your account remain intact. They are attributed to a deleted account rather than to you.'));
    panel.appendChild(kept);

    const pw = el('input', { class: 'input', id: 'deletion-password', type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
    const open = el('button', { class: 'btn danger', type: 'button' }, 'Delete my account');
    open.setAttribute('aria-describedby', 'deletion-warning');
    open.addEventListener('click', () => {
      const password = pw.value;
      if (!password) {
        toast('Enter your password to confirm.', 'error');
        pw.focus();
        return;
      }
      confirmDialog({
        title: 'Request account deletion?',
        message: 'Your account will be anonymised and you will not be able to sign in. Messages you posted stay behind, attributed to a deleted account. This cannot be undone.',
        danger: true,
        confirmText: 'Request deletion',
        onConfirm: async () => {
          try {
            const res = await Api.requestAccountDeletion(password);
            pw.value = '';
            paint(res.request);
            toast('Request submitted. An administrator will review it.', 'ok');
          } catch (e) { toast(e.message || 'Could not submit', 'error'); }
        },
      });
    });
    panel.appendChild(el('div', { class: 'field' },
      el('label', { for: 'deletion-password' }, 'Password'),
      pw,
    ));
    panel.appendChild(el('div', { class: 'row-line' }, open));
    panel.appendChild(el('p', { class: 'muted small', id: 'deletion-warning' },
      'This is a data subject request. Your instance records it against your account and keeps an audit trail of the decision.'));
  };

  panel.appendChild(el('p', { class: 'muted small' }, 'Loading…'));
  Api.accountDeletion()
    .then((res) => paint(res.request))
    .catch(() => {
      clear(panel);
      panel.appendChild(el('p', { class: 'form-error' }, 'Could not load the deletion request status.'));
    });
}

export default { renderProfileEditor, renderExportSection, renderDeletionSection };
