// Instance configuration: the system administrator's console.
//
// The catalogue comes from the backend, which owns which settings exist and where each
// value came from. This file draws them and nothing else - it does not decide what a
// setting means, so an administrator reading a description is reading the server's.
//
// A setting the deployment environment has set is shown locked, with the variable named.
// A setting that would lock people out needs confirmation. Neither is cosmetic.

import Api from '../api.js';
import { esc, el, clear, icon, toast, confirmDialog } from '../ui.js';
import { renderContextHeader } from '../shell.js';
import { emptyState } from '../components.js';
import { loadingState } from '../view-states.js';

const byKey = new Map();
let categories = [];
let deploymentOnly = [];
let dirty = new Map();

function settingControl(cat, s) {
  const value = dirty.has(s.key) ? dirty.get(s.key) : s.value;
  const row = el('div', { class: 'cfg-row' + (s.locked ? ' cfg-row--locked' : '') });

  const head = el('div', { class: 'cfg-row__head' });
  head.appendChild(el('div', { class: 'cfg-row__title' }, s.label));
  if (s.env) {
    head.appendChild(el('code', { class: 'cfg-row__env' }, s.env));
  }
  row.appendChild(head);
  row.appendChild(el('p', { class: 'cfg-row__desc' }, s.description));

  const control = el('div', { class: 'cfg-row__control' });

  if (s.type === 'boolean') {
    const toggle = el('button', {
      class: 'switch' + (value ? ' on' : ''),
      type: 'button',
      role: 'switch',
      'aria-checked': value ? 'true' : 'false',
      'aria-label': s.label,
      disabled: !!s.locked,
      onClick: () => { dirty.set(s.key, !value); repaint(); },
    }, el('span', { class: 'switch__dot' }));
    control.appendChild(toggle);
    control.appendChild(el('span', { class: 'cfg-row__state' },
      value ? 'Enabled' : 'Disabled'));
  } else if (s.type === 'integer' || s.type === 'string' || s.type === 'url') {
    const input = el('input', {
      class: 'input', type: s.type === 'integer' ? 'number' : 'text',
      value: value == null ? '' : String(value),
      'aria-label': s.label,
      disabled: !!s.locked,
      onInput: (e) => { dirty.set(s.key, e.target.value); },
    });
    control.appendChild(input);
  } else if (s.type === 'list') {
    const input = el('input', {
      class: 'input', type: 'text',
      value: Array.isArray(value) ? value.join(', ') : String(value || ''),
      placeholder: 'Comma-separated',
      'aria-label': s.label,
      disabled: !!s.locked,
      onInput: (e) => { dirty.set(s.key, e.target.value); },
    });
    control.appendChild(input);
  }

  // Where the value comes from, and whether a change takes effect now or needs a restart.
  const meta = el('div', { class: 'cfg-row__meta' });
  if (s.locked) {
    meta.appendChild(el('span', { class: 'cfg-flag cfg-flag--locked' }, s.lockedReason || 'Set by the deployment'));
  } else {
    meta.appendChild(el('span', { class: 'cfg-flag cfg-flag--' + s.source },
      s.source === 'instance' ? 'Saved on this instance' : 'Default'));
  }
  if (!s.live) {
    meta.appendChild(el('span', { class: 'cfg-flag cfg-flag--restart' }, 'Needs a restart'));
  }
  if (s.consequential) {
    meta.appendChild(el('span', { class: 'cfg-flag cfg-flag--warn' }, 'Consequential'));
  }
  control.appendChild(meta);
  row.appendChild(control);
  return row;
}

let activeCategory = null;

