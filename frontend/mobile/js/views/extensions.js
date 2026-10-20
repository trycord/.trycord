// The extension console, on a phone.
//
// The same four things the desk has - the registry, what is installed, the
// policy, and the workflows - arranged the way a phone arranges things: a
// strip of sections, a list under each, and a sheet for anything that needs
// reading properly or answering.
//
// The consent is the same on a phone as on a desk. The package says what it
// asks for, the operator ticks what it may have, and nothing is sent until
// they have. The dangerous switch asks before it is turned on, and says what
// turning it on means.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { State } from '../../../packages/store.js';
import { request } from '../../../packages/api.js';
import { empty, failure, loading } from '../components.js';
import { screen, section, actions, primaryButton, ghostButton, field, textInput, textArea, select, notice } from './util.js';
import { sheet, confirm, toast } from '../ui.js';

// -- the endpoints -------------------------------------------------------------

const ROOT = '/api/extensions';

function pathId(value) {
  return encodeURIComponent(String(value || ''));
}

const readPolicy = () => request('GET', ROOT + '/policy');
const writePolicy = (patch) => request('PUT', ROOT + '/policy', { body: patch });
const readRegistry = (refresh) => request('GET', ROOT + '/registry' + (refresh ? '?refresh=1' : ''));
const readPackage = (id) => request('GET', ROOT + '/registry/' + pathId(id));
const readInstalled = () => request('GET', ROOT + '/installed');
const installExtension = (body) => request('POST', ROOT + '/install', { body });
const readExtension = (id) => request('GET', ROOT + '/' + pathId(id));
const enableExtension = (id) => request('POST', ROOT + '/' + pathId(id) + '/enable');
const disableExtension = (id) => request('POST', ROOT + '/' + pathId(id) + '/disable');
const updateExtension = (id) => request('POST', ROOT + '/' + pathId(id) + '/update', { body: {} });
const rollbackExtension = (id, version) => request('POST', ROOT + '/' + pathId(id) + '/rollback', { body: { version } });
const removeExtension = (id) => request('DELETE', ROOT + '/' + pathId(id), { body: { reason: 'removed by an operator' } });
const grantCapability = (id, capability) => request('POST', ROOT + '/' + pathId(id) + '/grants', { body: { capability, reason: null } });
const revokeCapability = (id, capability) => request('DELETE', ROOT + '/' + pathId(id) + '/grants/' + pathId(capability), { body: { reason: null } });
const readWorkflows = () => request('GET', ROOT + '/workflows');
const readWorkflow = (id) => request('GET', ROOT + '/workflows/' + pathId(id));
const readWorkflowRuns = (id) => request('GET', ROOT + '/workflows/' + pathId(id) + '/runs');
const readRun = (id) => request('GET', ROOT + '/workflows/runs/' + pathId(id));
const runWorkflow = (id) => request('POST', ROOT + '/workflows/' + pathId(id) + '/run', { body: {} });
const dryRunWorkflow = (id) => request('POST', ROOT + '/workflows/' + pathId(id) + '/dry-run', { body: {} });
const pauseWorkflow = (id) => request('POST', ROOT + '/workflows/' + pathId(id) + '/pause');
const resumeWorkflow = (id) => request('POST', ROOT + '/workflows/' + pathId(id) + '/resume');
const approveRun = (id, approved) => request('POST', ROOT + '/workflows/runs/' + pathId(id) + '/approve', { body: { approved } });
const grantWorkflowCapability = (id, capability) => request('POST', ROOT + '/workflows/' + pathId(id) + '/grants', { body: { capability, reason: null } });
const revokeWorkflowCapability = (id, capability) => request('DELETE', ROOT + '/workflows/' + pathId(id) + '/grants/' + pathId(capability), { body: { reason: null } });

// -- the shared pieces ---------------------------------------------------------

function isOperator() {
  return !!(State.user && State.user.isAdmin);
}

function capabilityLabel(capability) {
  return String(capability || '')
    .split('.')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' · ');
}

function grantedSet(list) {
  return new Set((Array.isArray(list) ? list : []).map((entry) => String(entry || '')));
}

