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

export async function renderAccount(container, { tab = 'profile' } = {}) {
  clear(container);
  renderContextHeader({ title: 'Account', sub: 'Your identity across Trycord' });
  const wrap = el('div', { class: 'page atrium' });
  wrap.appendChild(accountTabs(tab));

  const me = State.me;
  if (tab === 'appearance') {
    renderAppearance(wrap);
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