// Account profile + settings. Real user data from /api/users/me and the
// auth/session endpoints.

import Api from './api.js';
import State, { clearSession, refreshServers } from './state.js';
import { esc, el, clear, toast, confirmDialog } from './ui.js';
import { avatar, loadAuthedImage } from './components.js';
import { renderContextHeader, renderAllChrome } from './shell.js';
import { THEMES, getTheme, setTheme, loadPalette, savePalette, applyCustomPalette, CUSTOM_TOKEN_DEFS, DEFAULT_CUSTOM_TOKENS, loadCustomTheme, saveCustomTheme, serializeCustomTheme, parseCustomTheme, validateCustomCss, applyCustomTheme, recoverToEmber } from './theme.js';
import { renderBackendSelector } from './pages-public.js';
import Realtime from './realtime.js';

function accountTabs(active) {
  const tabs = el('div', { class: 'settings-nav' });
  const items = [
    { id: 'profile', label: 'My Account', href: '#/settings', match: ['profile'] },
    { id: 'security', label: 'Security', href: '#/settings/security', match: ['security', 'password', 'sessions'] },
    { id: 'appearance', label: 'Appearance', href: '#/settings/appearance', match: ['appearance'] },
    { id: 'backend', label: 'Backend', href: '#/settings/backend', match: ['backend'] },
    { id: 'updates', label: 'Updates', href: '#/settings/updates', match: ['updates'] },
  ];
  for (const t of items) {
    const on = t.id === active || (t.match || []).includes(active);
    const b = el('button', { class: 'btn ' + (on ? 'active' : 'ghost'), type: 'button' }, t.label);
    b.addEventListener('click', () => { location.hash = t.href; });
    tabs.appendChild(b);
  }
  const signOut = el('button', { class: 'btn danger ghost settings-signout', type: 'button' }, 'Sign out');
  signOut.addEventListener('click', () => {
    confirmDialog({
      title: 'Sign out?',
      message: 'You will need to sign in again on this device.',
      danger: true, confirmText: 'Sign out',
      onConfirm: async () => {
        try { await Api.logout(); } catch { /* server may be down; still sign out locally */ }
        try { Realtime.disconnect(); } catch { /* ignore */ }
        clearSession();
        location.hash = '#/login';
      },
    });
  });
  tabs.appendChild(signOut);
  return tabs;
}

