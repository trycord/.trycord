// The extension policy.
//
// Five settings decide what may be installed on this instance at all: where
// packages come from, which of them are welcome, whether an unreviewed package
// may be installed, whether a package has to carry a good signature, and
// whether a package may bring its own code and run it here.
//
// Four of them narrow what may be installed. The fifth does not: it opens the
// server to code that was not written by this instance. It is therefore asked
// for explicitly, it says what it means before it is switched on, and it is
// marked as the thing it is.

import { el } from '../../../packages/dom.js';
import { card, fault, fold, hold, memo } from '../../ui/page.js';
import { switchControl, setSwitch } from '../../ui/primitives.js';
import { confirmDialog, errorToast, toast } from '../../ui/overlays.js';
import { readPolicy, writePolicy } from './api.js';

const MODES = [
  { id: 'disabled', label: 'No registry' },
  { id: 'builtin', label: 'The first-party directory' },
  { id: 'mirror', label: 'A registry of my own' },
];

const MODE_NOTES = {
  disabled: 'This instance offers no extensions to install. The ones already installed stay as they are.',
  builtin: 'Packages come from the directory that ships with this instance.',
  mirror: 'Packages come from the address below. It may be an HTTP(S) address or a directory on this machine.',
};

// What turning on trusted code actually does. It is said here, before the
// switch is touched, and again in the confirmation.
const TRUSTED_WARNING = 'A trusted package brings its own code and runs it inside this instance\'s server '
  + 'process, where it can read what the instance can read and write what the instance can write. '
  + 'It is not a permission that can be taken back: the code is already running. '
  + 'Only allow packages you would trust with the server itself.';

