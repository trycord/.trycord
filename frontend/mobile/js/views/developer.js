// The developer platform, on a phone.
//
// The same two things the desk has: the API keys a person holds, and the bot
// applications of a community. A phone is not a smaller desk, so the shape is
// different - a list under each section, and a sheet for anything that has to
// be read properly or answered.
//
// A secret is shown once. The server keeps a hash and nothing else, so the
// sheet that shows a secret says so, offers the value in a form that can be
// copied, and does not pretend it can be fetched again later.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { State, refreshServers } from '../../../packages/store.js';
import { request } from '../../../packages/api.js';
import { empty, failure, loading } from '../components.js';
import { screen, section, actions, primaryButton, ghostButton, field, textInput, textArea, select, notice } from './util.js';
import { sheet, confirm, toast } from '../ui.js';
import { copyText } from '../clipboard.js';

// -- the endpoints -------------------------------------------------------------

const V1 = '/api/v1';

function pathId(value) {
  return encodeURIComponent(String(value || ''));
}

const readKeys = () => request('GET', V1 + '/keys');
const createKey = (body) => request('POST', V1 + '/keys', { body });
const rotateKey = (keyId, body) => request('POST', V1 + '/keys/' + pathId(keyId) + '/rotate', { body });
const revokeKey = (keyId, body) => request('POST', V1 + '/keys/' + pathId(keyId) + '/revoke', { body });
const keyUsage = (keyId) => request('GET', V1 + '/keys/' + pathId(keyId) + '/usage?minutes=1440');
const readScopes = () => request('GET', V1 + '/scopes');
const readApplications = (serverId) => request('GET', V1 + '/communities/' + pathId(serverId) + '/applications');
const createApplication = (serverId, body) => request('POST', V1 + '/communities/' + pathId(serverId) + '/applications', { body });
const rotateApplicationToken = (serverId, applicationId) => request('POST', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/rotate-token');
const revokeApplication = (serverId, applicationId, body) => request('POST', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/revoke', { body });
const readCommands = (serverId, applicationId) => request('GET', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/commands');
const putCommand = (serverId, applicationId, body) => request('PUT', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/commands', { body });
const deleteCommand = (serverId, applicationId, commandId) => request('DELETE', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/commands/' + pathId(commandId));

// -- the shared pieces ---------------------------------------------------------

// A secret, shown once. The server has already thrown the only copy it had
// away by the time this is called.
function secretSheet(secret, title, sub) {
  const value = String(secret || '');
  const copy = el('button', {
    class: 'm-btn m-btn--block', type: 'button',
    onClick: () => copyText(value, 'The secret'),
  }, 'Copy it');
  const done = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'I have it');
  const layer = sheet({
    title: title,
    body: el('div', { class: 'm-stack' },
      notice({
        tone: 'warning',
        title: 'Copy it now',
        text: 'This is the only time it is shown. The server keeps a hash and nothing else, '
          + 'so it cannot be fetched again. If it is lost, rotate the key to get a new one.',
      }),
      el('code', { class: 'm-secret' }, value)),
    footer: el('div', { class: 'm-actions' }, copy, done),
  });
  done.addEventListener('click', () => layer.close());
  return layer;
}

// The scopes a credential may carry, as the server groups them.
function scopeChoices(groups) {
  const boxes = new Map();
  const list = el('div', { class: 'm-stack' });
  for (const group of groups || []) {
    list.appendChild(el('p', { class: 'm-eyebrow' }, group.name));
    for (const scope of group.scopes || []) {
      const box = el('input', {
        class: 'm-check', type: 'checkbox', value: scope.name,
        'aria-label': 'Grant ' + scope.name,
      });
      boxes.set(scope.name, box);
      list.appendChild(el('label', { class: 'm-check-row' },
        box,
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, scope.name),
          el('span', { class: 'm-row__sub' }, scope.description || ''))));
    }
  }
  return { list, boxes };
}

function chosenScopes(boxes) {
  return [...boxes.entries()].filter((entry) => entry[1].checked).map((entry) => entry[0]);
}

// -- the keys -------------------------------------------------------------------

function createKeySheet(onDone) {
  const body = el('div', { class: 'm-stack' });
  const status = el('p', { class: 'm-form-error', role: 'status' });
  const make = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button', disabled: true }, 'Create it');
  const layer = sheet({
    title: 'Create an API key',
    body: el('div', { class: 'm-stack' }, body, status),
    footer: el('div', { class: 'm-actions' }, make),
  });

  const nameControl = textInput({ placeholder: 'What this integration is for' });
  const expiresControl = textInput({ type: 'datetime-local' });
  let boxes = new Map();

  body.appendChild(loading('Reading the scopes'));
  readScopes().then((answer) => {
    const picker = scopeChoices((answer && answer.groups) || []);
    boxes = picker.boxes;
    clear(body);
    body.appendChild(el('div', { class: 'm-stack' },
      field({ label: 'The name of the key', control: nameControl }),
      field({ label: 'When it stops working', control: expiresControl }),
      el('p', { class: 'm-eyebrow' }, 'The scopes it carries'),
      picker.list));
    make.disabled = false;
  }).catch((error) => {
    clear(body);
    body.appendChild(failure(error, null));
  });

  make.addEventListener('click', async () => {
    if (!nameControl.value.trim()) {
      status.textContent = 'A key needs a name, so you can tell it apart later.';
      return;
    }
    make.disabled = true;
    status.textContent = '';
    try {
      const answer = await createKey({
        name: nameControl.value.trim(),
        scopes: chosenScopes(boxes),
        expiresAt: expiresControl.value ? new Date(expiresControl.value).toISOString() : undefined,
      });
      layer.close();
      secretSheet(answer && answer.secret, 'Your new key',
        'This is the only time the secret is shown. The server keeps a hash and nothing else.');
      if (onDone) onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The key was not made.';
      make.disabled = false;
    }
  });

  return layer;
}

function rotateKeySheet(key, onDone) {
  const overlapControl = select({
    choices: [
      { value: '0', label: 'It stops working at once' },
      { value: '300', label: 'It keeps working for 5 minutes' },
      { value: '900', label: 'It keeps working for 15 minutes' },
    ],
  });
  const go = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Rotate it');
  const layer = sheet({
    title: 'Rotate ' + (key.name || 'this key'),
    body: el('div', { class: 'm-stack' },
      field({ label: 'How long the previous secret keeps working', control: overlapControl }),
      el('p', { class: 'm-lede' },
        'The key keeps its name, its id and its scopes. The secret changes.')),
    footer: el('div', { class: 'm-actions' }, go),
  });

  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const answer = await rotateKey(key.id, { overlapSeconds: Number(overlapControl.value) });
      layer.close();
      secretSheet(answer && answer.secret, 'The new secret',
        answer && answer.previousSecretExpiresAt
          ? 'The previous secret stops working when the overlap ends.'
          : 'This is the only time the secret is shown.');
      if (onDone) onDone();
    } catch (error) {
      toast(error.message, { type: 'error' });
      go.disabled = false;
    }
  });

  return layer;
}

