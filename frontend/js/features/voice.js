// Voice and video: the administrative section.
//
// The provider is chosen first, and then only that provider's fields are
// shown, plus the ones that are genuinely shared. Each provider keeps its own
// settings, so choosing a different one does not erase what was saved for the
// one before it.
//
// Credentials are managed rather than typed: a masked field that says whether
// one is set, a replace action and a clear action. A saved secret is never
// sent to this client, so there is nothing to show and nothing to leak.
//
// The state of each provider is shown where it can be acted on. A provider is
// not reported as working because its configuration was saved: only an answer
// from the other end makes it working.

import { el } from '../../packages/dom.js';
import { request } from '../../packages/api.js';
import { switchControl } from '../ui/primitives.js';
import { head, card, memo, fold, hold, fault } from '../ui/page.js';
import { errorToast, toast, confirmDialog } from '../ui/overlays.js';
import {
  SHARED_CONTROLS, providerLabel, stateOf, sourceLabel, fieldValue, saveBody,
} from '../../packages/voice.js';

const PROVIDERS_PATH = '/api/voice/providers';
const SETTINGS_PATH = '/api/admin/settings';

// The whole picture: the provider in force, the shared controls, and every
// provider with its own fields and its own state.
async function readProviders() {
  return request('GET', PROVIDERS_PATH);
}

async function saveSettings(values) {
  return request('PUT', SETTINGS_PATH, { body: saveBody(values) });
}

async function checkProvider(providerId) {
  return request('POST', PROVIDERS_PATH + '/' + encodeURIComponent(providerId) + '/check', { body: {} });
}

// The state of one provider, as a chip and a sentence.
function stateChip(state) {
  const described = stateOf(state);
  return el('span', { class: 'chip chip--' + described.tone }, described.label);
}

// One setting of the provider in force: a label, the value, and where the
// value came from.
function fieldRow(field, onSaved) {
  const control = el('input', {
    class: 'input',
    type: field.type === 'integer' ? 'number' : 'text',
    value: field.value === null || field.value === undefined ? '' : String(field.value),
    'aria-label': field.label,
  });
  if (field.type === 'list') {
    control.placeholder = 'comma-separated';
  }

  const save = async () => {
    try {
      await saveSettings({ [field.key]: fieldValue(field, control) });
      toast(field.label + ' saved');
      if (onSaved) onSaved();
    } catch (e) {
      errorToast(e);
    }
  };

  return el('div', { class: 'settings-item' },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, field.label,
        el('span', { class: 'chip chip--quiet' }, sourceLabel(field))),
      el('p', { class: 'settings-note' }, field.description || '')),
    el('div', { class: 'settings-item-control' }, control),
    el('div', { class: 'settings-item-actions' },
      el('button', {
        class: 'btn btn--primary btn--sm', type: 'button',
        'aria-label': 'Save ' + field.label,
        onClick: save,
      }, 'Save')));
}

// A credential: masked, never sent to this client, and replaced or cleared on
// purpose.
function secretRow(secret, onSaved) {
  const input = el('input', {
    class: 'input',
    type: 'password',
    value: '',
    placeholder: secret.set ? 'Set — type to replace' : 'Not set',
    'aria-label': 'New value for ' + secret.label,
    autocomplete: 'off',
  });

  const replace = async () => {
    if (!input.value.trim()) {
      toast('Type a value first');
      input.focus();
      return;
    }
    try {
      await saveSettings({ [secret.key]: input.value });
      input.value = '';
      toast(secret.label + ' replaced');
      if (onSaved) onSaved();
    } catch (e) {
      errorToast(e);
    }
  };

  const clear = async () => {
    const confirmed = await confirmDialog({
      title: 'Clear ' + secret.label + '?',
      body: 'The credential will be removed. A provider that needs it cannot carry a call until a new one is set.',
      confirmLabel: 'Clear it',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await saveSettings({ [secret.key]: null });
      input.value = '';
      toast(secret.label + ' cleared');
      if (onSaved) onSaved();
    } catch (e) {
      errorToast(e);
    }
  };

  return el('div', { class: 'settings-item' },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, secret.label,
        el('span', { class: 'chip ' + (secret.set ? 'chip--on' : 'chip--quiet') },
          secret.set ? 'set' : 'not set'),
        secret.source === 'legacy'
          ? el('span', { class: 'chip chip--warn' }, 'from the older setting ' + (secret.legacy || ''))
          : null),
      el('p', { class: 'settings-note' }, secret.description || '')),
    el('div', { class: 'settings-item-control' }, input),
    el('div', { class: 'settings-item-actions' },
      el('button', {
        class: 'btn btn--primary btn--sm', type: 'button',
        'aria-label': 'Replace ' + secret.label,
        onClick: replace,
      }, 'Replace'),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Clear ' + secret.label,
        onClick: clear,
      }, 'Clear')));
}