function renderAppearance(wrap) {
  const active = getTheme();
  wrap.appendChild(el('div', { class: 'section-label' }, 'Theme'));
  const grid = el('div', { class: 'theme-grid' });
  for (const t of THEMES) {
    const b = el('button', {
      type: 'button',
      class: 'theme-chip' + (t.id === active ? ' active' : ''),
      'data-theme': t.id,
      'aria-pressed': t.id === active ? 'true' : 'false',
    });
    const sw = el('span', { class: 'theme-chip-swatch', 'data-theme': t.id });
    const name = el('strong', {}, t.label);
    const desc = el('span', { class: 'muted small' }, t.blurb);
    b.appendChild(sw);
    b.appendChild(el('span', { class: 'theme-chip-label' }, name, desc));
    b.addEventListener('click', () => {
      setTheme(t.id);
      for (const c of grid.querySelectorAll('.theme-chip')) {
        const on = c.getAttribute('data-theme') === t.id;
        c.classList.toggle('active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (t.id === 'custom') {
        customPanel.hidden = false;
        refreshCustom();
      } else {
        customPanel.hidden = true;
      }
      renderContextHeader({ title: 'Settings', sub: 'Your account and preferences' });
    });
    grid.appendChild(b);
  }
  wrap.appendChild(grid);
  wrap.appendChild(el('p', { class: 'muted small' }, 'Themes override design tokens. Switching applies immediately and persists for this device.'));

  const customPanel = el('div', { class: 'theme-custom', hidden: active !== 'custom' });
  const palette = loadPalette();
  const accentInput = el('input', { type: 'color', class: 'input', value: /^#[0-9a-f]{6}$/i.test(palette.accent) ? palette.accent : '#ff914d' });
  const toneDark = el('button', { type: 'button', class: 'btn ' + (palette.tone === 'light' ? 'ghost' : 'active') }, 'Dark base');
  const toneLight = el('button', { type: 'button', class: 'btn ' + (palette.tone === 'light' ? 'active' : 'ghost') }, 'Light base');
  const refreshCustom = () => {
    const p = loadPalette();
    accentInput.value = /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : '#ff914d';
    toneDark.classList.toggle('active', p.tone !== 'light');
    toneDark.classList.toggle('ghost', p.tone === 'light');
    toneLight.classList.toggle('active', p.tone === 'light');
    toneLight.classList.toggle('ghost', p.tone !== 'light');
  };
  accentInput.addEventListener('input', () => {
    savePalette({ accent: accentInput.value, tone: loadPalette().tone });
    if (getTheme() === 'custom') applyCustomPalette(loadPalette());
  });
  const chooseTone = (tone) => {
    savePalette({ accent: loadPalette().accent, tone });
    if (getTheme() === 'custom') applyCustomPalette(loadPalette());
    refreshCustom();
  };
  toneDark.addEventListener('click', () => chooseTone('dark'));
  toneLight.addEventListener('click', () => chooseTone('light'));
  customPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Accent color'), accentInput));
  customPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Base tone'), el('div', { class: 'row-line' }, toneDark, toneLight)));
  customPanel.appendChild(el('p', { class: 'muted small' }, 'Two inputs derive the full custom theme (surfaces, text, ambient). Semantic colors stay from the base palette.'));
  wrap.appendChild(customPanel);
  renderThemeStudio(wrap);
}

// Custom Theme Studio: safe guided tokens plus validated advanced CSS.
// Structure, navigation, and authorization UI are never editable here;
// unsafe CSS is rejected before apply, and failures recover to Ember.
function renderThemeStudio(wrap) {
  const studio = el('div', { class: 'theme-studio' });
  studio.appendChild(el('div', { class: 'section-label' }, 'Custom theme studio'));
  studio.appendChild(el('p', { class: 'muted small' },
    'Guided controls adjust the Custom theme safely. Advanced CSS allows deep visual restyling, but structural layout, navigation, and safety surfaces are protected and unsafe CSS is rejected.'));

  const state = loadCustomTheme();
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, state.tokens || {});

  const grid = el('div', { class: 'theme-studio__row' });
  for (const def of CUSTOM_TOKEN_DEFS) {
    const select = el('select', { class: 'input' });
    for (const opt of def.options) {
      const o = el('option', { value: opt }, opt);
      if (tokens[def.key] === opt) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      tokens[def.key] = select.value;
      const next = saveCustomTheme({ tokens, css: cssInput.value });
      if (getTheme() === 'custom') {
        const res = applyCustomTheme(next);
        paintErrors(res);
        if (res.ok) toast('Custom theme updated.', 'ok');
      }
    });
    grid.appendChild(el('div', { class: 'field' }, el('label', {}, def.label), select));
  }
  studio.appendChild(grid);

  const cssInput = el('textarea', {
    class: 'theme-studio__css',
    spellcheck: 'false',
    placeholder: '/* Advanced visual CSS. Structural layout, navigation, and safety surfaces are protected. */',
  }, state.css || '');
  studio.appendChild(el('div', { class: 'field' }, el('label', {}, 'Advanced CSS (visual properties only)'), cssInput));

  const errorsBox = el('div', { class: 'theme-studio__errors' });
  const paintErrors = (res) => {
    clear(errorsBox);
    const problems = [...(res.errors || []), ...(res.problems || [])];
    if (!problems.length && res.ok) {
      errorsBox.appendChild(el('div', { class: 'form-success' }, 'Custom theme is valid and active.'));
      return;
    }
    for (const p of problems.slice(0, 8)) errorsBox.appendChild(el('div', { class: 'form-error' }, p));
  };
  studio.appendChild(errorsBox);

  const actions = el('div', { class: 'row-line' });
  const validateBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Validate');
  validateBtn.addEventListener('click', () => {
    paintErrors(validateCustomCss(cssInput.value));
  });
  const applyBtn = el('button', { class: 'btn primary', type: 'button' }, 'Apply and save');
  applyBtn.addEventListener('click', () => {
    const next = saveCustomTheme({ tokens, css: cssInput.value });
    setTheme('custom');
    const res = applyCustomTheme(next);
    paintErrors(res);
    if (res.ok) toast('Custom theme applied.', 'ok');
    else toast('Custom theme rejected; Ember restored.', 'error');
  });
  const resetBtn = el('button', { class: 'btn danger', type: 'button' }, 'Reset to Ember');
  resetBtn.addEventListener('click', () => {
    recoverToEmber();
    toast('Ember theme restored.', 'ok');
  });
  const exportBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Export');
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([serializeCustomTheme({ tokens, css: cssInput.value })], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'trycord-custom-theme.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  const importBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Import');
  const fileInput = el('input', { type: 'file', accept: '.json,.css,.txt', hidden: true });
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        let next;
        try { next = parseCustomTheme(reader.result); }
        catch { next = { tokens, css: String(reader.result || '') }; }
        const check = validateCustomCss(next.css);
        if (!check.ok) { paintErrors(check); return; }
        saveCustomTheme(next);
        cssInput.value = next.css || '';
        setTheme('custom');
        const res = applyCustomTheme(next);
        paintErrors(res);
        if (res.ok) toast('Custom theme imported.', 'ok');
      } catch (ex) {
        paintErrors({ ok: false, errors: [ex.message || 'Import failed.'] });
      }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });
  actions.append(validateBtn, applyBtn, resetBtn, exportBtn, importBtn, fileInput);
  studio.appendChild(actions);
  wrap.appendChild(studio);
}