function repaint() {
  const region = document.getElementById('view-root');
  if (!region) return;
  clear(region);
  renderContextHeader({
    title: 'Instance configuration',
    sub: 'System-wide settings for this instance',
    icon: icon('settings'),
  });

  if (!categories.length) {
    region.appendChild(emptyState('settings', 'Configuration unavailable',
      'The instance configuration could not be read.'));
    return;
  }

  const cat = categories.find((c) => c.id === activeCategory) || categories[0];
  activeCategory = cat.id;

  // Categorised navigation, derived from the catalogue rather than restated here.
  const nav = el('div', { class: 'cfg-nav', role: 'tablist', 'aria-label': 'Configuration categories' });
  for (const c of categories) {
    nav.appendChild(el('button', {
      class: 'cfg-nav__item' + (c.id === cat.id ? ' active' : ''),
      type: 'button', role: 'tab',
      'aria-selected': c.id === cat.id ? 'true' : 'false',
      onClick: () => { activeCategory = c.id; repaint(); },
    }, c.label));
  }
  region.appendChild(nav);

  const card = el('div', { class: 'card cfg-card' });
  card.appendChild(el('div', { class: 'cfg-card__head' }, [
    el('h2', { class: 'cfg-card__title' }, cat.label),
    dirty.size ? el('span', { class: 'cfg-flag cfg-flag--warn' },
      dirty.size + ' unsaved change' + (dirty.size === 1 ? '' : 's')) : null,
  ]));

  for (const s of cat.settings) card.appendChild(settingControl(cat, s));
  region.appendChild(card);

  // Settings the application cannot change, named with the reason rather than hidden.
  if (deploymentOnly.length) {
    const box = el('div', { class: 'card cfg-card' });
    box.appendChild(el('h2', { class: 'cfg-card__title' }, 'Set by the deployment'));
    box.appendChild(el('p', { class: 'cfg-row__desc' },
      'These are not dashboard settings. Change them in the instance configuration file or the container.'));
    for (const d of deploymentOnly) {
      const row = el('div', { class: 'cfg-row cfg-row--locked' });
      row.appendChild(el('code', { class: 'cfg-row__env' }, d.key));
      row.appendChild(el('p', { class: 'cfg-row__desc' }, d.reason));
      box.appendChild(row);
    }
    region.appendChild(box);
  }

  const actions = el('div', { class: 'cfg-actions' });
  actions.appendChild(el('button', {
    class: 'btn primary', type: 'button',
    disabled: !dirty.size,
    onClick: save,
  }, dirty.size ? 'Save changes' : 'Saved'));
  actions.appendChild(el('button', {
    class: 'btn ghost', type: 'button',
    disabled: !dirty.size,
    onClick: () => { dirty.clear(); repaint(); },
  }, 'Discard'));
  region.appendChild(actions);
}

async function save() {
  const keys = [...dirty.keys()];
  const consequential = [];
  for (const key of keys) {
    const s = categories.flatMap((c) => c.settings).find((x) => x.key === key);
    if (s && s.consequential) consequential.push(s.label);
  }

  const write = async (confirm) => {
    const body = {};
    for (const [k, v] of dirty) body[k] = v;
    if (confirm) body.__confirm = true;
    try {
      await Api.updateInstanceSettings(body);
      dirty.clear();
      await load();
      toast('Configuration saved.', 'ok');
      repaint();
    } catch (e) {
      toast(e.message || 'Could not save the configuration.', 'error');
    }
  };

  if (consequential.length) {
    confirmDialog({
      title: 'Apply these changes?',
      message: consequential.join(', ')
        + (consequential.length === 1 ? ' affects' : ' affect')
        + ' who can use this instance. Apply anyway?',
      danger: true, confirmText: 'Apply',
      onConfirm: () => write(true),
    });
    return;
  }
  write(false);
}

async function load() {
  const res = await Api.instanceSettings();
  categories = res.categories || [];
  deploymentOnly = res.deploymentOnly || [];
  dirty.clear();
  byKey.clear();
  for (const c of categories) for (const s of c.settings) byKey.set(s.key, s);
}

export async function renderInstanceSettings(container) {
  clear(container);
  container.appendChild(loadingState('Loading configuration'));
  try {
    await load();
  } catch (e) {
    clear(container);
    container.appendChild(emptyState('warn', 'Configuration unavailable',
      e.message || 'The instance configuration could not be read.'));
    return;
  }
  repaint();
}

export default { renderInstanceSettings };