// The controls every provider shares.
//
// The participant limit is shared in meaning and per-provider in value: the
// field shown here belongs to the provider in force.
function sharedSection(report, onSaved) {
  const rows = [];

  for (const control of SHARED_CONTROLS) {
    const current = control.key === 'voice.enabled'
      ? report.enabled
      : control.key === 'voice.screenSharing'
        ? report.screenSharing
        : report.stageChannels;

    rows.push(el('div', { class: 'settings-item' },
      el('div', { class: 'settings-item-main' },
        el('p', { class: 'settings-item-label' }, control.label),
        el('p', { class: 'settings-note' }, control.description)),
      el('div', { class: 'settings-item-control' },
        switchControl(!!current, async (on) => {
          // Turning voice on is asked for. It changes what this instance
          // offers every member, and the provider has to be able to carry a
          // call: a switch that turns voice on for a provider that cannot
          // answer leaves every member with a room they cannot join.
          //
          // Turning it off is immediate. That is the safe direction, and
          // asking about it would only be friction.
          if (on && control.key === 'voice.enabled') {
            const yes = await confirmDialog({
              title: 'Turn voice on?',
              body: 'Every member of this instance will be able to join a voice channel. '
                + 'The ' + providerLabel(report.active) + ' provider has to be able to carry a call, '
                + 'so check that it answers before you rely on it.',
              confirmLabel: 'Turn voice on',
            });
            if (!yes) {
              // The switch is put back where it was: the reader changed their
              // mind, and the control must not show a state that is not true.
              if (onSaved) onSaved();
              return;
            }
          }
          try {
            await saveSettings({ [control.key]: on });
            toast(control.label + (on ? ' on' : ' off'));
            if (onSaved) onSaved();
          } catch (e) { errorToast(e); }
        }, control.label))));
  }

  const limitKey = 'voice.' + report.active + '.maxParticipants';
  const limitInput = el('input', {
    class: 'input', type: 'number', min: '1', max: '200',
    value: String(report.maxParticipants),
    'aria-label': 'Participants per channel',
  });
  rows.push(el('div', { class: 'settings-item' },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, 'Participants per channel',
        el('span', { class: 'chip chip--quiet' }, providerLabel(report.active))),
      el('p', { class: 'settings-note' },
        'How many people one channel holds on the ' + providerLabel(report.active)
        + ' provider. A full channel refuses rather than dropping someone.')),
    el('div', { class: 'settings-item-control' }, limitInput),
    el('div', { class: 'settings-item-actions' },
      el('button', {
        class: 'btn btn--primary btn--sm', type: 'button',
        'aria-label': 'Save the participant limit',
        onClick: async () => {
          const parsed = parseInt(limitInput.value, 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            toast('The limit must be a whole number of at least one');
            return;
          }
          try {
            await saveSettings({ [limitKey]: parsed });
            toast('The participant limit is saved');
            if (onSaved) onSaved();
          } catch (e) { errorToast(e); }
        },
      }, 'Save'))));

  return card({ label: 'Shared by every provider', glyph: 'settings', body: el('div', { class: 'fold' }, rows) });
}

// The fields of the provider in force, and nothing else.
function providerSection(provider, onSaved) {
  const rows = [];
  for (const field of provider.fields) rows.push(fieldRow(field, onSaved));
  for (const secret of provider.secrets) rows.push(secretRow(secret, onSaved));

  return card({
    label: provider.label,
    glyph: 'settings',
    note: provider.inForce ? 'in force' : 'not in force',
    body: el('div', { class: 'fold' },
      memo({ tone: 'info', title: provider.label, text: provider.note }),
      rows),
  });
}

// The instance's own STUN and TURN stack.
//
// It is a section of its own because it is a different thing from a provider:
// the providers are what an operator chooses between, and the stack is what
// the instance runs itself. The mesh provider *is* this stack, so an operator
// looking at the mesh needs to see it here.
//
// What is shown is the three states that are genuinely different - the
// process, the service, and the published address - because a report that
// said only "running" would be true in the three cases where it matters most
// to say more.
function stackSection(report) {
  const stack = report.stack;
  if (!stack) return null;

  const row = (label, value, note) => el('div', { class: 'settings-item' },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, label),
      note ? el('p', { class: 'settings-note' }, note) : null),
    el('div', { class: 'settings-item-control' },
      el('span', { class: 'chip ' + (value.ok ? 'chip--on' : 'chip--quiet') },
        value.text)));

  const rows = [
    row('The voice process', {
      ok: true,
      text: stack.running ? 'Running' : 'Not running',
    }, 'The STUN and TURN service runs in a process of its own, so it can be '
      + 'restarted without the application going down. This instance: '
      + stack.managed + '.'),
    row('The service', {
      ok: stack.running,
      text: stack.running ? 'Listening' : 'Not listening',
    }, 'It listens on ' + stack.listenHost + ':' + stack.listenPort + '.'),
    row('The published address', {
      ok: !stack.publishedIsLocal,
      text: stack.advertised,
    }, 'The address the clients are given. It has to point straight at this '
      + 'instance: a proxy that terminates TLS carries HTTP and not the '
      + 'arbitrary UDP a STUN or TURN service needs, so a relayed address '
      + 'published through one cannot be reached.'),
    row('The relay ports', {
      ok: true,
      text: stack.relayPorts.from + '-' + stack.relayPorts.to,
    }, 'The ports a relayed call may use. They have to be open to the internet '
      + 'along with ' + stack.listenPort + '.'),
    row('The credential secret', {
      ok: stack.secretSet,
      text: stack.secretSet ? 'Set' : 'Not set',
    }, stack.secretSet
      ? 'The credentials this instance issues are signed with it, and it never '
        + 'leaves the server.'
      : 'Without it the credentials are good only until the instance restarts. '
        + 'Set TRYCORD_TURN_SECRET.'),
  ];

  return card({
    label: 'The STUN and TURN stack',
    glyph: 'server',
    body: el('div', { class: 'fold' }, rows),
  });
}