// A switch on a phone: the same control, drawn the way a phone draws one.
function switchRow(label, note, checked, onChange) {
  const control = el('button', {
    class: 'm-switch', type: 'button', role: 'switch',
    'aria-checked': String(!!checked),
    'aria-label': label,
  });
  control.addEventListener('click', () => {
    const next = control.getAttribute('aria-checked') !== 'true';
    control.setAttribute('aria-checked', String(next));
    onChange(next, control);
  });
  return el('div', { class: 'm-row' },
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title' }, label),
      el('span', { class: 'm-row__sub' }, note)),
    el('span', { class: 'm-row__actions' }, control));
}

// -- the registry ---------------------------------------------------------------

// The consent: what the package asks for, and the operator's answer.
function consentSheet(packageId, onInstalled) {
  const body = el('div', { class: 'm-stack' });
  const status = el('p', { class: 'm-form-error', role: 'status' });
  const install = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button', disabled: true }, 'Install');
  const layer = sheet({
    title: 'Install ' + packageId,
    body: el('div', { class: 'm-stack' }, body, status),
    footer: el('div', { class: 'm-actions' }, install),
  });

  let boxes = new Map();
  let requested = [];
  let pkg = null;

  const granted = () => [...boxes.entries()]
    .filter((entry) => entry[1].checked)
    .map((entry) => entry[0]);

  function refresh() {
    install.disabled = !pkg || (requested.length > 0 && granted().length === 0);
    install.textContent = requested.length
      ? 'Install with ' + granted().length + ' capabilit' + (granted().length === 1 ? 'y' : 'ies')
      : 'Install';
  }

  function load() {
    clear(body);
    body.appendChild(loading('Reading the package'));
    readPackage(packageId).then((answer) => {
      pkg = (answer && answer.package) || {};
      requested = Array.isArray(pkg.requestedCapabilities) ? pkg.requestedCapabilities : [];
      boxes = new Map();
      const choices = el('div', { class: 'm-stack' });
      if (!requested.length) {
        choices.appendChild(el('p', { class: 'm-lede' },
          'This package asks for no capabilities.'));
      } else {
        choices.appendChild(el('p', { class: 'm-lede' },
          'Tick the capabilities this extension may use. It cannot use one you leave unticked.'));
        for (const capability of requested) {
          const box = el('input', {
            class: 'm-check', type: 'checkbox', value: capability,
            'aria-label': 'Grant ' + capabilityLabel(capability) + ' to ' + pkg.id,
          });
          boxes.set(capability, box);
          box.addEventListener('change', refresh);
          choices.appendChild(el('label', { class: 'm-check-row' },
            box,
            el('span', { class: 'm-row__body' },
              el('span', { class: 'm-row__title' }, capabilityLabel(capability)),
              el('span', { class: 'm-row__sub' }, capability))));
        }
      }
      clear(body);
      body.appendChild(el('div', { class: 'm-stack' },
        el('p', { class: 'm-lede' }, pkg.description || 'The package gave no description.'),
        notice({
          tone: pkg.trusted ? 'warning' : 'info',
          title: pkg.trusted ? 'It runs code on the server' : 'What it is',
          text: (pkg.author ? 'By ' + pkg.author + '. ' : '')
            + 'Reviewed: ' + (pkg.reviewStatus || 'unknown') + '. '
            + 'Signature: ' + (pkg.signature && pkg.signature.status ? pkg.signature.status : 'unsigned') + '.',
        }),
        choices));
      if (pkg.installable === false && pkg.reason) {
        status.textContent = pkg.reason;
        install.disabled = true;
      } else {
        status.textContent = '';
      }
      refresh();
    }).catch((error) => {
      clear(body);
      body.appendChild(failure(error, load));
    });
  }

  install.addEventListener('click', async () => {
    // An install that was not answered is not sent. The button is disabled
    // until it is, and this is the second lock on the same door.
    if (install.disabled) return;
    install.disabled = true;
    status.textContent = '';
    try {
      const answer = await installExtension({
        id: pkg.id,
        version: pkg.version || null,
        grants: granted(),
      });
      layer.close();
      const given = (answer && answer.granted) || [];
      toast('Installed.' + (given.length ? ' Granted: ' + given.join(', ') + '.' : ''), { type: 'success' });
      if (onInstalled) onInstalled();
    } catch (error) {
      status.textContent = (error && error.message) || 'The install was refused.';
      install.disabled = false;
    }
  });

  load();
  return layer;
}