export function policySection() {
  const body = el('div', { class: 'fold' });
  let policy = null;

  // Every save goes through here, so the console always shows the policy the
  // server has rather than the one that was asked for.
  async function write(patch) {
    const answer = await writePolicy(patch);
    policy = (answer && answer.policy) || Object.assign({}, policy, patch);
    return policy;
  }

  // -- where packages come from ------------------------------------------------

  function sourceCard() {
    const mode = el('select', { class: 'input', 'aria-label': 'Where packages come from' },
      ...MODES.map((entry) => el('option', { value: entry.id }, entry.label)));
    mode.value = String(policy.registryMode || 'builtin');
    const note = el('p', { class: 'form-note' }, MODE_NOTES[policy.registryMode] || '');
    mode.addEventListener('change', async () => {
      const wanted = mode.value;
      const before = policy.registryMode;
      note.textContent = MODE_NOTES[wanted] || '';
      try {
        await write({ registryMode: wanted });
        toast('Saved');
      } catch (error) {
        mode.value = String(before || 'builtin');
        note.textContent = MODE_NOTES[before] || '';
        errorToast(error);
      }
    });

    const url = el('input', {
      class: 'input', type: 'text',
      value: policy.registryUrl || '',
      'aria-label': 'The address of the registry',
      placeholder: 'https://example.org/registry.json, or a directory',
    });
    const saveUrl = el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      'aria-label': 'Save the registry address',
      onClick: async () => {
        try {
          await write({ registryUrl: url.value.trim() || null });
          toast('Saved');
        } catch (error) { errorToast(error); }
      },
    }, 'Save');

    return card({
      label: 'Where packages come from',
      glyph: 'globe',
      body: el('div', { class: 'form-stack' },
        mode,
        note,
        el('p', { class: 'form-note' }, 'The address of your own registry. It is only read in mirror mode.'),
        url,
        el('div', { class: 'formfoot' }, saveUrl)),
    });
  }

  // -- which packages are welcome ----------------------------------------------

  function allowlistCard() {
    const list = el('textarea', {
      class: 'textarea', rows: '5',
      'aria-label': 'The packages on the allowlist, one per line',
      placeholder: 'example.extension',
    });
    list.value = (policy.allowlist || []).join('\n');
    const saveList = el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      'aria-label': 'Save the allowlist',
      onClick: async () => {
        const allowlist = list.value.split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        try {
          await write({ allowlist });
          toast('Saved');
        } catch (error) { errorToast(error); }
      },
    }, 'Save');
    return card({
      label: 'Which packages are welcome',
      glyph: 'list',
      body: el('div', { class: 'form-stack' },
        el('p', { class: 'form-note' },
          'An empty list means every package the registry offers may be installed. '
          + 'A list with entries in it means only those, and nothing else.'),
        list,
        el('div', { class: 'formfoot' }, saveList)),
    });
  }

  // -- the two gates on what may be installed -----------------------------------

  function gatesCard() {
    const unreviewed = switchControl(policy.allowUnreviewed, async (on) => {
      try {
        await write({ allowUnreviewed: on });
        toast('Saved');
      } catch (error) {
        setSwitch(unreviewed, !on);
        errorToast(error);
      }
    }, 'Allow packages that have not been reviewed');

    const signature = switchControl(policy.requireSignature, async (on) => {
      try {
        await write({ requireSignature: on });
        toast('Saved');
      } catch (error) {
        setSwitch(signature, !on);
        errorToast(error);
      }
    }, 'Require a verified signature');

    return card({
      label: 'What a package has to be',
      glyph: 'shield',
      body: el('div', { class: 'fold' },
        el('div', { class: 'settings-item' },
          el('div', { class: 'settings-item-main' },
            el('p', { class: 'settings-item-label' }, 'Reviewed packages only'),
            el('p', { class: 'settings-note' },
              'Off: a package that has not been reviewed may be installed. On: only a package the review '
              + 'has approved may be installed, and a rejected one never may.')),
          el('div', { class: 'settings-item-control' }, unreviewed)),
        el('div', { class: 'settings-item' },
          el('div', { class: 'settings-item-main' },
            el('p', { class: 'settings-item-label' }, 'A verified signature'),
            el('p', { class: 'settings-note' },
              'Off: an unsigned package may be installed. On: only a package whose signature verifies against '
              + 'the signing keys the server holds may be installed.')),
          el('div', { class: 'settings-item-control' }, signature))),
    });
  }

  // -- the switch that is not about a permission -------------------------------

  function trustedCard() {
    let control = null;
    const toggle = async (on) => {
      if (!on) {
        try {
          await write({ allowTrusted: false });
          toast('Saved');
        } catch (error) {
          setSwitch(control, true);
          errorToast(error);
        }
        return;
      }
      // Switching this on is not a setting change, it is a decision about what
      // may run on the server. It is asked for, and it says what it does.
      const yes = await confirmDialog({
        title: 'Allow extensions that run code on the server?',
        body: TRUSTED_WARNING,
        confirmLabel: 'Allow server-side code',
        danger: true,
      });
      if (!yes) {
        setSwitch(control, false);
        return;
      }
      try {
        await write({ allowTrusted: true });
        toast('Saved');
      } catch (error) {
        setSwitch(control, false);
        errorToast(error);
      }
    };

    control = switchControl(policy.allowTrusted, toggle, 'Allow extensions that run code on the server');

    return card({
      label: 'Server-side code',
      glyph: 'shield-alert',
      body: el('div', { class: 'fold' },
        policy.allowTrusted ? memo({
          tone: 'danger',
          title: 'Extensions may run code on this server',
          text: TRUSTED_WARNING,
        }) : null,
        el('div', { class: 'settings-item' },
          el('div', { class: 'settings-item-main' },
            el('p', { class: 'settings-item-label' }, 'Allow code from packages'),
            el('p', { class: 'settings-note' }, TRUSTED_WARNING)),
          el('div', { class: 'settings-item-control' }, control))),
    });
  }

  // -- the whole policy ---------------------------------------------------------

  async function paint() {
    body.replaceChildren(hold('Reading the policy'));
    try {
      const answer = await readPolicy();
      policy = (answer && answer.policy) || {};
      body.replaceChildren(
        sourceCard(),
        allowlistCard(),
        gatesCard(),
        trustedCard(),
      );
    } catch (error) {
      body.replaceChildren(fault(error, paint));
    }
  }

  return {
    node: fold([
      card({
        label: 'The extension policy',
        glyph: 'settings',
        note: 'what this instance will install, and what it will let run',
        body,
      }),
    ]),
    onMount: () => paint(),
    cleanup() {},
  };
}

export default { policySection };
