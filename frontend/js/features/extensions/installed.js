// What this instance has installed.
//
// An installed extension is a package, the capabilities it was granted, and a
// state: installed, enabled, disabled or removed. Enabling one activates the
// workflows it owns, disabling one pauses them, and removing one revokes its
// capabilities and keeps the record.
//
// The grants are the extension's permissions. A capability that is not granted
// is not offered to it, and taking one back stops it on its next call - so the
// grant list here is the same list the server checks, read live.

import { el } from '../../../packages/dom.js';
import { card, blank, fault, fold, hold, memo } from '../../ui/page.js';
import { confirmDialog, openDialog, errorToast, toast } from '../../ui/overlays.js';
import {
  disableExtension, enableExtension, grantCapability, readExtension, readInstalled,
  removeExtension, revokeCapability, rollbackExtension, updateExtension,
} from './api.js';
import {
  capabilityChip, capabilityLabel, extensionStateChip, isOperator, reviewChip, signatureChip,
} from './parts.js';

// The capabilities an extension may still be given: the ones it asked for and
// does not hold. A capability it never asked for is not offered, because the
// server refuses it and offering it would teach the operator that the console
// makes promises it cannot keep.
function grantableCapabilities(extension, granted) {
  const asked = Array.isArray(extension.requestedCapabilities) ? extension.requestedCapabilities : [];
  return asked.filter((capability) => !granted.has(capability));
}

// The grant control: a picker of what may still be granted, and a button.
function grantControl(extension, granted, onDone) {
  const options = grantableCapabilities(extension, granted);
  if (!options.length) {
    return el('p', { class: 'form-note' },
      extension.requestedCapabilities && extension.requestedCapabilities.length
        ? 'It holds every capability it asked for.'
        : 'It asked for no capabilities.');
  }
  const picker = el('select', { class: 'input', 'aria-label': 'The capability to grant ' + extension.name },
    ...options.map((capability) => el('option', { value: capability }, capabilityLabel(capability))));
  const give = el('button', {
    class: 'btn btn--default btn--sm', type: 'button',
    onClick: async () => {
      const capability = picker.value;
      if (!capability) return;
      give.disabled = true;
      try {
        await grantCapability(extension.id, capability, null);
        toast('Granted ' + capabilityLabel(capability));
        onDone();
      } catch (error) {
        errorToast(error);
      } finally {
        give.disabled = false;
      }
    },
  }, 'Grant it');
  return el('div', { class: 'form-stack' }, picker, give);
}

// One extension, with its state, its capabilities and its actions.
function extensionCard(extension, onDone) {
  const granted = new Set((Array.isArray(extension.grants) ? extension.grants : []).map(String));
  const asked = Array.isArray(extension.requestedCapabilities) ? extension.requestedCapabilities : [];

  const grantRows = asked.map((capability) => {
    const held = granted.has(capability);
    return el('div', { class: 'settings-item' },
      el('div', { class: 'settings-item-main' },
        el('p', { class: 'settings-item-label' }, capabilityLabel(capability),
          el('span', { class: 'form-note' }, ' ' + capability)),
        el('p', { class: 'settings-note' }, held
          ? 'Granted. It may use this, and you can take it back.'
          : 'Not granted. It cannot use this, and it is not offered to it.')),
      el('div', { class: 'settings-item-control' },
        capabilityChip(capability, held)),
      held
        ? el('div', { class: 'settings-item-actions' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Take back ' + capabilityLabel(capability) + ' from ' + extension.name,
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Take this capability back?',
                body: extension.name + ' stops being able to use ' + capabilityLabel(capability)
                  + ' on its next call. Its workflows keep their history.',
                confirmLabel: 'Take it back',
                danger: true,
              });
              if (!yes) return;
              try {
                await revokeCapability(extension.id, capability, null);
                toast('Taken back');
                onDone();
              } catch (error) { errorToast(error); }
            },
          }, 'Take it back'))
        : null);
  });

  const actions = [];
  if (extension.state !== 'enabled' && extension.state !== 'removed') {
    actions.push(el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
      'aria-label': 'Enable ' + extension.name,
      onClick: async () => {
        try {
          await enableExtension(extension.id);
          toast('Enabled');
          onDone();
        } catch (error) { errorToast(error); }
      },
    }, 'Enable'));
  }
  if (extension.state === 'enabled') {
    actions.push(el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
      'aria-label': 'Disable ' + extension.name,
      onClick: async () => {
        try {
          await disableExtension(extension.id);
          toast('Disabled');
          onDone();
        } catch (error) { errorToast(error); }
      },
    }, 'Disable'));
  }
  if (extension.state !== 'removed') {
    actions.push(el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
      'aria-label': 'Update ' + extension.name + ' to the version the registry offers',
      onClick: async () => {
        try {
          await updateExtension(extension.id, {});
          toast('Updated');
          onDone();
        } catch (error) { errorToast(error); }
      },
    }, 'Update'));
    actions.push(el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
      'aria-label': 'Roll ' + extension.name + ' back to an earlier version',
      onClick: () => openRollback(extension, onDone),
    }, 'Roll back'));
    actions.push(el('button', {
      class: 'btn btn--danger btn--sm', type: 'button',
      'aria-label': 'Remove ' + extension.name,
      onClick: async () => {
        const yes = await confirmDialog({
          title: 'Remove this extension?',
          body: 'Its capabilities are revoked, its workflows are paused, and the record of it is kept '
            + 'so the run history still makes sense. This cannot be undone from here.',
          confirmLabel: 'Remove it',
          danger: true,
        });
        if (!yes) return;
        try {
          await removeExtension(extension.id, 'removed by an operator');
          toast('Removed');
          onDone();
        } catch (error) { errorToast(error); }
      },
    }, 'Remove'));
  }

  return card({
    label: extension.name || extension.id,
    glyph: 'rocket',
    note: extension.version || '',
    actions: el('span', { class: 'chips' },
      extensionStateChip(extension.state),
      reviewChip(extension.reviewStatus),
      signatureChip(extension.signature)),
    body: el('div', { class: 'fold' },
      extension.description ? el('p', { class: 'lede' }, extension.description) : null,
      extension.trusted ? memo({
        tone: 'warning',
        title: 'This extension runs code on the server',
        text: 'It has its own code inside this instance, not only the capabilities granted to it.',
      }) : null,
      asked.length
        ? el('div', { class: 'fold fold--tight' },
          el('p', { class: 'form-note' }, 'The capabilities it asked for:'),
          el('div', { class: 'fold fold--tight' }, grantRows))
        : el('p', { class: 'form-note' }, 'It asked for no capabilities.'),
      isOperator() && extension.state !== 'removed'
        ? el('div', { class: 'fold fold--tight' },
          el('p', { class: 'form-note' }, 'Grant another capability:'),
          grantControl(extension, granted, onDone))
        : null),
    foot: actions.length ? el('div', { class: 'actionline' }, actions) : null,
  });
}