function registrySection(host, reload) {
  const list = el('div', { class: 'm-list' });
  clear(host);
  host.appendChild(loading('Reading the registry'));

  readRegistry(false).then((answer) => {
    const registry = (answer && answer.registry) || {};
    const entries = Array.isArray(registry.extensions) ? registry.extensions : [];
    clear(host);
    if (registry.error) {
      host.appendChild(notice({
        tone: 'warning',
        title: registry.stale ? 'The registry could not be reached' : 'The registry reported a problem',
        text: registry.error + (registry.stale ? ' The list below is the last copy this instance saw.' : ''),
      }));
    }
    if (!entries.length) {
      host.appendChild(empty({
        icon: 'rocket',
        title: 'The registry offers nothing',
        text: 'No package is on offer here.',
      }));
      return;
    }
    for (const entry of entries) {
      const asked = entry.requestedCapabilities || [];
      list.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => {
          if (!isOperator()) {
            toast('Only an administrator may install an extension.', { type: 'error' });
            return;
          }
          consentSheet(entry.id, reload);
        },
      },
      el('span', { class: 'm-row__lead' }, icon('rocket', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, entry.name || entry.id),
        el('span', { class: 'm-row__sub truncate' },
          entry.description || (entry.author ? 'By ' + entry.author : ''))),
      el('span', { class: 'm-row__side' },
        el('span', { class: 'm-chip' }, entry.reviewStatus || 'unknown'),
        el('span', { class: 'm-chip' }, asked.length + ' capabilit' + (asked.length === 1 ? 'y' : 'ies')))));
    }
    host.appendChild(section('What is on offer', list));
  }).catch((error) => {
    clear(host);
    host.appendChild(failure(error, () => registrySection(host, reload)));
  });
}

// -- what is installed -----------------------------------------------------------