let updatesUnsub = null;

function renderProfileEditor(wrap) {
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

  // ---- live preview card (banner + avatar + name + bio + status) -------
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
    if (cur && cur.avatarUrl) {
      loadAuthedImage(cur.avatarUrl).then((url) => {
        if (!url) return;
        clear(avatarHolder);
        const a = el('span', { class: 'avatar lg has-img', style: { background: 'var(--t-sur2, #333)' } });
        a.appendChild(el('img', { class: 'avatar-img', src: url, alt: '' }));
        avatarHolder.appendChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      });
    } else {
      clear(avatarHolder);
      avatarHolder.appendChild(avatar(State.me, { size: 'lg', withPresence: false }));
    }
  };
  paintMedia();

  const preview = el('div', { class: 'prof-preview' }, bannerBox, avatarHolder,
    el('div', { class: 'prof-preview-body' }, previewName, previewSub, previewStatus, previewBio));
  profileCard.appendChild(preview);
  profileCard.appendChild(el('div', { class: 'hr' }));

  // ---- media pickers ----
  const avatarInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const bannerInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const avatarBtn = el('button', { class: 'btn', type: 'button' }, 'Change avatar');
  const avatarRm = el('button', { class: 'btn ghost', type: 'button', hidden: me ? !me.avatarUrl : true }, 'Remove avatar');
  const bannerBtn = el('button', { class: 'btn', type: 'button' }, 'Change banner');
  const bannerRm = el('button', { class: 'btn ghost', type: 'button', hidden: me ? !me.bannerUrl : true }, 'Remove banner');
  const mediaStatus = el('div', { class: 'muted small', 'aria-live': 'polite' });

  async function upload(kind, file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) { toast('Only images can be used.', 'error'); return; }
    mediaStatus.textContent = 'Uploading ' + kind + '…';
    try {
      const updated = await Api.uploadProfileImage(kind, file);
      State.me = { ...State.me, ...updated };
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
      const updated = await Api.removeProfileImage('avatar');
      State.me = { ...State.me, ...updated };
      avatarRm.hidden = true;
      paintMedia();
      toast('Avatar removed.', 'ok');
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });
  bannerRm.addEventListener('click', async () => {
    try {
      const updated = await Api.removeProfileImage('banner');
      State.me = { ...State.me, ...updated };
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

  // ---- email + verification status ----
  profileCard.appendChild(el('div', { class: 'section-label' }, 'Account email'));
  const emailBox = el('div', { class: 'field' });
  emailBox.appendChild(el('label', {}, 'Email'));
  const emailLine = el('div', { class: 'muted small' });
  const emailNote = el('div', { class: 'muted small', style: { marginTop: 'var(--t-d-2)' } });
  const emailActions = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-2)' } });

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

  if (me && me.email && !me.emailVerified) {
    const resend = el('button', { class: 'btn sm', type: 'button' }, 'Resend verification');
    resend.addEventListener('click', () => sendTo(me.email));
    emailActions.appendChild(resend);
  }

  const changePanel = el('div', { style: { marginTop: 'var(--t-d-3)' }, hidden: true });
  const newEmail = el('input', { class: 'input', type: 'email', placeholder: 'new@example.com', required: true });
  const curPass = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Current password', required: true });
  const sendBtn = el('button', { class: 'btn primary sm', type: 'submit' }, (me && me.email ? 'Change' : 'Add') + ' email');
  const changeForm = el('form', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--t-d-3)' } },
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

function renderUpdates(wrap) {
  const desk = (typeof window.trycordDesktop !== 'undefined') ? window.trycordDesktop : null;
  wrap.appendChild(el('div', { class: 'section-label' }, 'Application'));

  if (!desk) {
    const box = el('div', { class: 'auth-box' });
    box.appendChild(el('p', {}, 'You are running Trycord in a browser. The browser build does not auto-update.'));
    box.appendChild(el('p', { class: 'muted small' }, 'The desktop app checks for and installs updates automatically.'));
    wrap.appendChild(el('div', {},
      el('a', { class: 'btn primary', href: 'https://github.com/trycord/.trycord/releases', rel: 'noopener', target: '_blank' }, 'Download the desktop app')));
    return;
  }

  const status = el('p', { class: 'muted small', 'aria-live': 'polite' }, 'Checking update status…');
  const releaseLink = el('a', { class: 'btn', href: 'https://github.com/trycord/.trycord/releases', rel: 'noopener', target: '_blank' }, 'Open Releases page');
  const checkBtn = el('button', { class: 'btn primary', type: 'button' }, 'Check for updates');
  const installBtn = el('button', { class: 'btn danger', type: 'button', hidden: true }, 'Restart & update');
  let prefs = { autoInstall: true, channel: 'latest' };
  let downloadedVersion = null;

  const paint = () => {
    version.textContent = 'Trycord on ' + (desk.platform || 'desktop');
    latestBtn.classList.toggle('active', prefs.channel !== 'beta');
    latestBtn.classList.toggle('ghost', prefs.channel === 'beta');
    betaBtn.classList.toggle('active', prefs.channel === 'beta');
    betaBtn.classList.toggle('ghost', prefs.channel !== 'beta');
    autoToggle.checked = prefs.autoInstall !== false;
  };

  desk.updater.getPrefs().then((p) => { if (p) prefs = p; paint(); }).catch(() => { paint(); });

  const version = el('div', { class: 'row-line' });
  const latestBtn = el('button', { type: 'button', class: 'btn' }, 'Stable');
  latestBtn.addEventListener('click', () => {
    desk.updater.setPrefs({ channel: 'latest' }).then((p) => { prefs = p; paint(); status.textContent = 'Channel switched to Stable.'; }).catch(() => {});
  });
  const betaBtn = el('button', { type: 'button', class: 'btn' }, 'Beta (PTB)');
  betaBtn.addEventListener('click', () => {
    desk.updater.setPrefs({ channel: 'beta' }).then((p) => { prefs = p; paint(); status.textContent = 'Channel switched to Beta — you will see public test builds.'; }).catch(() => {});
  });
  const autoToggle = el('input', { type: 'checkbox', class: 'input' });
  autoToggle.addEventListener('change', () => {
    desk.updater.setPrefs({ autoInstall: autoToggle.checked }).then((p) => { prefs = p; paint(); }).catch(() => {});
  });

  const onEvent = (ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'checking') status.textContent = 'Checking for updates…';
    else if (ev.type === 'available') status.textContent = 'Update available — downloading…';
    else if (ev.type === 'progress') status.textContent = Math.round((ev.percent || 0)) + '% downloaded';
    else if (ev.type === 'downloaded') {
      downloadedVersion = ev.version;
      status.textContent = 'Ready to install.';
      installBtn.hidden = false;
    } else if (ev.type === 'not-available') status.textContent = 'You are up to date' + (ev.lastChecked ? ' (last checked ' + new Date(ev.lastChecked).toLocaleString() + ').' : '.');
    else if (ev.type === 'error') {
      status.textContent = 'Update check failed: ' + (ev.message || ev.kind || 'unknown') + '. You keep running the current version.';
      installBtn.hidden = true;
    }
  };
  if (updatesUnsub) { try { updatesUnsub(); } catch { /* ignore */ } updatesUnsub = null; }
  updatesUnsub = desk.updater.onEvent(onEvent);
  checkBtn.addEventListener('click', () => { status.textContent = 'Checking…'; desk.updater.check().catch(() => {}); });
  installBtn.addEventListener('click', () => { desk.updater.install().catch(() => {}); });

  wrap.appendChild(el('div', {}, version));
  wrap.appendChild(el('div', { class: 'field' }, el('label', {}, 'Update channel'), el('div', { class: 'row-line' }, latestBtn, betaBtn),
    el('span', { class: 'hint' }, 'Beta shows public test builds (PTB). Stable shows release builds.')));
  wrap.appendChild(el('div', { class: 'field' }, el('div', { class: 'row-line' }, autoToggle, el('label', {}, 'Install updates automatically when quitting'))));
  wrap.appendChild(el('div', { class: 'row-line' }, checkBtn, installBtn, releaseLink));
  wrap.appendChild(status);
}

function renderPasswordSection(wrap, container, tab) {
  wrap.appendChild(el('div', { class: 'section-label' }, 'Password'));
  wrap.appendChild(el('p', { class: 'muted small' }, 'Changing your password signs out every other session immediately. This device stays signed in.'));
  const err = el('div', { class: 'form-error', hidden: true });
  const cur = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Change password');
  const form = el('form', { class: 'auth-box' }, err,
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
      clear(container);
      renderAccount(container, { tab });
      toast('Password changed. Other sessions signed out.', 'ok');
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });
  wrap.appendChild(form);
}