function keyReportSheet(key) {
  const body = el('div', { class: 'm-stack' });
  sheet({ title: (key.name || 'This key') + ' at work', body });
  body.appendChild(loading('Reading the report'));
  keyUsage(key.id).then((answer) => {
    const totals = (answer && answer.totals) || {};
    const byRoute = (answer && answer.byRoute) || [];
    clear(body);
    body.appendChild(el('div', { class: 'm-stat-row' },
      el('div', { class: 'm-stat' },
        el('div', { class: 'm-stat__value' }, String(totals.requests || 0)),
        el('div', { class: 'm-stat__label' }, 'Requests')),
      el('div', { class: 'm-stat' },
        el('div', { class: 'm-stat__value' }, String(totals.succeeded || 0)),
        el('div', { class: 'm-stat__label' }, 'That worked')),
      el('div', { class: 'm-stat' },
        el('div', { class: 'm-stat__value' },
          String((totals.clientErrors || 0) + (totals.serverErrors || 0))),
        el('div', { class: 'm-stat__label' }, 'That failed'))));
    if (!byRoute.length) {
      body.appendChild(el('p', { class: 'm-lede' }, 'It has made no requests.'));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const entry of byRoute) {
      list.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, entry.route),
          el('span', { class: 'm-row__sub' }, entry.succeeded + ' worked, '
            + ((entry.clientErrors || 0) + (entry.serverErrors || 0)) + ' failed')),
        el('span', { class: 'm-row__side' },
          el('span', { class: 'm-chip' }, entry.requests + ' requests'))));
    }
    body.appendChild(list);
  }).catch((error) => {
    clear(body);
    body.appendChild(failure(error, null));
  });
}