function installedSheet(extension, onDone) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({ title: extension.name || extension.id, body });

  const asked = Array.isArray(extension.requestedCapabilities) ? extension.requestedCapabilities : [];
  const held = grantedSet(extension.grants);
  const askable = asked.filter((capability) => !held.has(capability));

  const caps = el('div', { class: 'm-stack' });
  for (const capability of asked) {
    const granted = held.has(capability);
    caps.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, capabilityLabel(capability)),
        el('span', { class: 'm-row__sub' }, granted
          ? 'Granted. It may use this.'
          : 'Not granted. It cannot use this.')),
      el('span', { class: 'm-row__actions' },
        granted
          ? el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Take back ' + capabilityLabel(capability) + ' from ' + extension.name,
            onClick: async () => {
              const yes = await confirm({
                title: 'Take this capability back?',
                text: extension.name + ' stops being able to use ' + capabilityLabel(capability)
                  + ' on its next call.',
                confirmLabel: 'Take it back',
                danger: true,
              });
              if (!yes) return;
              try {
                await revokeCapability(extension.id, capability);
                toast('Taken back');
                layer.close();
                onDone();
              } catch (error) { toast(error.message, { type: 'error' }); }
            },
          }, 'Take it back')
          : el('span', { class: 'm-chip' }, 'not granted'))));
  }
  if (!asked.length) {
    caps.appendChild(el('p', { class: 'm-lede' }, 'It asked for no capabilities.'));
  }

  const grant = el('div', { class: 'm-stack' });
  if (askable.length) {
    const picker = select({
      label: 'Grant another capability',
      choices: askable.map((capability) => ({ value: capability, label: capabilityLabel(capability) })),
    });
    grant.appendChild(picker);
    grant.appendChild(primaryButton('Grant it', async () => {
      const capability = picker.value;
      if (!capability) return;
      try {
        await grantCapability(extension.id, capability);
        toast('Granted ' + capabilityLabel(capability));
        layer.close();
        onDone();
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
  }

  const buttons = [];
  if (extension.state !== 'enabled' && extension.state !== 'removed') {
    buttons.push(ghostButton('Enable', async () => {
      try {
        await enableExtension(extension.id);
        toast('Enabled');
        layer.close();
        onDone();
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
  }
  if (extension.state === 'enabled') {
    buttons.push(ghostButton('Disable', async () => {
      try {
        await disableExtension(extension.id);
        toast('Disabled');
        layer.close();
        onDone();
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
  }
  if (extension.state !== 'removed') {
    buttons.push(ghostButton('Update', async () => {
      try {
        await updateExtension(extension.id);
        toast('Updated');
        layer.close();
        onDone();
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
    buttons.push(ghostButton('Roll back', async () => {
      try {
        const answer = await readExtension(extension.id);
        const versions = ((answer && answer.extension && answer.extension.versions) || [])
          .filter((entry) => entry.version && entry.version !== extension.version);
        if (!versions.length) {
          toast('There is no earlier version to go back to.');
          return;
        }
        const pickerControl = select({
          choices: versions.map((entry) => ({ value: entry.version, label: entry.version })),
        });
        const choose = sheet({
          title: 'Roll back to',
          body: el('div', { class: 'm-stack' },
            field({ label: 'The version to go back to', control: pickerControl })),
          footer: actions([primaryButton('Roll back', async () => {
            try {
              await rollbackExtension(extension.id, pickerControl.value);
              toast('Rolled back to ' + pickerControl.value);
              choose.close();
              layer.close();
              onDone();
            } catch (error) { toast(error.message, { type: 'error' }); }
          })]),
        });
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
    buttons.push(el('button', {
      class: 'm-btn m-btn--block m-btn--danger', type: 'button',
      'aria-label': 'Remove ' + extension.name,
      onClick: async () => {
        const yes = await confirm({
          title: 'Remove this extension?',
          text: 'Its capabilities are revoked, its workflows are paused, and the record of it is kept. '
            + 'This cannot be undone from here.',
          confirmLabel: 'Remove it',
          danger: true,
        });
        if (!yes) return;
        try {
          await removeExtension(extension.id);
          toast('Removed');
          layer.close();
          onDone();
        } catch (error) { toast(error.message, { type: 'error' }); }
      },
    }, 'Remove it'));
  }

  body.appendChild(notice({
    tone: extension.trusted ? 'warning' : 'info',
    title: 'State: ' + (extension.state || 'unknown'),
    text: extension.trusted
      ? 'This extension runs code on the server. It has its own code inside this instance.'
      : (extension.description || 'It runs with the capabilities it was granted, and nothing else.'),
  }));
  body.appendChild(el('p', { class: 'm-eyebrow' }, 'The capabilities it asked for'));
  body.appendChild(caps);
  if (grant.childNodes.length) {
    body.appendChild(el('p', { class: 'm-eyebrow' }, 'Grant another capability'));
    body.appendChild(grant);
  }
  if (buttons.length) {
    body.appendChild(el('div', { class: 'm-actions m-actions--wrap' }, buttons));
  }
  return layer;
}

function installedSection(host, reload) {
  clear(host);
  host.appendChild(loading('Reading the installed extensions'));
  readInstalled().then((answer) => {
    const extensions = (answer && answer.extensions) || [];
    clear(host);
    if (!extensions.length) {
      host.appendChild(empty({
        icon: 'rocket',
        title: 'Nothing is installed',
        text: 'This instance runs no extensions.',
      }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const extension of extensions) {
      const held = grantedSet(extension.grants);
      list.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => installedSheet(extension, reload),
      },
      el('span', { class: 'm-row__lead' }, icon('rocket', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, extension.name || extension.id),
        el('span', { class: 'm-row__sub truncate' },
          (extension.version || '') + ' · ' + held.size + ' capabilit' + (held.size === 1 ? 'y' : 'ies'))),
      el('span', { class: 'm-row__side' },
        el('span', { class: 'm-chip' }, extension.state || 'installed'))));
    }
    host.appendChild(section('Installed on this instance', list));
  }).catch((error) => {
    clear(host);
    host.appendChild(failure(error, () => installedSection(host, reload)));
  });
}

// -- the policy -------------------------------------------------------------------

const TRUSTED_WARNING = 'A trusted package brings its own code and runs it inside this instance\'s server '
  + 'process, where it can read what the instance can read and write what the instance can write. '
  + 'It is not a permission that can be taken back: the code is already running. '
  + 'Only allow packages you would trust with the server itself.';

function policySection(host) {
  clear(host);
  host.appendChild(loading('Reading the policy'));
  readPolicy().then((answer) => {
    const policy = (answer && answer.policy) || {};
    clear(host);

    const modeControl = select({
      choices: [
        { value: 'disabled', label: 'No registry' },
        { value: 'builtin', label: 'The first-party directory' },
        { value: 'mirror', label: 'A registry of my own' },
      ],
      value: policy.registryMode,
    });
    const urlControl = textInput({
      value: policy.registryUrl || '',
      placeholder: 'https://example.org/registry.json',
    });

    const allowlistControl = textArea({
      value: (policy.allowlist || []).join('\n'),
      rows: 4,
    });

    const unreviewed = switchRow(
      'Reviewed packages only',
      policy.allowUnreviewed
        ? 'A package that has not been reviewed may be installed.'
        : 'Only a package the review has approved may be installed.',
      policy.allowUnreviewed,
      async (on, control) => {
        try {
          await writePolicy({ allowUnreviewed: on });
          toast('Saved');
        } catch (error) {
          control.setAttribute('aria-checked', String(!on));
          toast(error.message, { type: 'error' });
        }
      });

    const signature = switchRow(
      'A verified signature',
      policy.requireSignature
        ? 'Only a package whose signature verifies may be installed.'
        : 'An unsigned package may be installed.',
      policy.requireSignature,
      async (on, control) => {
        try {
          await writePolicy({ requireSignature: on });
          toast('Saved');
        } catch (error) {
          control.setAttribute('aria-checked', String(!on));
          toast(error.message, { type: 'error' });
        }
      });

    const trusted = switchRow(
      'Allow code from packages',
      TRUSTED_WARNING,
      policy.allowTrusted,
      async (on, control) => {
        if (!on) {
          try {
            await writePolicy({ allowTrusted: false });
            toast('Saved');
          } catch (error) {
            control.setAttribute('aria-checked', 'true');
            toast(error.message, { type: 'error' });
          }
          return;
        }
        const yes = await confirm({
          title: 'Allow extensions that run code on the server?',
          text: TRUSTED_WARNING,
          confirmLabel: 'Allow server-side code',
          danger: true,
        });
        if (!yes) {
          control.setAttribute('aria-checked', 'false');
          return;
        }
        try {
          await writePolicy({ allowTrusted: true });
          toast('Saved');
        } catch (error) {
          control.setAttribute('aria-checked', 'false');
          toast(error.message, { type: 'error' });
        }
      });

    const list = el('div', { class: 'm-list' });
    list.appendChild(unreviewed);
    list.appendChild(signature);

    host.appendChild(section('Where packages come from', el('div', { class: 'm-stack' },
      field({ label: 'Where packages come from', control: modeControl }),
      el('p', { class: 'm-lede' }, 'It is read from the first-party directory.'),
      field({ label: 'The address of your own registry', control: urlControl }),
      primaryButton('Save', async () => {
        try {
          await writePolicy({ registryMode: modeControl.value, registryUrl: urlControl.value.trim() || null });
          toast('Saved');
        } catch (error) { toast(error.message, { type: 'error' }); }
      }))));

    host.appendChild(section('Which packages are welcome', el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' },
        'An empty list means every package the registry offers may be installed.'),
      field({ label: 'The packages on the allowlist, one per line', control: allowlistControl }),
      primaryButton('Save', async () => {
        const entries = allowlistControl.value.split('\n').map((line) => line.trim()).filter(Boolean);
        try {
          await writePolicy({ allowlist: entries });
          toast('Saved');
        } catch (error) { toast(error.message, { type: 'error' }); }
      }))));

    host.appendChild(section('What a package has to be', list));

    host.appendChild(section('Server-side code', el('div', { class: 'm-stack' },
      policy.allowTrusted ? notice({
        tone: 'danger',
        title: 'Extensions may run code on this server',
        text: TRUSTED_WARNING,
      }) : null,
      el('div', { class: 'm-list' }, trusted))));
  }).catch((error) => {
    clear(host);
    host.appendChild(failure(error, () => policySection(host)));
  });
}

// -- the workflows -----------------------------------------------------------------

function triggerLabel(trigger) {
  const value = trigger && typeof trigger === 'object' ? trigger : {};
  if (value.type === 'event') return 'on ' + (value.event || 'an event');
  if (value.type === 'schedule') {
    return 'every ' + Math.round((Number(value.everyMs) || 0) / 60000) + ' minutes';
  }
  return 'by hand';
}

function stepLabel(step) {
  const value = step && typeof step === 'object' ? step : {};
  if (value.type === 'approval') return 'waits for an approval';
  if (value.type === 'code') return 'runs extension code';
  return value.action || 'a step';
}

function duration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return value + ' ms';
  return (value / 1000).toFixed(1) + ' s';
}

function runSheet(run) {
  const body = el('div', { class: 'm-stack' });
  sheet({ title: 'One run', body });
  body.appendChild(loading('Reading the run'));
  readRun(run.id).then((answer) => {
    const detail = (answer && answer.run) ? answer : { run, steps: [] };
    clear(body);
    body.appendChild(notice({
      tone: detail.run && detail.run.status === 'failed' ? 'danger' : 'info',
      title: 'It ended as ' + String((detail.run && detail.run.status) || 'unknown'),
      text: detail.run && detail.run.reason
        ? 'Why it ended: ' + detail.run.reason
        : 'No reason was recorded for this run.',
    }));
    const steps = detail.steps || [];
    if (!steps.length) {
      body.appendChild(el('p', { class: 'm-lede' }, 'It recorded no steps.'));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const step of steps) {
      list.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, (step.index + 1) + '. ' + stepLabel(step)),
          el('span', { class: 'm-row__sub' }, step.error
            ? 'It failed: ' + step.error
            : (step.output && step.output.note ? step.output.note : 'It did not record a reason.'))),
        el('span', { class: 'm-row__side' },
          el('span', { class: 'm-chip' }, String(step.status || 'unknown')),
          el('span', { class: 'm-chip' }, duration(step.durationMs)))));
    }
    body.appendChild(list);
  }).catch((error) => {
    clear(body);
    body.appendChild(failure(error, null));
  });
}

function dryRunSheet(workflow) {
  const body = el('div', { class: 'm-stack' });
  sheet({ title: 'What a run would do', body });
  body.appendChild(loading('Working out the plan'));
  dryRunWorkflow(workflow.id).then((answer) => {
    const plan = (answer && answer.plan) || [];
    clear(body);
    body.appendChild(notice({
      tone: 'info',
      title: 'Nothing was done',
      text: 'A dry run reads the workflow and writes nothing. No message is posted and no capability is spent.',
    }));
    if (!plan.length) {
      body.appendChild(el('p', { class: 'm-lede' }, 'It would do nothing at all.'));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const step of plan) {
      list.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, (step.index + 1) + '. ' + stepLabel(step)),
          el('span', { class: 'm-row__sub' }, step.note || step.description || 'The step would be carried out.')),
        el('span', { class: 'm-row__side' },
          el('span', { class: 'm-chip' }, step.permitted === false ? 'would be refused' : 'would be allowed'))));
    }
    body.appendChild(list);
  }).catch((error) => {
    clear(body);
    body.appendChild(failure(error, null));
  });
}

function workflowSheet(workflow, onDone) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({ title: workflow.name, body });

  const held = grantedSet(workflow.grants);
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];

  body.appendChild(notice({
    tone: 'info',
    title: workflow.state === 'active' ? 'It is running' : 'It is ' + (workflow.state || 'unknown'),
    text: (workflow.description || '') + ' It runs ' + triggerLabel(workflow.trigger) + '.',
  }));

  const stepList = el('div', { class: 'm-list' });
  for (const step of steps) {
    stepList.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, stepLabel(step)),
        el('span', { class: 'm-row__sub' }, step.type === 'approval'
          ? 'The run waits here until somebody decides.'
          : 'It is step ' + (steps.indexOf(step) + 1) + '.'))));
  }
  body.appendChild(el('p', { class: 'm-eyebrow' }, 'Its steps'));
  body.appendChild(steps.length ? stepList : el('p', { class: 'm-lede' }, 'It has no steps.'));

  const grantList = el('div', { class: 'm-list' });
  for (const capability of workflow.grants || []) {
    grantList.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, capabilityLabel(capability)),
        el('span', { class: 'm-row__sub' }, capability)),
      el('span', { class: 'm-row__actions' },
        isOperator()
          ? el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Take back ' + capabilityLabel(capability) + ' from ' + workflow.name,
            onClick: async () => {
              const yes = await confirm({
                title: 'Take this capability back?',
                text: workflow.name + ' stops being able to use ' + capabilityLabel(capability)
                  + ' on its next call.',
                confirmLabel: 'Take it back',
                danger: true,
              });
              if (!yes) return;
              try {
                await revokeWorkflowCapability(workflow.id, capability);
                toast('Taken back');
                layer.close();
                onDone();
              } catch (error) { toast(error.message, { type: 'error' }); }
            },
          }, 'Take it back')
          : null)));
  }
  body.appendChild(el('p', { class: 'm-eyebrow' }, 'The capabilities it holds'));
  body.appendChild((workflow.grants || []).length
    ? grantList
    : el('p', { class: 'm-lede' }, 'None. It may only do what its owner could do by hand.'));

  if (isOperator()) {
    const nameControl = textInput({ placeholder: 'messages.read' });
    body.appendChild(el('p', { class: 'm-eyebrow' }, 'Grant another capability'));
    body.appendChild(field({ label: 'The capability to grant', control: nameControl }));
    body.appendChild(primaryButton('Grant it', async () => {
      const capability = nameControl.value.trim();
      if (!capability) {
        toast('Name the capability to grant.', { type: 'error' });
        return;
      }
      try {
        await grantWorkflowCapability(workflow.id, capability);
        toast('Granted ' + capabilityLabel(capability));
        layer.close();
        onDone();
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
  }

  const buttons = [];
  const me = (State.user && State.user.id) || null;
  if (isOperator() || (me && workflow.ownerId === me)) {
    buttons.push(primaryButton('Run it', async () => {
      try {
        const answer = await runWorkflow(workflow.id);
        const run = (answer && answer.run) || {};
        toast('Ran: ' + (run.status || 'done'));
        layer.close();
        onDone();
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
    buttons.push(ghostButton('Dry run', () => dryRunSheet(workflow)));
    buttons.push(workflow.state === 'active'
      ? ghostButton('Pause', async () => {
        try {
          await pauseWorkflow(workflow.id);
          toast('Paused');
          layer.close();
          onDone();
        } catch (error) { toast(error.message, { type: 'error' }); }
      })
      : ghostButton('Resume', async () => {
        try {
          await resumeWorkflow(workflow.id);
          toast('Resumed');
          layer.close();
          onDone();
        } catch (error) { toast(error.message, { type: 'error' }); }
      }));
  }
  if (buttons.length) {
    body.appendChild(el('div', { class: 'm-actions m-actions--wrap' }, buttons));
  }

  body.appendChild(el('p', { class: 'm-eyebrow' }, 'Its runs'));
  const runsList = el('div', { class: 'm-list' });
  body.appendChild(runsList);
  readWorkflowRuns(workflow.id).then((answer) => {
    const runs = (answer && answer.runs) || [];
    clear(runsList);
    if (!runs.length) {
      runsList.appendChild(el('p', { class: 'm-lede' }, 'It has not run yet.'));
      return;
    }
    for (const run of runs) {
      const waiting = run.status === 'awaiting_approval';
      runsList.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, String(run.status || 'unknown')),
          el('span', { class: 'm-row__sub' }, run.reason
            ? run.reason
            : (run.dryRun ? 'a dry run: nothing was done' : 'no reason was recorded'))),
        el('span', { class: 'm-row__side' },
          el('span', { class: 'm-chip' }, duration(run.durationMs)),
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'See the steps of the run of ' + workflow.name,
            onClick: () => runSheet(run),
          }, 'Steps'),
          waiting ? el('button', {
            class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
            'aria-label': 'Approve the run of ' + workflow.name + ' that is waiting',
            onClick: async () => {
              const yes = await confirm({
                title: 'Approve this run?',
                text: 'The workflow carries on from the step that was waiting. Whatever it does next, '
                  + 'it does as the owner of ' + workflow.name + '.',
                confirmLabel: 'Approve it',
              });
              if (!yes) return;
              try {
                await approveRun(run.id, true);
                toast('Approved');
                layer.close();
                onDone();
              } catch (error) { toast(error.message, { type: 'error' }); }
            },
          }, 'Approve') : null)));
    }
  }).catch((error) => {
    clear(runsList);
    runsList.appendChild(failure(error, null));
  });

  return layer;
}

function workflowsSection(host, reload) {
  clear(host);
  host.appendChild(loading('Reading the workflows'));
  readWorkflows().then((answer) => {
    const workflows = (answer && answer.workflows) || [];
    clear(host);
    if (!workflows.length) {
      host.appendChild(empty({
        icon: 'activity',
        title: 'No workflows here',
        text: 'Nothing on this instance runs on a trigger yet.',
      }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const workflow of workflows) {
      list.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => workflowSheet(workflow, reload),
      },
      el('span', { class: 'm-row__lead' }, icon('activity', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, workflow.name),
        el('span', { class: 'm-row__sub truncate' }, triggerLabel(workflow.trigger))),
      el('span', { class: 'm-row__side' },
        el('span', { class: 'm-chip' }, workflow.state || 'unknown'))));
    }
    host.appendChild(section('The workflows here', list));
  }).catch((error) => {
    clear(host);
    host.appendChild(failure(error, () => workflowsSection(host, reload)));
  });
}

