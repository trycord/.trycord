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
function settingField(setting, save) {
  const kind = setting.type || 'string';
  // The catalogue's own names for these kinds; the server sends boolean,
  // integer, url, list, string, secret.
  if (kind === 'boolean') {
    return switchControl(!!setting.value, async (on) => save({ [setting.key]: on }), setting.label);
  }
  if (kind === 'enum' || (setting.allowed && setting.allowed.length)) {
    const select = el('select', { class: 'input', 'aria-label': setting.label },
      ...(setting.allowed || []).map((option) => el('option', { value: option }, option)));
    select.value = String(setting.value == null ? '' : setting.value);
    return select;
  }
  const input = kind === 'integer'
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

// The value the control holds, read the way its kind is written.
function controlValue(control, setting) {
  const field = control.tagName === 'SELECT' || control.tagName === 'INPUT'
    ? control
    : control.querySelector('[data-setting-key]') || control.querySelector('input');
  if (!field) return '';
  if (setting.type === 'integer') {
    const parsed = parseInt(field.value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return field.value;
}

async function save(patch, onDone) {
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
        if (onDone) onDone();
        return;
      } catch (e2) { errorToast(e2); return; }
    }
    errorToast(e);
    return;
  }
  if (onDone) onDone();
}

// A setting another interface owns.
//
// The value is shown, because a reader of this page wants to know what is in
// force. It is not editable, because another page is where it is changed, and
// two editors for one value is how a setting ends up saying one thing and
// behaving like another. The link says where.
function ownedRow(setting) {
  return el('div', { class: 'settings-item settings-item--owned' },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, setting.label,
        el('span', { class: 'chip chip--quiet' },
          'changed in ' + (setting.canonicalLabel || 'another page'))),
      el('p', { class: 'settings-note' }, setting.description || ''),
      el('p', { class: 'settings-note' },
        'The value in force: ' + (setting.value === null || setting.value === undefined || setting.value === ''
          ? 'not set'
          : String(setting.value)))),
    el('div', { class: 'settings-item-actions' },
      el('a', {
        class: 'btn btn--default btn--sm',
        href: setting.canonicalRoute || '#',
      }, 'Open ' + (setting.canonicalLabel || 'the page that changes it'))));
}

function settingRow(setting, onDone) {
  if (setting.canonical) return ownedRow(setting);
  const note = el('p', { class: 'settings-note' }, setting.description || '');
  // With the environment in authority, a row whose save writes the deployment's
  // variable says so where the value is typed - the operator reads where a
  // change lands without opening a page about it.
  const destination = setting.writesOnSave === 'deployment environment' && setting.env
    ? el('p', { class: 'settings-note' },
      'Saving writes ' + setting.env + ' into the deployment environment.')
    : null;
  const control = settingField(setting, (patch) => save(patch, onDone));
  return el('div', { class: 'settings-item' + (setting.pendingRestart ? ' settings-item--pending' : '') },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, setting.label,
        setting.source === 'environment' ? el('span', { class: 'chip chip--quiet' }, 'from the environment') : null,
        setting.pendingRestart ? el('span', { class: 'chip chip--warn' }, 'restart to apply') : null),
      note,
      destination),
    el('div', { class: 'settings-item-control' }, control),
    (setting.type !== 'boolean')
      ? el('div', { class: 'settings-item-actions' },
        el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          'aria-label': 'Save ' + setting.label,
          onClick: () => save({ [setting.key]: controlValue(control, setting) }, onDone),
        }, 'Save'),
        // A value the operator has changed can be put back to whatever the
        // deployment and the schema say: reset removes the stored row, and with
        // the environment in authority it removes the setting's variable too.
        // Either state is resettable once this page can see a value in force -
        // a saved one, or the one the deployment is keeping - which is what the
        // destination and the source say.
        (setting.source === 'instance' || setting.writesOnSave === 'deployment environment')
          ? el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Reset ' + setting.label + ' to its default',
            onClick: async () => {
              try {
                await Api.resetInstanceSetting(setting.key);
                toast(setting.label + ' is back to its default');
                if (onDone) onDone();
              } catch (e) { errorToast(e); }
            },
          }, 'Reset')
          : null)
      : null);
}

function categorySection(category, onDone) {
  if (category.id === 'mail') {
    const consoleData = mailConsolePanel();
    // The panel fetches its providers and current mode itself; this view mounts
    // it directly, since it is painted in one step rather than mounted after.
    void consoleData.onMount();
    const rows = (category.settings || []).filter((s) => s.key !== 'mail.mode')
      .map((setting) => settingRow(setting, onDone));
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
      .map((setting) => settingRow(setting, onDone))),
    flush: false,
  });
}

export function adminConfiguration() {
  const nav = el('nav', { class: 'cfg-nav', 'aria-label': 'Setting categories' });
  const stage = el('div', { class: 'cfg-stage fold fold--tight' });
  let categories = [];
  let current = null;
  // The deployment's own switch, as the catalogue reported it. Read from the
  // environment and nowhere else; this page never turns it on or off, because a
  // control inside the store cannot decide the authority of the store.
  const layout = el('div', { class: 'cfg-layout' }, nav, stage);
  const root = fold([
    head({
      kicker: 'Instance',
      title: 'Configuration',
      lede: 'Instance settings, changed here and applied as they are saved.',
    }),
    layout,
  ]);
  let bannerShown = false;

  // A save in this mode writes the setting's own environment variable - into
  // the running process at once and into the instance's .env file, so the
  // change is live and survives a restart. The one exception is stated where
  // the operator would otherwise extend the promise: a secret is stored
  // encrypted, never as plaintext in a file.
  const showBanner = (info) => {
    if (bannerShown || !info || !info.enabled) return;
    bannerShown = true;
    root.insertBefore(card({
      label: 'The environment has authority', glyph: 'key',
      body: fold([
        el('p', { class: 'lede' },
          info.switch + ' is set. Every setting that has an environment variable of its own takes its value from the deployment, and a save here writes that variable - into the running process at once and into the instance\'s .env file, so the change survives a restart.'),
        el('p', { class: 'lede' },
          'Credentials are the standing exception: a secret saved on this page is stored encrypted, and a secret the deployment set keeps being the deployment\'s to rotate.'),
      ]),
    }), layout);
  };

  const paint = () => {
    if (!current) return;
    stage.replaceChildren(categorySection(current, refresh));
  };

  const pick = async (category) => {
    current = category;
    for (const button of nav.querySelectorAll('.cfg-nav__item')) {
      button.classList.toggle('active', button.dataset.category === category.id);
      button.setAttribute('aria-selected', button.dataset.category === category.id ? 'true' : 'false');
    }
    stage.replaceChildren(el('p', { class: 'holdline' }, 'Reading the category'));
    await Promise.resolve(); // let the hold paint before the section is built
    paint();
  };

  // After a value is saved the catalogue is read again, so the field shows the
  // value that is actually in force rather than the one that was typed.
  const refresh = async () => {
    try {
      const data = await Api.instanceSettings();
      categories = (data && data.categories) || [];
      showBanner(data && data.envAuthority);
      const still = current ? categories.find((entry) => entry.id === current.id) : null;
      if (still) {
        current = still;
        paint();
      }
    } catch (e) {
      errorToast(e);
    }
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
    node: root,
    onMount: async () => {
      try {
        const data = await Api.instanceSettings();
        categories = (data && data.categories) || [];
        showBanner(data && data.envAuthority);
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