function keySheet(key, onDone) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({ title: key.name || key.id, body });
  const scopes = Array.isArray(key.scopes) ? key.scopes : [];

  body.appendChild(notice({
    tone: key.status === 'active' ? 'info' : 'warning',
    title: 'It is ' + (key.status || 'unknown'),
    text: key.id + (key.lastUsedAt ? ' · last used ' + key.lastUsedAt : ' · never used'),
  }));

  const list = el('div', { class: 'm-list' });
  for (const scope of scopes) {
    list.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, scope))));
  }
  body.appendChild(el('p', { class: 'm-eyebrow' }, 'The scopes it carries'));
  body.appendChild(scopes.length ? list : el('p', { class: 'm-lede' }, 'None.'));

  const buttons = [];
  if (key.status === 'active') {
    buttons.push(ghostButton('Its work', () => keyReportSheet(key)));
    buttons.push(ghostButton('Rotate', () => rotateKeySheet(key, onDone)));
    buttons.push(el('button', {
      class: 'm-btn m-btn--block m-btn--danger', type: 'button',
      'aria-label': 'Revoke ' + (key.name || key.id),
      onClick: async () => {
        const yes = await confirm({
          title: 'Revoke this key?',
          text: 'Every secret this key ever issued stops working at once. An integration using it will '
            + 'start being refused, and the key keeps its name and its place in the list.',
          confirmLabel: 'Revoke it',
          danger: true,
        });
        if (!yes) return;
        try {
          await revokeKey(key.id, { reason: 'revoked by its owner' });
          toast('Revoked');
          layer.close();
          onDone();
        } catch (error) { toast(error.message, { type: 'error' }); }
      },
    }, 'Revoke it'));
  }
  if (buttons.length) {
    body.appendChild(el('div', { class: 'm-actions m-actions--wrap' }, buttons));
  }
  return layer;
}

async function keysSection(host, reload) {
  clear(host);
  host.appendChild(loading('Reading the keys'));
  try {
    const answer = await readKeys();
    const keys = (answer && answer.keys) || [];
    clear(host);
    if (!keys.length) {
      host.appendChild(empty({
        icon: 'key',
        title: 'No keys yet',
        text: 'An integration that speaks for you needs a key. Make one, and give it only the scopes it needs.',
        action: el('button', {
          class: 'm-btn m-btn--primary', type: 'button',
          'aria-label': 'Create an API key',
          onClick: () => createKeySheet(reload),
        }, 'Create a key'),
      }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const key of keys) {
      const scopes = Array.isArray(key.scopes) ? key.scopes : [];
      list.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => keySheet(key, reload),
      },
      el('span', { class: 'm-row__lead' }, icon('key', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, key.name || key.id),
        el('span', { class: 'm-row__sub truncate' }, scopes.length + ' scope'
          + (scopes.length === 1 ? '' : 's'))),
      el('span', { class: 'm-row__side' },
        el('span', { class: 'm-chip' }, key.status || 'unknown'))));
    }
    host.appendChild(section('Your API keys', list, {
      action: el('button', {
        class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
        'aria-label': 'Create an API key',
        onClick: () => createKeySheet(reload),
      }, 'Create a key'),
    }));
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => keysSection(host, reload)));
  }
}

// -- the applications -------------------------------------------------------------

function commandSheet(serverId, application, command, onDone) {
  const body = el('div', { class: 'm-stack' });
  const status = el('p', { class: 'm-form-error', role: 'status' });
  const save = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Save it');
  const layer = sheet({
    title: command ? 'Change /' + command.name : 'Register a command',
    body: el('div', { class: 'm-stack' }, body, status),
    footer: el('div', { class: 'm-actions' }, save),
  });

  const nameControl = textInput({ label: 'The name of the command', value: command ? command.name : '' });
  const descriptionControl = textInput({
    value: command && command.description ? command.description : '',
  });
  const responseControl = textArea({ value: command ? command.response : '' });
  const optionsControl = textArea({
    value: command && command.options && command.options.length ? JSON.stringify(command.options) : '',
  });

  body.appendChild(el('div', { class: 'm-stack' },
    field({ label: 'The name of the command', control: nameControl }),
    field({ label: 'What the command does', control: descriptionControl }),
    field({ label: 'The answer it gives', control: responseControl }),
    field({ label: 'The options it takes, as JSON', control: optionsControl })));

  save.addEventListener('click', async () => {
    save.disabled = true;
    status.textContent = '';
    let parsed = [];
    if (optionsControl.value.trim()) {
      try {
        parsed = JSON.parse(optionsControl.value);
      } catch {
        status.textContent = 'The options are not JSON.';
        save.disabled = false;
        return;
      }
    }
    try {
      await putCommand(serverId, application.id, {
        name: nameControl.value.trim(),
        description: descriptionControl.value.trim() || undefined,
        response: responseControl.value,
        options: parsed,
      });
      layer.close();
      toast('Saved');
      if (onDone) onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The command was not saved.';
      save.disabled = false;
    }
  });

  return layer;
}

