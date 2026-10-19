// Choosing an instance, on the phone.
//
// The same journey as the desktop chooser and the same rules: an address typed
// by hand is checked against the instance itself before it is accepted, and
// the session held for the previous instance is forgotten so nothing signed in
// there travels along.

import { el } from '../../../packages/dom.js';
import Api, { forgetToken } from '../../../packages/api.js';
import TrycordConfig, { setApiUrl, backendUrl } from '../../../packages/config.js';
import { path, navigate } from '../../../packages/nav.js';
import { toast } from '../ui.js';

function field(label, control) {
  return el('label', { class: 'm-field' },
    el('span', { class: 'm-field__label' }, label),
    control);
}

export function renderInstances() {
  const list = el('div', { class: 'm-list' });
  const note = el('p', { class: 'm-field__note' }, '');
  const custom = el('input', {
    class: 'm-input', type: 'url', inputmode: 'url',
    placeholder: 'https://trycord.example.com',
    autocomplete: 'off', spellcheck: 'false',
  });
  const connect = el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'button' }, 'Connect');

  const node = el('div', { class: 'm-stack' },
    el('header', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Choose an instance'),
      el('p', { class: 'm-lede' }, 'Trycord instances are run independently. Pick one, or give the address of one you run yourself.')),
    el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'This one: ' + backendUrl()),
      el('a', { class: 'm-btn m-btn--ghost m-btn--block', href: path('/register') }, 'Register here')),
    el('div', { class: 'm-stack' },
      field('Address of another instance', custom),
      note,
      connect),
    el('div', { class: 'm-stack' },
      el('h2', { class: 'm-auth__title' }, 'Known instances'),
      list));

  async function choose(url) {
    const target = String(url || '').trim();
    if (!target) { note.textContent = 'Enter an address first.'; return; }
    connect.disabled = true;
    note.textContent = 'Checking that address…';
    const check = await TrycordConfig.testBackend(target, 10000);
    if (!check.ok) {
      note.textContent = check.error;
      connect.disabled = false;
      return;
    }
    const previous = backendUrl();
    setApiUrl(target);
    forgetToken(previous);
    toast('Now using ' + check.name);
    navigate('/register');
  }

  connect.addEventListener('click', () => choose(custom.value));

  async function load() {
    list.replaceChildren(el('p', { class: 'm-field__note' }, 'Reading the known instances…'));
    try {
      const out = await Api.discoverInstances();
      const items = (out && out.instances) || [];
      if (!items.length) {
        list.replaceChildren(el('p', { class: 'm-field__note' },
          'No instances are listed. Give an address above to reach one directly.'));
        return;
      }
      list.replaceChildren(...items.map((entry) => el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, entry.name || entry.url),
          el('span', { class: 'm-row__sub' }, entry.url)),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
            onClick: () => choose(entry.url),
          }, 'Use')))));
    } catch (e) {
      list.replaceChildren(el('p', { class: 'm-field__note' },
        (e && e.message) || 'The list could not be read.'));
    }
  }

  return { node, onMount: load, cleanup() {} };
}

export default { renderInstances };
