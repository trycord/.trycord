// Admin: the configuration console.
//
// The settings the instance runs on, drawn from the backend's own catalogue, so
// a setting that exists there is editable here without this file knowing its
// name. The mail delivery console is part of this surface: the three modes the
// mail registry registers, the active one marked, an honest status line, and a
// test send only when a transport could carry it.

import { el } from '../../packages/dom.js';
import Api from '../../packages/api.js';
import { switchControl } from '../ui/primitives.js';
import { head, card, fault, fold, hold } from '../ui/page.js';
import { errorToast, toast } from '../ui/overlays.js';
import { mailConsolePanel } from './adminMail.js';

// The value of one setting, edited by its own type. Booleans flip, enums pick,
// numbers stay numbers; everything else is text.
function settingField(setting, onSaved) {
  const kind = setting.type || 'string';
  if (kind === 'bool') {
    return switchControl(!!setting.value, async (on) => save({ [setting.key]: on }), setting.label);
  }
  if (kind === 'enum' || (setting.allowed && setting.allowed.length)) {
    const select = el('select', { class: 'input', 'aria-label': setting.label },
      ...(setting.allowed || []).map((option) => el('option', { value: option }, option)));
    select.value = String(setting.value == null ? '' : setting.value);
    return select;
  }
  const input = kind === 'number'
    ? el('input', {
      class: 'input', type: 'number', value: setting.value == null ? '' : String(setting.value),
      'aria-label': setting.label,
    })
    : el('input', {
      class: 'input', type: 'text', value: setting.value == null ? '' : String(setting.value),
      'aria-label': setting.label,
      placeholder: kind === 'secret' ? 'A secret, set on the server' : '',
    });
  input.dataset.settingKey = setting.key;
  return input;
}

async function save(patch) {
  try {
    await Api.updateInstanceSettings(patch);
    toast('Saved');
  } catch (e) {
    // A consequential value (continuum, security.lockout...) needs its
    // confirmation flag. The click that reached this function already was the
    // confirmation, so the retry carries it rather than staging a second save.
    if (e && (e.code === 'CONFIRMATION_REQUIRED' || String(e.message || '').includes('need confirmation'))) {
      try {
        await Api.updateInstanceSettings(Object.assign({}, patch, { __confirm: true }));
        toast('Saved');
        return;
      } catch (e2) { errorToast(e2); return; }
    }
    errorToast(e);
  }
}

function settingRow(setting) {
  const note = el('p', { class: 'settings-note' }, setting.description || '');
  const control = settingField(setting, null);
  return el('div', { class: 'settings-item' + (setting.pendingRestart ? ' settings-item--pending' : '') },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, setting.label,
        setting.source === 'environment' ? el('span', { class: 'chip chip--quiet' }, 'from the environment') : null,
        setting.pendingRestart ? el('span', { class: 'chip chip--warn' }, 'restart to apply') : null),
      note),
    el('div', { class: 'settings-item-control' }, control),
    (setting.type !== 'bool')
      ? el('div', { class: 'settings-item-actions' },
        el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          'aria-label': 'Save ' + setting.label,
          onClick: () => {
            const field = control.value !== undefined ? control : control.querySelector('input');
            if (field && field.dataset) void field;
            const value = field ? field.value : control.value;
            void value;
            const box = control;
            void box;
            const readFrom = control.tagName === 'SELECT' || control.tagName === 'INPUT'
              ? control
              : control.querySelector('[data-setting-key]') || control.querySelector('input');
            const fieldValue = readFrom
              ? (setting.type === 'number' ? (parseInt(readFrom.value, 10) || 0) : readFrom.value)
              : control.value;
            save({ [setting.key]: fieldValue });
          },
        }, 'Save'))
      : null);
}

function categorySection(category) {
  if (category.id === 'mail') {
    const consoleData = mailConsolePanel();
    // The panel fetches its providers and current mode itself; this view mounts
    // it directly, since it is painted in one step rather than mounted after.
    void consoleData.onMount();
    const rows = (category.settings || []).filter((s) => s.key !== 'mail.mode')
      .map((setting) => settingRow(setting));
    return el('div', { class: 'fold fold--tight' },
      consoleData.node,
      rows.length ? card({ label: 'From address and footers', glyph: 'mail', body: el('div', { class: 'fold' }, rows) }) : null);
  }
  const settings = (category.settings || []);
  if (!settings.length) {
    return el('div', { class: 'fold fold--tight' },
      card({ label: category.label, glyph: 'settings', body: el('p', { class: 'lede' },
        'Everything in this category decides itself from the environment.') }));
  }
  return card({
    label: category.label, glyph: 'settings',
    body: el('div', { class: 'fold' }, settings
      .filter((s) => !s.deploymentOnly)
      .map((setting) => settingRow(setting))),
    flush: false,
  });
}

export function adminConfiguration() {
  const nav = el('nav', { class: 'cfg-nav', 'aria-label': 'Setting categories' });
  const stage = el('div', { class: 'cfg-stage fold fold--tight' });
  let categories = [];
  let current = null;

  const pick = async (category) => {
    current = category;
    for (const button of nav.querySelectorAll('.cfg-nav__item')) {
      button.classList.toggle('active', button.dataset.category === category.id);
      button.setAttribute('aria-selected', button.dataset.category === category.id ? 'true' : 'false');
    }
    stage.replaceChildren(el('p', { class: 'holdline' }, 'Reading the category'));
    await Promise.resolve(); // let the hold paint before the section is built
    stage.replaceChildren(categorySection(category));
  };

  const paintNav = () => {
    nav.replaceChildren(...categories.map((category) => el('button', {
      class: 'cfg-nav__item' + (category === current ? ' active' : ''),
      type: 'button', 'data-category': category.id,
      'aria-selected': category === current ? 'true' : 'false',
      onClick: () => { pick(category); },
    }, category.label)));
  };

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Configuration',
        lede: 'Instance settings, changed here and applied as they are saved.',
      }),
      el('div', { class: 'cfg-layout' }, nav, stage),
    ]),
    onMount: async () => {
      try {
        const data = await Api.instanceSettings();
        categories = (data && data.categories) || [];
        current = null;
        paintNav();
        const first = categories[0];
        if (first) await pick(first);
        else stage.replaceChildren(fold([fault(new Error('The catalogue is empty.'), null)]));
      } catch (e) {
        stage.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}