function commandsSheet(serverId, application, onDone) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({
    title: 'The commands of ' + application.name,
    body,
    footer: actions([
      primaryButton('Register a command', () => commandSheet(serverId, application, null, onDone)),
    ]),
  });
  body.appendChild(loading('Reading the commands'));
  readCommands(serverId, application.id).then((answer) => {
    const commands = (answer && answer.commands) || [];
    clear(body);
    if (!commands.length) {
      body.appendChild(el('p', { class: 'm-lede' }, 'It answers no commands yet.'));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const command of commands) {
      list.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, '/' + command.name),
          el('span', { class: 'm-row__sub' }, command.description || command.response)),
        el('span', { class: 'm-row__side' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Change the command ' + command.name,
            onClick: () => commandSheet(serverId, application, command, onDone),
          }, 'Change'),
          el('button', {
            class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
            'aria-label': 'Remove the command ' + command.name,
            onClick: async () => {
              const yes = await confirm({
                title: 'Remove this command?',
                text: 'The application stops answering /' + command.name + '.',
                confirmLabel: 'Remove it',
                danger: true,
              });
              if (!yes) return;
              try {
                await deleteCommand(serverId, application.id, command.id);
                toast('Removed');
                onDone();
              } catch (error) { toast(error.message, { type: 'error' }); }
            },
          }, 'Remove'))));
    }
    body.appendChild(list);
  }).catch((error) => {
    clear(body);
    body.appendChild(failure(error, null));
  });
}

function createApplicationSheet(serverId, onDone) {
  const body = el('div', { class: 'm-stack' });
  const status = el('p', { class: 'm-form-error', role: 'status' });
  const make = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button', disabled: true }, 'Create it');
  const layer = sheet({
    title: 'Create a bot application',
    body: el('div', { class: 'm-stack' }, body, status),
    footer: el('div', { class: 'm-actions' }, make),
  });

  const nameControl = textInput({});
  const descriptionControl = textInput({});
  let boxes = new Map();

  body.appendChild(loading('Reading the scopes'));
  readScopes().then((answer) => {
    const picker = scopeChoices((answer && answer.groups) || []);
    boxes = picker.boxes;
    clear(body);
    body.appendChild(el('div', { class: 'm-stack' },
      field({ label: 'The name of the application', control: nameControl }),
      field({ label: 'What it does', control: descriptionControl }),
      el('p', { class: 'm-eyebrow' }, 'The scopes its credential carries'),
      picker.list));
    make.disabled = false;
  }).catch((error) => {
    clear(body);
    body.appendChild(failure(error, null));
  });

  make.addEventListener('click', async () => {
    if (!nameControl.value.trim()) {
      status.textContent = 'An application needs a name.';
      return;
    }
    make.disabled = true;
    status.textContent = '';
    try {
      const answer = await createApplication(serverId, {
        name: nameControl.value.trim(),
        description: descriptionControl.value.trim() || undefined,
        scopes: chosenScopes(boxes),
      });
      layer.close();
      secretSheet(answer && answer.token, 'The token of ' + nameControl.value.trim(),
        'This is the only time the token is shown. It is the application\'s credential: there is no '
        + 'account behind it and no password to lose.');
      if (onDone) onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The application was not created.';
      make.disabled = false;
    }
  });

  return layer;
}

function applicationSheet(serverId, application, onDone) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({ title: application.name, body });
  const credential = application.credential || {};
  const scopes = Array.isArray(credential.scopes) ? credential.scopes : [];

  body.appendChild(notice({
    tone: application.status === 'active' ? 'info' : 'warning',
    title: 'It is ' + (application.status || 'unknown'),
    text: 'An application posts as itself. It has no login, no session and no password - its token '
      + 'is its credential, and the scopes on that credential say what it may do.',
  }));

  const list = el('div', { class: 'm-list' });
  for (const scope of scopes) {
    list.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, scope))));
  }
  body.appendChild(el('p', { class: 'm-eyebrow' }, 'The scopes it carries'));
  body.appendChild(scopes.length ? list : el('p', { class: 'm-lede' }, 'None.'));

  const buttons = [ghostButton('Commands', () => commandsSheet(serverId, application, onDone))];
  if (application.status === 'active') {
    buttons.push(ghostButton('New token', async () => {
      const yes = await confirm({
        title: 'Issue a new token?',
        text: 'The application holds one token. The old one stops working at once, so the integration '
          + 'has to be given the new one before it is next used.',
        confirmLabel: 'Issue it',
      });
      if (!yes) return;
      try {
        const answer = await rotateApplicationToken(serverId, application.id);
        secretSheet(answer && answer.token, 'The new token of ' + application.name,
          'This is the only time the token is shown. The previous one has stopped working.');
        onDone();
      } catch (error) { toast(error.message, { type: 'error' }); }
    }));
    buttons.push(el('button', {
      class: 'm-btn m-btn--block m-btn--danger', type: 'button',
      'aria-label': 'Revoke ' + application.name,
      onClick: async () => {
        const yes = await confirm({
          title: 'Revoke this application?',
          text: 'Its token is burned at once and the application is disabled. It cannot be brought '
            + 'back with the same token.',
          confirmLabel: 'Revoke it',
          danger: true,
        });
        if (!yes) return;
        try {
          await revokeApplication(serverId, application.id, { reason: 'revoked by an operator' });
          toast('Revoked');
          layer.close();
          onDone();
        } catch (error) { toast(error.message, { type: 'error' }); }
      },
    }, 'Revoke it'));
  }
  body.appendChild(el('div', { class: 'm-actions m-actions--wrap' }, buttons));
  return layer;
}