// The versions an extension can be put back to. The manifest and the code of
// the earlier version are restored exactly as they were.
function openRollback(extension, onDone) {
  const body = el('div', { class: 'fold' });
  const status = el('p', { class: 'form-error', role: 'status' });
  const picker = el('select', { class: 'input', 'aria-label': 'The version to roll back to' });
  const go = el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: true }, 'Roll back');
  const dialog = openDialog({
    title: 'Roll ' + (extension.name || extension.id) + ' back',
    sub: 'The manifest and the code of that version are put back as they were.',
    body: el('div', { class: 'fold' }, body, status),
    foot: [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      go,
    ],
  });

  body.replaceChildren(hold('Reading the versions'));
  readExtension(extension.id).then((answer) => {
    const detail = (answer && answer.extension) || {};
    const versions = (detail.versions || [])
      .filter((entry) => entry.version && entry.version !== extension.version);
    if (!versions.length) {
      body.replaceChildren(el('p', { class: 'form-note' },
        'There is no earlier version of this extension to go back to.'));
      return;
    }
    picker.replaceChildren(...versions.map((entry) => el('option', { value: entry.version },
      entry.version + (entry.installedAt ? ' · ' + entry.installedAt : ''))));
    body.replaceChildren(el('div', { class: 'form-stack' }, picker));
    go.disabled = false;
  }).catch((error) => {
    body.replaceChildren(fault(error, null));
  });

  go.addEventListener('click', async () => {
    const version = picker.value;
    if (!version) return;
    go.disabled = true;
    status.textContent = '';
    try {
      await rollbackExtension(extension.id, version);
      toast('Rolled back to ' + version);
      dialog.close();
      onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The rollback was refused.';
      go.disabled = false;
    }
  });

  return dialog;
}

// The installed extensions, as this instance holds them.
export function installedSection() {
  const body = el('div', { class: 'fold' });

  async function paint() {
    body.replaceChildren(hold('Reading the installed extensions'));
    try {
      const answer = await readInstalled();
      const extensions = (answer && answer.extensions) || [];
      if (!extensions.length) {
        body.replaceChildren(blank({
          glyph: 'rocket',
          title: 'Nothing is installed',
          text: 'This instance runs no extensions. The registry says what it could offer.',
        }));
        return;
      }
      body.replaceChildren(...extensions.map((extension) => extensionCard(extension, paint)));
    } catch (error) {
      body.replaceChildren(fault(error, paint));
    }
  }

  return {
    node: fold([
      card({
        label: 'Installed on this instance',
        glyph: 'rocket',
        note: 'their state, their capabilities, and what may be done to them',
        body,
      }),
    ]),
    onMount: () => paint(),
    cleanup() {},
  };
}

export default { installedSection };