function renderSessionsSection(wrap) {
  wrap.appendChild(el('div', { class: 'section-label' }, 'Sessions'));
  wrap.appendChild(el('p', { class: 'muted small' }, 'Every device you signed in on holds a session. Revoking one signs that device out.'));
  const revokeAll = el('button', { class: 'btn danger', type: 'button' }, 'Sign out all sessions');
  revokeAll.addEventListener('click', () => {
    confirmDialog({
      title: 'Sign out every device?',
      message: 'This signs out this device too. You will need to sign in again.',
      danger: true, confirmText: 'Sign out everywhere',
      onConfirm: async () => {
        try {
          await Api.revokeAllSessions();
        } finally {
          try { Realtime.disconnect(); } catch { /* ignore */ }
          clearSession();
          location.hash = '#/login';
        }
      },
    });
  });
  const revokeOthers = el('button', { class: 'btn', type: 'button' }, 'Sign out other sessions');
  revokeOthers.addEventListener('click', async () => {
    try {
      const res = await Api.revokeOthers();
      State.token = res.token;
      localStorage.setItem('trycord.token', res.token);
      toast('Other sessions signed out.', 'ok');
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });
  wrap.appendChild(el('div', { class: 'row-line' }, revokeOthers, revokeAll));
  wrap.appendChild(el('p', { class: 'muted small' }, 'Token-based sessions expire after 7 days or when revoked.'));
}

function renderDangerZone(wrap) {
  wrap.appendChild(el('div', { class: 'section-label danger' }, 'Danger zone'));
  const logoutBtn = el('button', { class: 'btn danger', type: 'button' }, 'Sign out');
  logoutBtn.addEventListener('click', async () => {
    try { await Api.logout(); } catch { /* server may be down; still sign out locally */ }
    // Shut the gateway down first: a lingering socket would keep
    // reconnecting (and reusing a dead token) after sign-out.
    try { Realtime.disconnect(); } catch { /* ignore */ }
    clearSession();
    location.hash = '#/login';
  });
  wrap.appendChild(el('p', { class: 'muted small' }, 'Sign out on this device. Use Security to sign out everywhere.'));
  wrap.appendChild(el('div', { class: 'row-line' }, logoutBtn));
}

export async function renderAccount(container, { tab = 'profile' } = {}) {
  clear(container);
  renderContextHeader({ title: 'Settings', sub: 'Your account and preferences' });
  const wrap = el('div', { class: 'page atrium settings-layout' });
  wrap.appendChild(accountTabs(tab));
  const body = el('div', { class: 'settings-body' });
  wrap.appendChild(body);

  if (tab === 'appearance') {
    renderAppearance(body);
  } else if (tab === 'updates') {
    renderUpdates(body);
  } else if (tab === 'security' || tab === 'password' || tab === 'sessions') {
    // Legacy password/sessions routes render the unified Security page.
    renderPasswordSection(body, container, 'security');
    renderSessionsSection(body);
  } else if (tab === 'backend') {
    body.appendChild(el('div', { class: 'section-label' }, 'Backend'));
    body.appendChild(el('p', { class: 'muted small' }, 'Choose which Trycord server this app talks to. Switching servers signs you out here first.'));
    const backendBox = el('div', { class: 'auth-box' });
    renderBackendSelector(backendBox);
    body.appendChild(backendBox);
  } else {
    // profile = My Account
    renderProfileEditor(body);
    renderDangerZone(body);
  }

  container.appendChild(wrap);
}

export default { renderAccount };