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
  SHARED_CONTROLS, providerLabel, stateOf, sourceLabel, fieldValue, confirmedBody,
} from '../../packages/voice.js';

const PROVIDERS_PATH = '/api/voice/providers';
// The voice console's own settings.
//
// The voice settings are changed here and nowhere else. The general
// Configuration page shows them read-only and says where they are changed,
// and a write that arrives there for one of them is refused - so this is the
// path that actually works.
const SETTINGS_PATH = '/api/admin/voice/settings';
// The ticket that opens the voice process's own page on the machine.
const LOCAL_TICKET_PATH = '/api/admin/voice/settings/local-ticket';

// The whole picture: the provider in force, the shared controls, and every
// provider with its own fields and its own state.
async function readProviders() {
  return request('GET', PROVIDERS_PATH);
}

async function saveSettings(values) {
  return request('PUT', SETTINGS_PATH, { body: confirmedBody(values) });
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
      body: secret.key === 'voice.mesh.stunkey'
        ? 'The key will be removed. The credentials minted under it stop being accepted, '
          + 'and the instance makes a key of its own until a new one is set.'
        : 'The credential will be removed. A provider that needs it cannot carry a call until a new one is set.',
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

  return card({
    label: 'What voice offers', glyph: 'settings',
    body: el('div', { class: 'fold' }, rows),
  });
}

// The participant limit.
//
// It is a setting of the provider in force rather than of the instance, so
// it belongs with the provider's own fields and not with the three switches
// every provider shares.
function limitSection(report, onSaved) {
  const rows = [];

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

  return card({
    label: 'Participants per channel', glyph: 'users',
    body: el('div', { class: 'fold' }, rows),
  });
}

// The fields of the provider in force, and nothing else.
function providerSection(provider, onSaved) {
  const rows = [];
  if (!provider) {
    return card({
      label: 'The provider in force', glyph: 'volume',
      body: el('p', { class: 'settings-note' },
        'The server named no provider, so there is nothing to configure here.'),
    });
  }
  for (const field of provider.fields || []) rows.push(fieldRow(field, onSaved));
  for (const secret of provider.secrets || []) rows.push(secretRow(secret, onSaved));

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
      // Whether a client outside this instance can reach the address the
      // clients are given.
      //
      // A browser given `turn:127.0.0.1:3478` resolves that to the reader's
      // own machine, so the call can never be relayed - and a console that
      // said only "the service is listening" would be saying that about a
      // service nobody can reach.
      ok: stack.publishedIsReachable !== false,
      text: stack.advertised + (stack.publishedIsReachable === false ? ' (not reachable from a client)' : ''),
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
    for (const provider of (Array.isArray(report.providers) ? report.providers : [])) {
      const described = stateOf(provider.state);
      rows.push(el('div', { class: 'settings-item' },
        el('div', { class: 'settings-item-main' },
          el('p', { class: 'settings-item-label' }, provider.label,
            stateChip(provider.state),
            provider.inForce ? el('span', { class: 'chip chip--quiet' }, 'in force') : null),
          el('p', { class: 'settings-note' }, described.meaning),
          (provider.missing || []).length
            ? el('p', { class: 'settings-note' }, 'Missing: ' + provider.missing.join('; ') + '.')
            : null,
          provider.check
            ? el('p', { class: 'settings-note' }, provider.check.detail || '')
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

// The voice process's own page, on the loopback of this machine. It needs a
// ticket, and only an administrator can get one.
function localPageSection() {
  const open = el('button', {
    class: 'btn btn--primary btn--sm',
    type: 'button',
    onClick: async () => {
      try {
        const answer = await request('POST', LOCAL_TICKET_PATH, { body: {} });
        const tab = window.open(answer.url, '_blank', 'noopener');
        if (!tab) toast('The browser blocked the tab; allow popups for this site');
      } catch (e) { errorToast(e); }
    },
  }, 'Open the voice page');

  return card({
    label: 'The voice process',
    glyph: 'activity',
    body: el('div', { class: 'fold' },
      el('p', { class: 'settings-note' },
        'The voice process has a page of its own on this machine, on the loopback: it says whether '
        + 'the voice stack is working, it configures the relay, and it mints a credential. The page '
        + 'is opened with a ticket, so only an administrator gets in - and the ticket is good once.'),
      el('div', { class: 'settings-item-actions' }, open)),
  });
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
    for (const provider of (Array.isArray(report.providers) ? report.providers : [])) {
      picker.appendChild(el('button', {
        class: 'segmented-item',
        type: 'button',
        'aria-selected': provider.inForce ? 'true' : 'false',
        'aria-label': 'Use the ' + provider.label + ' provider',
        onClick: async () => {
          if (provider.inForce) return;
          // Choosing the provider is a consequential change: it decides
          // where the media of every call on this instance travels, and it
          // has to be said yes to rather than clicked past.
          const yes = await confirmDialog({
            title: 'Use the ' + provider.label + ' provider?',
            body: provider.inForce
              ? ''
              : 'Every call on this instance will take this path. '
                + (provider.missing && provider.missing.length
                  ? 'It is not ready yet: ' + provider.missing.join('; ') + '.'
                  : 'It is ready.'),
            confirmLabel: 'Use ' + provider.label,
          });
          if (!yes) return;
          try {
            await saveSettings({ 'voice.provider': provider.id });
            toast('The ' + provider.label + ' provider is in force');
            await refresh();
          } catch (e) { errorToast(e); }
        },
      }, provider.label));
    }

    const providers = Array.isArray(report.providers) ? report.providers : [];
    const inForce = providers.find((provider) => provider.inForce) || providers[0] || null;

    // The main section has four things in it: whether this instance offers
    // voice, which provider carries it, whether a member may share a screen,
    // and whether a community has stages. Everything else - the participant
    // limit, the provider's own fields, the relay itself, the diagnostics -
    // is behind "The details", so an administrator who only wants voice on
    // has four things to decide and not a page of networking.
    const details = el('details', { class: 'details' },
      el('summary', { class: 'details__summary' }, 'The details'),
      el('div', { class: 'details__body fold' },
        limitSection(report, refresh),
        providerSection(inForce, refresh),
        stackSection(report),
        localPageSection(),
        diagnosticsSection(report, lastCheck, (answer) => {
          lastCheck = answer;
          paint();
        })));

    stage.replaceChildren(
      card({
        label: 'The provider',
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
      details,
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
