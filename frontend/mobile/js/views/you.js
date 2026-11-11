// You: the reader's own door.
//
// The face they show, the presence they keep, how the app looks, what this
// device can open, and the way out. Every row either acts or says so.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import {
  State, nameOf, signOut, refreshDms,
} from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { avatar } from '../../../js/ui/primitives.js';
import { applyTheme } from '../../../packages/theme.js';
import { checkImage, previewOf, uploadProfilePicture, removeProfilePicture } from '../../../packages/profileMedia.js';
import * as encrypted from '../../../js/ui/encrypted.js';
import { sheet, closeSheet, confirm, failed, toast, emptyState, failure, field, section } from '../ui.js';

export function renderYou(ctx) {
  const host = el('div', { class: 'm-stack' });

  function meHead() {
    const me = State.user || {};
    const head = el('button', { class: 'm-me', type: 'button', onClick: () => navigate(path('/users/' + me.id)) },
      avatar(me, { size: 'xl' }),
      el('div', { class: 'm-me__titles' },
        el('div', { class: 'm-me__name' }, nameOf(me) || 'You'),
        el('div', { class: 'm-me__handle' }, '@' + (me.username || '')),
        me.statusText || me.status_text ? el('div', { class: 'm-me__status' }, me.statusText || me.status_text) : null),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 20 })));
    return head;
  }

  function row(label, glyph, onClick, opts) {
    const options = opts || {};
    return el('button', { class: 'm-row' + (options.danger ? ' m-row--danger' : ''), type: 'button', onClick: onClick },
      el('span', { class: 'm-row__chevron' }, icon(glyph, { size: 18 })),
      el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, label)),
      options.note ? el('span', { class: 'm-row__note' }, options.note) : null,
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 16 })));
  }

  function paint() {
    clear(host);
    host.appendChild(meHead());

    host.appendChild(section('Yourself',
      row('Profile', 'users', () => navigate(path('/users/' + (State.user || {}).id))),
      row('Presence', 'circle-dot', presenceSheet, { note: (State.user || {}).presence || 'online' }),
      row('Your picture', 'camera-off', pictureSheet)));

    host.appendChild(section('This app',
      row('Dark or light', 'eye-off', themeSheet, { note: document.documentElement.dataset.theme || 'dark' }),
      row('Encryption on this device', 'shield', encryptionSheet)));

    host.appendChild(section('Elsewhere',
      row('Support', 'info', () => navigate(path('/support'))),
      row('The papers', 'external', () => navigate(path('/legal/terms')))));

    host.appendChild(section('The way out',
      row('Sign out', 'log-out', async () => {
        if (!(await confirm({ title: 'Sign out?', text: 'The keys for this device stay until you remove them.', confirmLabel: 'Sign out', danger: true }))) return;
        try { await signOut({}); navigate(path('/login'), { replace: true }); }
        catch (e) { failed(e); }
      }, { danger: true })));
  }

  function presenceSheet() {
    const layer = sheet({ title: 'How you appear' });
    for (const option of [
      ['online', 'Here and about'],
      ['idle', 'Around, but away'],
      ['dnd', 'Do not disturb'],
      ['invisible', 'Hidden (you see yourself as offline to others)'],
    ]) {
      layer.body.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: async () => {
          try {
            await Api.setPresence(option[0]);
            if (State.user) State.user.presence = option[0];
            layer.close(); paint(); toast('Now ' + option[0], { type: 'success' });
          } catch (e) { failed(e); }
        },
      }, el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, option[1])),
        (State.user || {}).presence === option[0] ? icon('check', { size: 18 }) : null));
    }
  }

  function pictureSheet() {
    const layer = sheet({ title: 'Your picture', note: 'A face the rooms know. The banner is the desk\u2019s to set.' });
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'New picture' });
    const preview = el('img', { alt: '', style: { width: '72px', height: '72px', borderRadius: 'var(--tc-radius-pill)', objectFit: 'cover' } });
    preview.src = (State.user || {}).avatarUrl || (State.user || {}).avatar_url || '';
    preview.hidden = !preview.src;

    input.addEventListener('change', async () => {
      const file = (input.files || [])[0];
      if (!file) return;
      try {
        checkImage(file, 8 * 1024 * 1024);
        preview.src = await previewOf(file);
        await uploadProfilePicture('avatar', file);
        await Api.me().then(async (me) => { State.user = me; });
        layer.close(); paint(); toast('The new face is on', { type: 'success' });
      } catch (e) { failed(e); }
    });

    layer.body.append(
      el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, preview,
        el('div', { class: 'm-stack' },
          el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => input.click() }, 'Choose a picture'),
          el('button', { class: 'm-go m-go--danger', type: 'button', onClick: async () => {
            try { await removeProfilePicture('avatar'); State.user = await Api.me(); layer.close(); paint(); }
            catch (e) { failed(e); }
          } }, 'Take it off'))),
      input);
  }

  function themeSheet() {
    const layer = sheet({ title: 'Dark or light' });
    for (const theme of ['dark', 'light']) {
      layer.body.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => {
          document.documentElement.dataset.theme = theme;
          try { localStorage.setItem('trycord:theme', theme); } catch { /* private modes keep the default */ }
          applyTheme();
          layer.close(); paint();
        },
      }, el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, theme === 'dark' ? 'Dark, like the charcoal' : 'Light, like paper')),
        (document.documentElement.dataset.theme || 'dark') === theme ? icon('check', { size: 18 }) : null));
    }
  }

  async function encryptionSheet() {
    const layer = sheet({ title: 'Encryption on this device' });
    layer.body.appendChild(el('p', { class: 'm-sheet__note' }, 'Reading the state of this device\u2019s keys\u2026'));
    try {
      await encrypted.ready();
      clear(layer.body);
      layer.body.appendChild(emptyState('shield-check', 'Keys are ready',
        'This device holds keys for ' + ((State.dms || []).length) + ' conversation' + ((State.dms || []).length === 1 ? '' : 's') + '. Words are sealed before they leave.'));
    } catch (e) {
      clear(layer.body);
      layer.body.appendChild(emptyState('shield-alert', 'Keys are not ready',
        (e && e.message) || 'This device could not open the encrypted rooms. Sending still works; sealed rooms will not open.'));
    }
  }

  paint();

  return {
    node: host,
    head: { back: false, title: 'You' },
    door: '/you',
    onMount: paint,
  };
}
