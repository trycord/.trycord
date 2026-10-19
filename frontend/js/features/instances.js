// Choosing an instance.
//
// A reader may want an instance other than the one this page was served from:
// a private one they run, a friend's, or a public one they found. This page
// lists the instances the current instance knows about, and it accepts an
// address typed by hand.
//
// What the page does not do is trust a listing. A directory says where an
// instance is; this page asks the instance itself before offering it, and it
// says plainly when an address could not be reached. Listing an instance is
// not the same as trusting it, and the page never says it is.
//
// Switching instances ends the session held for the old one. An account on one
// instance is not an account on another, and carrying a token across would be
// worse than useless.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api, { forgetToken } from '../../packages/api.js';
import TrycordConfig, { setApiUrl, resetBackend, backendUrl, backendSource } from '../../packages/config.js';
import { head, card, row, blank, fault, fold, hold } from '../ui/page.js';
import { errorToast, toast } from '../ui/overlays.js';
import { navigate, path } from '../../packages/nav.js';

const currentLabel = () => {
  const source = backendSource();
  if (source === 'stored') return 'the one you chose';
  if (source === 'static') return 'the one this build points at';
  if (source === 'origin') return 'the one that served this page';
  return 'the default';
};

function instanceCard(entry, onPick) {
  const registration = entry.registrationOpen === true
    ? 'Accepting new accounts'
    : (entry.registrationOpen === false ? 'Not accepting new accounts' : 'Registration unknown');
  return row({
    lead: el('span', { class: 'role-dot' }, icon('globe', { size: 15 })),
    title: entry.name || entry.url,
    sub: entry.url + ' · ' + registration,
    side: el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
      'aria-label': 'Use ' + (entry.name || entry.url),
      onClick: () => onPick(entry.url),
    }, 'Use'),
  });
}

export function renderInstances() {
  const list = el('div', { class: 'rowlist' });
  const problems = el('div', { class: 'fold fold--tight' });
  const custom = el('input', {
    class: 'input', type: 'url', inputmode: 'url',
    placeholder: 'https://trycord.example.com',
    'aria-label': 'The address of another Trycord instance',
    autocomplete: 'off', spellcheck: 'false',
  });
  const customNote = el('p', { class: 'form-note' }, '');
  const customButton = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Connect');

  const node = fold([
    head({
      kicker: 'Instances',
      title: 'Choose an instance',
      lede: 'Trycord instances are run independently. Pick one, or give the address of one you run yourself.',
    }),
    card({
      label: 'This one', glyph: 'globe',
      body: fold([
        el('p', { class: 'lede' }, backendUrl() + ' — ' + currentLabel() + '.'),
        el('div', { class: 'actionline' },
          el('a', { class: 'btn btn--default btn--sm', href: path('/register') }, 'Register here'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Forget the instance this browser was pointed at',
            onClick: () => {
              resetBackend();
              toast('Back to the default instance');
              navigate('/instances');
            },
          }, 'Use the default')),
      ]),
    }),
    card({
      label: 'Another instance', glyph: 'search',
      body: fold([
        el('p', { class: 'lede' }, 'Give the address of the instance you want to join.'),
        custom,
        customNote,
        el('div', { class: 'actionline' }, customButton),
      ]),
    }),
    card({ label: 'Known instances', glyph: 'globe', body: list, flush: true }),
    problems,
  ]);

  // Choosing an instance: the address is checked against the instance itself
  // before it is stored, and the session held for the previous instance is
  // forgotten so nothing signed in there travels with the reader.
  async function choose(url) {
    const target = String(url || '').trim();
    if (!target) {
      customNote.textContent = 'Enter an address first.';
      return;
    }
    customButton.disabled = true;
    customNote.textContent = 'Asking that address whether it is a Trycord instance…';
    const check = await TrycordConfig.inspectInstance(target, 10000);
    if (!check.ok) {
      customNote.textContent = check.error;
      customButton.disabled = false;
      return;
    }
    // An instance that refuses new accounts is still worth connecting to - the
    // reader may already have an account there - so this says so rather than
    // refusing the switch.
    const notes = [check.name];
    if (check.instanceId) notes.push('instance ' + check.instanceId);
    if (check.continuum) {
      notes.push(check.continuum.federates ? 'federates with other instances' : 'does not federate');
    }
    if (check.registration && check.registration.enabled === false) {
      notes.push('not accepting new accounts');
    }
    const previous = backendUrl();
    setApiUrl(target);
    forgetToken(previous);
    customNote.textContent = 'Connected to ' + notes.join(' · ') + '.';
    customButton.disabled = false;
    toast('Now using ' + check.name);
    navigate('/register');
  }

  customButton.addEventListener('click', () => choose(custom.value));
  custom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); choose(custom.value); }
  });

  async function load() {
    list.replaceChildren(hold('Reading the known instances'));
    try {
      const out = await Api.discoverInstances();
      const items = (out && out.instances) || [];
      if (!items.length) {
        list.replaceChildren(blank({
          glyph: 'globe',
          title: 'No instances listed',
          text: 'This instance does not publish a directory, and none is configured. Give an address above to reach one directly.',
        }));
      } else {
        list.replaceChildren(...items.map((entry) => instanceCard(entry, choose)));
      }
      const issues = (out && out.problems) || [];
      problems.replaceChildren(...(issues.length ? issues.map((issue) => el('p', { class: 'form-note' },
        'Could not read ' + issue.source + ': ' + issue.error)) : []));
    } catch (e) {
      list.replaceChildren(fold([fault(e, load)]));
    }
  }

  return { node, onMount: load, cleanup() {} };
}

export default { renderInstances };
