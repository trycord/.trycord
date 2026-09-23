// Account profile + settings. Real user data from /api/users/me and the
// auth/session endpoints.

import Api from './api.js';
import State, { clearSession, refreshServers } from './state.js';
import { esc, el, clear, toast, confirmDialog } from './ui.js';
import { avatar } from './components.js';
import { renderContextHeader } from './shell.js';
import { THEMES, getTheme, setTheme, loadPalette, savePalette, applyCustomPalette } from './theme.js';

function accountTabs(active) {
  const tabs = el('div', { class: 'settings-nav' });
  const items = [
    { id: 'profile', label: 'Profile', href: '#/account' },
    { id: 'password', label: 'Password', href: '#/account/password' },
    { id: 'sessions', label: 'Sessions', href: '#/account/sessions' },
    { id: 'appearance', label: 'Appearance', href: '#/account/appearance' },
    { id: 'updates', label: 'Updates', href: '#/account/updates' },
  ];
  for (const t of items) {
    const b = el('button', { class: 'btn ' + (active === t.id ? 'active' : 'ghost'), type: 'button' }, t.label);
    b.addEventListener('click', () => { location.hash = t.href; });
    tabs.appendChild(b);
  }
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
      renderContextHeader({ title: 'Account', sub: 'Your identity across Trycord' });
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
}

let updatesUnsub = null;

function renderUpdates(wrap) {
  const desk = (typeof window.trycordDesktop !== 'undefined') ? window.trycordDesktop : null;
  wrap.appendChild(el('div', { class: 'section-label' }, 'Application'));

  if (!desk) {
    const box = el('div', { class: 'auth-box' });
    box.appendChild(el('p', {}, 'You are running Trycord in a browser. The browser build does not auto-update.'));
    box.appendChild(el('p', { class: 'muted small' }, 'The desktop app checks for and installs updates automatically.'));
    wrap.appendChild(el('div', {},
      el('a', { class: 'btn primary', href: 'https://github.com/LanxTheShowmaker/.trycord/releases', rel: 'noopener', target: '_blank' }, 'Download the desktop app')));
    return;
  }

  const status = el('p', { class: 'muted small', 'aria-live': 'polite' }, 'Checking update status…');
  const releaseLink = el('a', { class: 'btn', href: 'https://github.com/LanxTheShowmaker/.trycord/releases', rel: 'noopener', target: '_blank' }, 'Open Releases page');
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

export async function renderAccount(container, { tab = 'profile' } = {}) {
  clear(container);
  renderContextHeader({ title: 'Account', sub: 'Your identity across Trycord' });
  const wrap = el('div', { class: 'page atrium' });
  wrap.appendChild(accountTabs(tab));

  const me = State.me;
  if (tab === 'appearance') {
    renderAppearance(wrap);
  } else if (tab === 'updates') {
    renderUpdates(wrap);
  } else if (tab === 'password') {
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
  } else if (tab === 'sessions') {
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
    wrap.appendChild(el('div', { class: 'section-label' }, 'Session control'));
    wrap.appendChild(el('div', { class: 'row-line' }, revokeOthers, revokeAll));
    wrap.appendChild(el('p', { class: 'muted small' }, 'Token-based sessions expire after 7 days or when revoked.'));
  } else {
    // profile
    const err = el('div', { class: 'form-error', hidden: true });
    const ok = el('div', { class: 'form-success', hidden: true });
    const display = el('input', {
      class: 'input', type: 'text', value: me ? (me.displayName || '') : '', maxlength: 32,
    });
    const saveBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Save profile');

    const profileCard = el('div', { class: 'auth-box' });
    const top = el('div', { class: 'row-line' });
    if (me) top.appendChild(avatar(me, { size: 'lg', withPresence: false }));
    top.appendChild(el('div', {},
      el('strong', {}, me ? (me.displayName || me.username) : ''),
      el('div', { class: 'muted small' }, me ? '@' + me.username : '')));
    profileCard.appendChild(top);
    profileCard.appendChild(el('div', { class: 'hr' }));

    const form = el('form', {}, err, ok,
      el('div', { class: 'field' }, el('label', {}, 'Display name'), display,
        el('span', { class: 'hint' }, 'Shown across communities and DMs.')),
      el('div', {}, saveBtn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      ok.hidden = true;
      try {
        const updated = await Api.updateMe({ displayName: display.value.trim() || me.username });
        State.me = { ...me, ...updated };
        ok.hidden = false;
        toast('Profile saved.', 'ok');
      } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
    });
    profileCard.appendChild(form);

    const emailBox = el('div', { class: 'field' });
    emailBox.appendChild(el('label', {}, 'Email'));
    if (me && me.email) {
      emailBox.appendChild(el('div', { class: 'muted small' },
        esc(me.email) + (me.emailVerified ? ' · verified' : ' · unverified')));
    } else {
      emailBox.appendChild(el('div', { class: 'muted small' }, 'No email on file.'));
    }
    profileCard.appendChild(emailBox);

    wrap.appendChild(profileCard);

    const logoutBtn = el('button', { class: 'btn danger', type: 'button' }, 'Sign out');
    logoutBtn.addEventListener('click', async () => {
      try { await Api.logout(); } catch { /* server may be down; still sign out locally */ }
      clearSession();
      location.hash = '#/login';
    });
    wrap.appendChild(el('div', { class: 'section-label' }, 'Session'));
    wrap.appendChild(el('div', { class: 'row-line' }, logoutBtn));
  }

  container.appendChild(wrap);
}

export default { renderAccount };