async function applicationsSection(host, reload) {
  clear(host);
  host.appendChild(loading('Reading the applications'));
  const communities = State.servers.filter((server) => {
    const perms = server.permissions || [];
    return perms.indexOf('*') !== -1 || perms.indexOf('MANAGE_SERVER') !== -1 || server.is_owner;
  });
  if (!communities.length) {
    host.appendChild(empty({
      icon: 'bot',
      title: 'No community you manage',
      text: 'An application belongs to a community, and only somebody who manages that community '
        + 'may make one.',
    }));
    return;
  }
  const pickerControl = select({
    choices: communities.map((server) => ({ value: server.id, label: server.name })),
  });
  pickerControl.value = communities[0].id;
  const list = el('div', { class: 'm-list' });

  async function paint() {
    clear(list);
    list.appendChild(loading('Reading the applications'));
    try {
      const answer = await readApplications(pickerControl.value);
      const applications = (answer && answer.applications) || [];
      clear(list);
      if (!applications.length) {
        list.appendChild(el('p', { class: 'm-lede' }, 'It has no applications yet.'));
        return;
      }
      for (const application of applications) {
        list.appendChild(el('button', {
          class: 'm-row', type: 'button',
          onClick: () => applicationSheet(pickerControl.value, application, () => paint()),
        },
        el('span', { class: 'm-row__lead' }, icon('bot', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, application.name),
          el('span', { class: 'm-row__sub truncate' }, application.description
            || 'It posts as itself, with no account behind it.')),
        el('span', { class: 'm-row__side' },
          el('span', { class: 'm-chip' }, application.status || 'unknown'))));
      }
    } catch (error) {
      clear(list);
      list.appendChild(failure(error, paint));
    }
  }

  pickerControl.addEventListener('change', paint);
  clear(host);
  host.appendChild(section('The applications of this community', el('div', { class: 'm-stack' },
    field({ label: 'The community', control: pickerControl }),
    list), {
    action: el('button', {
      class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
      'aria-label': 'Create a bot application',
      onClick: () => createApplicationSheet(pickerControl.value, paint),
    }, 'Create an application'),
  }));
  await paint();
}

// -- the screen -------------------------------------------------------------------

const SECTIONS = [
  { id: 'keys', label: 'API keys' },
  { id: 'applications', label: 'Applications' },
];

export function renderDeveloper(ctx) {
  const host = el('div', { class: 'm-stack' });
  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Developer console sections' });
  let current = 'keys';

  function paintStrip() {
    clear(strip);
    for (const section of SECTIONS) {
      strip.appendChild(el('button', {
        class: 'm-seg__item' + (section.id === current ? ' is-active' : ''),
        type: 'button', role: 'tab',
        'aria-selected': section.id === current ? 'true' : 'false',
        'aria-label': 'Show the ' + section.label.toLowerCase() + ' section',
        onClick: () => show(section.id),
      }, section.label));
    }
  }

  async function show(id) {
    current = id;
    paintStrip();
    if (id === 'keys') await keysSection(host, () => show('keys'));
    else await applicationsSection(host, () => show('applications'));
  }

  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Developer'),
      el('div', { class: 'm-hero__sub' },
        'The credentials that speak for you, and the applications that speak for themselves.')),
    strip,
    host,
  );

  return {
    node,
    head: { title: 'Developer' },
    onMount: async () => {
      if (!State.servers.length) {
        try { await refreshServers(); } catch { /* the note below says what is missing */ }
      }
      paintStrip();
      await show(current);
    },
  };
}

export default { renderDeveloper };