// -- the screen -------------------------------------------------------------------

const SECTIONS = [
  { id: 'registry', label: 'Registry', operator: false },
  { id: 'installed', label: 'Installed', operator: true },
  { id: 'policy', label: 'Policy', operator: true },
  { id: 'workflows', label: 'Workflows', operator: false },
];

export function renderExtensions(ctx) {
  const host = el('div', { class: 'm-stack' });
  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Extension console sections' });
  let current = 'registry';

  const offered = () => SECTIONS.filter((section) => !section.operator || isOperator());

  function paintStrip() {
    clear(strip);
    for (const section of offered()) {
      strip.appendChild(el('button', {
        class: 'm-seg__item' + (section.id === current ? ' is-active' : ''),
        type: 'button', role: 'tab',
        'aria-selected': section.id === current ? 'true' : 'false',
        'aria-label': 'Show the ' + section.label.toLowerCase() + ' section',
        onClick: () => show(section.id),
      }, section.label));
    }
  }

  function show(id) {
    current = id;
    paintStrip();
    if (id === 'registry') registrySection(host, () => show('registry'));
    else if (id === 'installed') installedSection(host, () => show('installed'));
    else if (id === 'policy') policySection(host);
    else workflowsSection(host, () => show('workflows'));
  }

  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Extensions'),
      el('div', { class: 'm-hero__sub' },
        'What may be installed here, what is installed, and what it is allowed to do.')),
    strip,
    host,
  );

  return {
    node,
    head: { title: 'Extensions' },
    onMount: async () => {
      paintStrip();
      show(current);
    },
  };
}

export default { renderExtensions };
