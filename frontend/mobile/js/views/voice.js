// Voice and video on the phone.
//
// The same section the desktop console shows: the provider is chosen first,
// then only that provider's fields, and then the controls every provider
// shares. The rules - which providers exist, what the states mean - come from
// frontend/packages/voice.js, so the two consoles cannot drift apart.
//
// A credential is managed rather than typed: the phone is told whether one is
// set and never what it is. It can be replaced or cleared, and both are
// deliberate.

import { el } from '../../../packages/dom.js';
import { request } from '../../../packages/api.js';
import { toast, confirm } from '../ui.js';
import { loading, failure, chip } from '../components.js';
import { section, field, textInput, actions, primaryButton, ghostButton, notice } from './util.js';
import { SHARED_CONTROLS, stateOf, providerLabel, sourceLabel } from '../../../packages/voice.js';

const PROVIDERS_PATH = '/api/voice/providers';
const SETTINGS_PATH = '/api/admin/settings';

async function readProviders() {
  return request('GET', PROVIDERS_PATH);
}

async function saveSettings(values) {
  return request('PUT', SETTINGS_PATH, { body: values });
}

async function checkProvider(providerId) {
  return request('POST', PROVIDERS_PATH + '/' + encodeURIComponent(providerId) + '/check', { body: {} });
}

// A switch, drawn the way this client draws switches.
function switchControl(initial, onChange, label) {
  let value = !!initial;
  const control = el('button', {
    class: 'm-switch' + (value ? ' is-on' : ''), type: 'button', role: 'switch',
    'aria-checked': String(value), 'aria-label': label || 'Toggle',
  });
  control.addEventListener('click', () => {
    value = !value;
    control.setAttribute('aria-checked', String(value));
    control.classList.toggle('is-on', value);
    onChange(value);
  });
  return control;
}

// The provider in force, and the other two.
function providerChoice(report, onChanged) {
  const list = el('div', { class: 'm-list', role: 'radiogroup', 'aria-label': 'Media provider' });

  for (const provider of report.providers) {
    const active = provider.inForce;
    list.appendChild(el('button', {
      class: 'm-row' + (active ? ' is-current' : ''),
      type: 'button', role: 'radio', 'aria-checked': String(active),
      onClick: async () => {
        if (active) return;
        try {
          await saveSettings({ 'voice.provider': provider.id });
          toast('The ' + provider.label + ' provider is in force');
          onChanged();
        } catch (error) {
          toast((error && error.message) || 'The provider could not be changed');
        }
      },
    },
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title' }, provider.label),
      el('span', { class: 'm-row__sub' }, provider.summary)),
    el('span', { class: 'm-row__actions' }, chip(stateOf(provider.state).label))));
  }

  return section('Provider', list, { note: 'Each provider keeps its own settings.' });
}

// The controls every provider shares.
function sharedSection(report, onChanged) {
  const rows = [];

  for (const control of SHARED_CONTROLS) {
    const current = control.key === 'voice.enabled'
      ? report.enabled
      : control.key === 'voice.screenSharing'
        ? report.screenSharing
        : report.stageChannels;

    rows.push(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, control.label),
        el('span', { class: 'm-row__sub' }, control.description)),
      el('span', { class: 'm-row__actions' },
        switchControl(current, async (on) => {
          // Turning voice on is asked for. It changes what this instance
          // offers every member, and the provider has to be able to carry a
          // call. Turning it off is immediate: that is the safe direction,
          // and asking about it would only be friction.
          if (on && control.key === 'voice.enabled') {
            const yes = await confirm({
              title: 'Turn voice on?',
              text: 'Every member of this instance will be able to join a voice channel. '
                + 'The ' + providerLabel(report.active) + ' provider has to be able to carry a call, '
                + 'so check that it answers before you rely on it.',
              confirmLabel: 'Turn voice on',
            });
            if (!yes) {
              if (onChanged) onChanged();
              return;
            }
          }
          try {
            await saveSettings({ [control.key]: on });
            onChanged();
          } catch (error) {
            toast((error && error.message) || 'The setting could not be saved');
          }
        }, control.label))));
  }

  const limitKey = 'voice.' + report.active + '.maxParticipants';
  const limit = textInput({
    type: 'number',
    value: String(report.maxParticipants),
    name: 'participants',
  });
  rows.push(el('div', { class: 'm-row' },
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title' }, 'Participants per channel'),
      el('span', { class: 'm-row__sub' },
        'On the ' + providerLabel(report.active) + ' provider. A full channel refuses rather than dropping someone.')),
    el('span', { class: 'm-row__actions' }, limit)));
  rows.push(actions([
    primaryButton('Save the limit', async () => {
      const parsed = parseInt(limit.value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        toast('The limit must be a whole number of at least one');
        return;
      }
      try {
        await saveSettings({ [limitKey]: parsed });
        toast('The participant limit is saved');
        onChanged();
      } catch (error) {
        toast((error && error.message) || 'The limit could not be saved');
      }
    }, { sm: true }),
  ]));

  return section('Shared by every provider', el('div', { class: 'm-stack' }, rows));
}