// What the provider is doing, and what it is waiting for.
//
// The result of the last check is kept here rather than in the button that
// made it, so a repaint - which happens whenever something is saved - does not
// take the answer with it.
function diagnosticsSection(report, lastCheck, onChecked) {
  const body = el('div', { class: 'fold' });
  const result = el('p', { class: 'settings-note', role: 'status' });

  const paint = () => {
    const rows = [];
    for (const provider of report.providers) {
      const described = stateOf(provider.state);
      rows.push(el('div', { class: 'settings-item' },
        el('div', { class: 'settings-item-main' },
          el('p', { class: 'settings-item-label' }, provider.label,
            stateChip(provider.state),
            provider.inForce ? el('span', { class: 'chip chip--quiet' }, 'in force') : null),
          el('p', { class: 'settings-note' }, described.meaning),
          provider.missing.length
            ? el('p', { class: 'settings-note' }, 'Missing: ' + provider.missing.join('; ') + '.')
            : null,
          provider.check
            ? el('p', { class: 'settings-note' }, provider.check.detail)
            : null),
        el('div', { class: 'settings-item-control' },
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            'aria-label': 'Test the connection to ' + provider.label,
            onClick: async () => {
              try {
                const answer = await checkProvider(provider.id);
                onChecked(answer);
              } catch (e) {
                result.textContent = 'The check could not be made: ' + (e && e.message ? e.message : 'the request failed');
                errorToast(e);
              }
            },
          }, 'Test connection'))));
    }
    result.textContent = lastCheck
      ? (lastCheck.ok ? lastCheck.provider + ' answered. ' : lastCheck.provider + ' did not answer. ')
        + (lastCheck.detail || '')
      : '';
    body.replaceChildren(el('div', { class: 'fold' }, rows), result);
  };
  paint();

  return card({ label: 'Diagnostics', glyph: 'activity', body });
}

export function adminVoice() {
  const stage = el('div', { class: 'fold fold--tight' });
  let report = null;
  // The answer to the last connectivity check, kept here so that a repaint
  // does not take it away.
  let lastCheck = null;

  const refresh = async () => {
    try {
      report = await readProviders();
      paint();
    } catch (e) {
      stage.replaceChildren(fold([fault(e, refresh)]));
    }
  };

  const paint = () => {
    if (!report) return;

    const picker = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Media provider' });
    for (const provider of report.providers) {
      picker.appendChild(el('button', {
        class: 'segmented-item',
        type: 'button',
        'aria-selected': provider.inForce ? 'true' : 'false',
        'aria-label': 'Use the ' + provider.label + ' provider',
        onClick: async () => {
          if (provider.inForce) return;
          try {
            await saveSettings({ 'voice.provider': provider.id });
            toast('The ' + provider.label + ' provider is in force');
            await refresh();
          } catch (e) { errorToast(e); }
        },
      }, provider.label));
    }

    const inForce = report.providers.find((provider) => provider.inForce) || report.providers[0];

    stage.replaceChildren(
      card({
        label: 'Provider',
        glyph: 'volume',
        note: inForce ? inForce.label : '',
        body: el('div', { class: 'fold' },
          picker,
          el('p', { class: 'settings-note' }, inForce ? inForce.summary : ''),
          inForce && inForce.missing.length
            ? el('p', { class: 'settings-note' }, 'Missing: ' + inForce.missing.join('; ') + '.')
            : null),
      }),
      sharedSection(report, refresh),
      providerSection(inForce, refresh),
      stackSection(report),
      diagnosticsSection(report, lastCheck, (answer) => {
        lastCheck = answer;
        paint();
      }),
    );
  };

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Voice and video',
        lede: 'The path a call takes, and the settings that path needs.',
      }),
      stage,
    ]),
    onMount: async () => {
      stage.replaceChildren(hold('Reading the voice configuration'));
      await refresh();
    },
    cleanup() {},
  };
}

export default { adminVoice };