// The fields of the provider in force, and nothing else.
function providerFields(report, onChanged) {
  const provider = report.providers.find((entry) => entry.inForce) || report.providers[0];
  const rows = [];

  for (const item of provider.fields) {
    const control = textInput({
      type: item.type === 'integer' ? 'number' : 'text',
      value: item.value === null || item.value === undefined ? '' : String(item.value),
      name: item.key,
    });
    rows.push(field({
      label: item.label + ' (' + sourceLabel(item) + ')',
      control,
      note: item.description,
    }));
    rows.push(actions([
      primaryButton('Save ' + item.label, async () => {
        let value = control.value;
        if (item.type === 'integer') {
          const parsed = parseInt(value, 10);
          if (!Number.isFinite(parsed)) {
            toast('That has to be a whole number');
            return;
          }
          value = parsed;
        } else if (item.type === 'list') {
          value = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
        }
        try {
          await saveSettings({ [item.key]: value });
          toast(item.label + ' saved');
          onChanged();
        } catch (error) {
          toast((error && error.message) || 'The setting could not be saved');
        }
      }, { sm: true }),
    ]));
  }

  for (const secret of provider.secrets) {
    const control = textInput({
      type: 'password',
      value: '',
      placeholder: secret.set ? 'Set — type to replace' : 'Not set',
      name: secret.key,
    });
    rows.push(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, secret.label),
        el('span', { class: 'm-row__sub' },
          (secret.set ? 'Set' : 'Not set') + ' · ' + (secret.description || '')))));
    rows.push(field({ label: 'New value for ' + secret.label, control }));
    rows.push(actions([
      primaryButton('Replace', async () => {
        if (!String(control.value || '').trim()) {
          toast('Type a value first');
          return;
        }
        try {
          await saveSettings({ [secret.key]: control.value });
          control.value = '';
          toast(secret.label + ' replaced');
          onChanged();
        } catch (error) {
          toast((error && error.message) || 'The credential could not be replaced');
        }
      }, { sm: true }),
      ghostButton('Clear', async () => {
        try {
          await saveSettings({ [secret.key]: null });
          control.value = '';
          toast(secret.label + ' cleared');
          onChanged();
        } catch (error) {
          toast((error && error.message) || 'The credential could not be cleared');
        }
      }),
    ]));
  }

  return section(provider.label, el('div', { class: 'm-stack' }, [
    notice({ tone: 'info', title: provider.label, text: provider.note }),
    ...rows,
  ]));
}

// What each provider is doing, and whether the other end answers.
function diagnosticsSection(report, onChanged) {
  const rows = [];

  for (const provider of report.providers) {
    const described = stateOf(provider.state);
    rows.push(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, provider.label + ' · ' + described.label),
        el('span', { class: 'm-row__sub' }, described.meaning),
        provider.missing.length
          ? el('span', { class: 'm-row__sub' }, 'Missing: ' + provider.missing.join('; ') + '.')
          : null,
        provider.check ? el('span', { class: 'm-row__sub' }, provider.check.detail) : null),
      el('span', { class: 'm-row__actions' },
        ghostButton('Test', async () => {
          try {
            const answer = await checkProvider(provider.id);
            toast((answer.ok ? provider.label + ' answered. ' : provider.label + ' did not answer. ')
              + (answer.detail || ''));
            onChanged();
          } catch (error) {
            toast((error && error.message) || 'The check could not be made');
          }
        }))));
  }

  return section('Diagnostics', el('div', { class: 'm-stack' }, rows));
}

// The body of the Voice and video section.
//
// The mobile administration shell mounts this in place of one of its own
// sections, so it returns the body rather than a whole screen.
export function voiceBody() {
  const host = el('div', { class: 'm-stack' });

  async function load() {
    host.replaceChildren(loading('Reading the voice configuration'));
    try {
      const report = await readProviders();
      host.replaceChildren(
        providerChoice(report, load),
        sharedSection(report, load),
        providerFields(report, load),
        diagnosticsSection(report, load),
      );
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  load();
  return host;
}

export default { voiceBody };
