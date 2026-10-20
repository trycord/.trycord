// The developer platform.
//
// Two things live here: the API keys a person holds, and the bot applications
// of a community.
//
// A key is a credential an integration uses instead of a human session. Its
// secret is shown exactly once, when the key is made or rotated, and never
// again - the server stores a hash, so there is nothing to show. The list
// carries the identity of a key and the scopes it holds, and never the secret.
//
// An application is not an account. It has no login, no session and no
// password, and it never needs one: its token is its credential, and the
// credential carries the scopes that say what it may do. It posts in its own
// name, as itself, and the console says so rather than letting it be mistaken
// for a person.
//
// The routes these screens use are not in the shared client yet, so they are
// called here through the shared request helper.

import { el } from '../../packages/dom.js';
import { State, refreshServers } from '../../packages/store.js';
import { icon } from '../../packages/icons.js';
import { formatDateTime } from '../../packages/locale.js';
import { card, row, blank, fault, fold, facts, head, hold, memo } from '../ui/page.js';
import { confirmDialog, openDialog, errorToast, toast } from '../ui/overlays.js';
import { copyText } from '../ui/clipboard.js';
import { request } from '../../packages/api.js';

// -- the endpoints ------------------------------------------------------------

const V1 = '/api/v1';

function pathId(value) {
  return encodeURIComponent(String(value || ''));
}

const readKeys = () => request('GET', V1 + '/keys');
const createKey = (body) => request('POST', V1 + '/keys', { body });
const rotateKey = (keyId, body) => request('POST', V1 + '/keys/' + pathId(keyId) + '/rotate', { body });
const revokeKey = (keyId, body) => request('POST', V1 + '/keys/' + pathId(keyId) + '/revoke', { body });
const keyUsage = (keyId, minutes) => request('GET', V1 + '/keys/' + pathId(keyId) + '/usage'
  + (minutes ? '?minutes=' + minutes : ''));
const keyHealth = (keyId, minutes) => request('GET', V1 + '/keys/' + pathId(keyId) + '/health'
  + (minutes ? '?minutes=' + minutes : ''));
const readScopes = () => request('GET', V1 + '/scopes');

const readApplications = (serverId) => request('GET', V1 + '/communities/' + pathId(serverId) + '/applications');
const createApplication = (serverId, body) => request('POST', V1 + '/communities/' + pathId(serverId) + '/applications', { body });
const rotateApplicationToken = (serverId, applicationId) => request('POST', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/rotate-token');
const revokeApplication = (serverId, applicationId, body) => request('POST', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/revoke', { body });
const applicationHealth = (serverId, applicationId) => request('GET', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/health');
const readCommands = (serverId, applicationId) => request('GET', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/commands');
const putCommand = (serverId, applicationId, body) => request('PUT', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/commands', { body });
const deleteCommand = (serverId, applicationId, commandId) => request('DELETE', V1 + '/communities/' + pathId(serverId) + '/applications/' + pathId(applicationId) + '/commands/' + pathId(commandId));

// -- the shared pieces ---------------------------------------------------------

// A secret, shown once.
//
// The server has already thrown the only copy it had away by the time this is
// called, so the dialog is the last chance to read it. It says so, it offers
// the value in a form that can be copied, and it does not let itself be
// dismissed by clicking outside.
function showSecret(secret, options) {
  const opts = options || {};
  const value = String(secret || '');
  const code = el('code', { class: 'keyblock' }, value);
  const copy = el('button', {
    class: 'btn btn--default btn--sm', type: 'button',
    onClick: () => copyText(value, 'The secret'),
  }, 'Copy it');
  const close = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'I have it');
  const dialog = openDialog({
    title: opts.title || 'Your secret',
    sub: opts.sub || 'This is the only time it is shown. It is not stored and cannot be recovered.',
    dismissable: false,
    body: el('div', { class: 'fold' },
      memo({
        tone: 'warning',
        title: 'Copy it now',
        text: 'The server keeps a hash of this and nothing else. Once this dialog is closed '
          + 'the secret cannot be shown again - if it is lost, rotate the key to get a new one.',
      }),
      code),
    foot: [copy, close],
  });
  close.addEventListener('click', () => dialog.close());
  return dialog;
}

// The scopes a key may hold, grouped the way the server groups them.
function scopePicker(groups) {
  const boxes = new Map();
  const list = el('div', { class: 'fold fold--tight' });
  for (const group of groups || []) {
    list.appendChild(el('p', { class: 'form-note' }, group.name));
    for (const scope of group.scopes || []) {
      const box = el('input', {
        type: 'checkbox',
        value: scope.name,
        'aria-label': 'Grant ' + scope.name,
      });
      boxes.set(scope.name, box);
      list.appendChild(el('label', { class: 'checkbox' },
        box,
        el('span', {},
          el('span', {}, scope.name),
          el('span', { class: 'form-note' }, ' ' + (scope.description || '')))));
    }
  }
  return { list, boxes };
}

function chosenScopes(boxes) {
  return [...boxes.entries()].filter((entry) => entry[1].checked).map((entry) => entry[0]);
}

function keyStateChip(status) {
  const value = String(status || '');
  if (value === 'active') return el('span', { class: 'chip chip--on' }, 'active');
  if (value === 'revoked') return el('span', { class: 'chip chip--warn' }, 'revoked');
  if (value === 'expired') return el('span', { class: 'chip chip--quiet' }, 'expired');
  return el('span', { class: 'chip chip--quiet' }, value);
}

// -- the keys -------------------------------------------------------------------

// Making a key: a name, the scopes it carries, and when it stops working.
function openCreateKey(onDone) {
  const body = el('div', { class: 'fold' });
  const status = el('p', { class: 'form-error', role: 'status' });
  const make = el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: true }, 'Create it');
  const dialog = openDialog({
    title: 'Create an API key',
    sub: 'A key is an integration speaking for you, with only the scopes you give it.',
    body: el('div', { class: 'fold' }, body, status),
    foot: [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      make,
    ],
  });

  const name = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The name of the key',
    placeholder: 'What this integration is for',
  });
  const expires = el('input', {
    class: 'input', type: 'datetime-local', 'aria-label': 'When the key stops working',
  });
  const limit = el('input', {
    class: 'input', type: 'number', min: '1', 'aria-label': 'Requests per minute the key may make',
  });

  let boxes = new Map();

  body.replaceChildren(hold('Reading the scopes'));
  readScopes().then((answer) => {
    const groups = (answer && answer.groups) || [];
    const picker = scopePicker(groups);
    boxes = picker.boxes;
    body.replaceChildren(el('div', { class: 'form-stack' },
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Name'),
        name),
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'It stops working'),
        expires),
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Requests per minute'),
        limit),
      el('p', { class: 'form-note' }, 'The scopes it carries:'),
      picker.list));
    make.disabled = false;
    name.focus();
  }).catch((error) => {
    body.replaceChildren(fault(error, null));
  });

  make.addEventListener('click', async () => {
    if (!name.value.trim()) {
      status.textContent = 'A key needs a name, so you can tell it apart later.';
      return;
    }
    make.disabled = true;
    status.textContent = '';
    try {
      const answer = await createKey({
        name: name.value.trim(),
        scopes: chosenScopes(boxes),
        expiresAt: expires.value ? new Date(expires.value).toISOString() : undefined,
        rateLimitPerMinute: limit.value ? Number(limit.value) : undefined,
      });
      dialog.close();
      showSecret(answer && answer.secret, {
        title: 'Your new key',
        sub: 'This is the only time the secret is shown. The server keeps a hash and nothing else, '
          + 'so it cannot be recovered.',
      });
      if (onDone) onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The key was not made.';
      make.disabled = false;
    }
  });

  return dialog;
}

// Rotating a key: the identity stays, the secret changes.
function openRotateKey(key, onDone) {
  const overlap = el('select', { class: 'input', 'aria-label': 'How long the previous secret keeps working' });
  overlap.appendChild(el('option', { value: '0' }, 'The previous secret stops working at once'));
  overlap.appendChild(el('option', { value: '300' }, 'The previous secret keeps working for 5 minutes'));
  overlap.appendChild(el('option', { value: '900' }, 'The previous secret keeps working for 15 minutes'));
  const status = el('p', { class: 'form-error', role: 'status' });
  const go = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Rotate it');
  const dialog = openDialog({
    title: 'Rotate ' + (key.name || 'this key'),
    sub: 'The key keeps its name, its id and its scopes. The secret changes.',
    body: el('div', { class: 'fold' },
      overlap,
      el('p', { class: 'form-note' },
        'The new secret works at once. The old one keeps working until the overlap ends, '
        + 'which is what lets an integration be redeployed without being taken down.'),
      status),
    foot: [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      go,
    ],
  });

  go.addEventListener('click', async () => {
    go.disabled = true;
    status.textContent = '';
    try {
      const answer = await rotateKey(key.id, { overlapSeconds: Number(overlap.value) });
      dialog.close();
      showSecret(answer && answer.secret, {
        title: 'The new secret',
        sub: answer && answer.previousSecretExpiresAt
          ? 'The previous secret stops working at ' + formatDateTime(answer.previousSecretExpiresAt) + '.'
          : 'This is the only time the secret is shown.',
      });
      if (onDone) onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The key was not rotated.';
      go.disabled = false;
    }
  });

  return dialog;
}

// What a key has spent, and whether it is working.
function openKeyReport(key) {
  const body = el('div', { class: 'fold' });
  const dialog = openDialog({
    title: (key.name || 'This key') + ' at work',
    sub: 'What it has asked for, and how it went.',
    body,
  });
  body.replaceChildren(hold('Reading the report'));
  Promise.all([keyUsage(key.id, 1440), keyHealth(key.id, 1440)]).then(([usage, health]) => {
    const totals = (usage && usage.totals) || {};
    const byRoute = (usage && usage.byRoute) || [];
    body.replaceChildren(el('div', { class: 'fold fold--tight' },
      facts([
        { value: totals.requests || 0, label: 'Requests' },
        { value: totals.succeeded || 0, label: 'That worked' },
        { value: (totals.clientErrors || 0) + (totals.serverErrors || 0), label: 'That failed' },
      ]),
      el('p', { class: 'form-note' }, 'Its state: ' + ((health && health.state) || 'unknown') + '.'),
      health && health.lastFailure
        ? memo({
          tone: 'warning',
          title: 'Its last failure',
          text: (health.lastFailure.route || 'a route') + ' · ' + (health.lastFailure.errors || 0)
            + ' errors · ' + formatDateTime(health.lastFailure.at),
        })
        : null,
      byRoute.length
        ? el('div', { class: 'fold fold--tight' }, byRoute.map((entry) => el('div', { class: 'settings-item' },
          el('div', { class: 'settings-item-main' },
            el('p', { class: 'settings-item-label' }, entry.route),
            el('p', { class: 'settings-note' }, entry.succeeded + ' worked, '
              + ((entry.clientErrors || 0) + (entry.serverErrors || 0)) + ' failed')),
          el('div', { class: 'settings-item-control' },
            el('span', { class: 'chip chip--quiet' }, entry.requests + ' requests')))))
        : el('p', { class: 'form-note' }, 'It has made no requests.')));
  }).catch((error) => {
    body.replaceChildren(fault(error, null));
  });
  return dialog;
}

// The keys this account holds.
function keysSection() {
  const list = el('div', { class: 'rowlist' });

  function keyRow(key) {
    const scopes = Array.isArray(key.scopes) ? key.scopes : [];
    return row({
      lead: el('span', { class: 'role-dot' }, icon('key', { size: 15 })),
      title: key.name || key.id,
      sub: key.id + (key.lastUsedAt ? ' · last used ' + formatDateTime(key.lastUsedAt) : ' · never used'),
      meta: el('span', { class: 'chips' },
        keyStateChip(key.status),
        el('span', { class: 'chip chip--quiet' }, scopes.length + ' scope'
          + (scopes.length === 1 ? '' : 's'))),
      side: el('div', { class: 'cardrow-side' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'See what ' + (key.name || key.id) + ' has been doing',
          onClick: () => openKeyReport(key),
        }, 'Its work'),
        key.status === 'active' ? el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          'aria-label': 'Rotate ' + (key.name || key.id),
          onClick: () => openRotateKey(key, paint),
        }, 'Rotate') : null,
        key.status === 'active' ? el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Revoke ' + (key.name || key.id),
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Revoke this key?',
              body: 'Every secret this key ever issued stops working at once. An integration using it '
                + 'will start being refused, and the key keeps its name and its place in the list.',
              confirmLabel: 'Revoke it',
              danger: true,
            });
            if (!yes) return;
            try {
              await revokeKey(key.id, { reason: 'revoked by its owner' });
              toast('Revoked');
              paint();
            } catch (error) { errorToast(error); }
          },
        }, 'Revoke') : null),
    });
  }

  async function paint() {
    list.replaceChildren(hold('Reading the keys'));
    try {
      const answer = await readKeys();
      const keys = (answer && answer.keys) || [];
      list.replaceChildren(...(keys.length
        ? keys.map(keyRow)
        : [blank({
          glyph: 'key',
          title: 'No keys yet',
          text: 'An integration that speaks for you needs a key. Make one, and give it only the scopes it needs.',
        })]));
    } catch (error) {
      list.replaceChildren(fault(error, paint));
    }
  }

  return {
    node: fold([
      card({
        label: 'Your API keys',
        glyph: 'key',
        note: 'each one speaks for you, with only the scopes it carries',
        actions: el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          'aria-label': 'Create an API key',
          onClick: () => openCreateKey(paint),
        }, 'Create a key'),
        flush: true,
        body: list,
      }),
    ]),
    onMount: () => paint(),
    cleanup() {},
  };
}

// -- the applications ------------------------------------------------------------

// The commands an application answers. Each one is a name, a description and
// the answer it gives.
function openCommandEditor(serverId, application, command, onDone) {
  const body = el('div', { class: 'fold' });
  const status = el('p', { class: 'form-error', role: 'status' });
  const save = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Save it');
  const dialog = openDialog({
    title: command ? 'Change /' + command.name : 'Register a command',
    sub: 'A command is what somebody types to make the application answer.',
    body: el('div', { class: 'fold' }, body, status),
    foot: [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      save,
    ],
  });

  const name = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The name of the command',
    value: command ? command.name : '',
  });
  const description = el('input', {
    class: 'input', type: 'text', 'aria-label': 'What the command does',
    value: command && command.description ? command.description : '',
  });
  const response = el('textarea', {
    class: 'textarea', rows: '3', 'aria-label': 'The answer the command gives',
  });
  response.value = command ? command.response : '';
  const options = el('textarea', {
    class: 'textarea', rows: '3', 'aria-label': 'The options the command takes, as JSON',
    placeholder: '[{"name":"who","type":"string"}]',
  });
  options.value = command && command.options && command.options.length
    ? JSON.stringify(command.options, null, 2)
    : '';

  body.replaceChildren(el('div', { class: 'form-stack' },
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'Name'),
      name),
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'What it does'),
      description),
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'The answer it gives'),
      response),
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'Options (JSON)'),
      options)));

  save.addEventListener('click', async () => {
    save.disabled = true;
    status.textContent = '';
    let parsed = [];
    if (options.value.trim()) {
      try {
        parsed = JSON.parse(options.value);
      } catch (error) {
        status.textContent = 'The options are not JSON.';
        save.disabled = false;
        return;
      }
    }
    try {
      await putCommand(serverId, application.id, {
        name: name.value.trim(),
        description: description.value.trim() || undefined,
        response: response.value,
        options: parsed,
      });
      dialog.close();
      toast('Saved');
      if (onDone) onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The command was not saved.';
      save.disabled = false;
    }
  });

  return dialog;
}

// The commands of one application.
function openCommands(serverId, application, onDone) {
  const body = el('div', { class: 'fold' });
  const dialog = openDialog({
    title: 'The commands of ' + application.name,
    sub: 'What the application answers when somebody types a slash command.',
    body,
    foot: [
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => openCommandEditor(serverId, application, null, onDone),
      }, 'Register a command'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => dialog.close() }, 'Close'),
    ],
  });
  body.replaceChildren(hold('Reading the commands'));
  readCommands(serverId, application.id).then((answer) => {
    const commands = (answer && answer.commands) || [];
    body.replaceChildren(...(commands.length
      ? commands.map((command) => el('div', { class: 'settings-item' },
        el('div', { class: 'settings-item-main' },
          el('p', { class: 'settings-item-label' }, '/' + command.name),
          el('p', { class: 'settings-note' }, command.description || command.response)),
        el('div', { class: 'settings-item-control' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Change the command ' + command.name,
            onClick: () => openCommandEditor(serverId, application, command, onDone),
          }, 'Change')),
        el('div', { class: 'settings-item-actions' },
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            'aria-label': 'Remove the command ' + command.name,
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Remove this command?',
                body: 'The application stops answering /' + command.name + '. The command is removed.',
                confirmLabel: 'Remove it',
                danger: true,
              });
              if (!yes) return;
              try {
                await deleteCommand(serverId, application.id, command.id);
                toast('Removed');
                if (onDone) onDone();
              } catch (error) { errorToast(error); }
            },
          }, 'Remove'))))
      : [el('p', { class: 'form-note' }, 'It answers no commands yet.')]));
  }).catch((error) => {
    body.replaceChildren(fault(error, null));
  });
  return dialog;
}

// What an application is doing, and whether it is working.
function openApplicationHealth(serverId, application) {
  const body = el('div', { class: 'fold' });
  const dialog = openDialog({
    title: application.name + ' at work',
    sub: 'Whether the application is working, and what it has asked for.',
    body,
  });
  body.replaceChildren(hold('Reading the health'));
  applicationHealth(serverId, application.id).then((health) => {
    const answer = health || {};
    body.replaceChildren(el('div', { class: 'fold fold--tight' },
      facts([
        { value: answer.state || 'unknown', label: 'Its state' },
        { value: answer.rateLimitPerMinute || '—', label: 'Requests a minute' },
        { value: answer.lastUsedAt ? formatDateTime(answer.lastUsedAt) : 'never', label: 'Last used' },
      ]),
      answer.lastFailure
        ? memo({
          tone: 'warning',
          title: 'Its last failure',
          text: (answer.lastFailure.route || 'a route') + ' · ' + (answer.lastFailure.errors || 0) + ' errors',
        })
        : null,
      el('p', { class: 'form-note' },
        'The scopes it carries: ' + ((answer.scopes || []).join(', ') || 'none'))));
  }).catch((error) => {
    body.replaceChildren(fault(error, null));
  });
  return dialog;
}

// Making an application: its name and the scopes its credential carries.
function openCreateApplication(serverId, onDone) {
  const body = el('div', { class: 'fold' });
  const status = el('p', { class: 'form-error', role: 'status' });
  const make = el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: true }, 'Create it');
  const dialog = openDialog({
    title: 'Create a bot application',
    sub: 'An application posts as itself. It has no login and no session - its token is its credential.',
    body: el('div', { class: 'fold' }, body, status),
    foot: [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      make,
    ],
  });

  const name = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The name of the application',
    placeholder: 'What the application is called',
  });
  const description = el('input', {
    class: 'input', type: 'text', 'aria-label': 'What the application does',
  });

  let boxes = new Map();
  body.replaceChildren(hold('Reading the scopes'));
  readScopes().then((answer) => {
    const groups = (answer && answer.groups) || [];
    const picker = scopePicker(groups);
    boxes = picker.boxes;
    body.replaceChildren(el('div', { class: 'form-stack' },
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Name'),
        name),
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'What it does'),
        description),
      el('p', { class: 'form-note' }, 'The scopes its credential carries:'),
      picker.list));
    make.disabled = false;
    name.focus();
  }).catch((error) => {
    body.replaceChildren(fault(error, null));
  });

  make.addEventListener('click', async () => {
    if (!name.value.trim()) {
      status.textContent = 'An application needs a name.';
      return;
    }
    make.disabled = true;
    status.textContent = '';
    try {
      const answer = await createApplication(serverId, {
        name: name.value.trim(),
        description: description.value.trim() || undefined,
        scopes: chosenScopes(boxes),
      });
      dialog.close();
      showSecret(answer && answer.token, {
        title: 'The token of ' + name.value.trim(),
        sub: 'This is the only time the token is shown. It is the application\'s credential: '
          + 'there is no account behind it and no password to lose, and it cannot be recovered.',
      });
      if (onDone) onDone();
    } catch (error) {
      status.textContent = (error && error.message) || 'The application was not created.';
      make.disabled = false;
    }
  });

  return dialog;
}

// The applications of one community.
function applicationsSection() {
  const picker = el('select', { class: 'input', 'aria-label': 'The community whose applications are shown' });
  const list = el('div', { class: 'rowlist' });
  const tools = el('span', { class: 'chips' });
  let serverId = null;

  function communities() {
    return State.servers.filter((server) => {
      const perms = (server.permissions || []).indexOf('*') !== -1
        || (server.permissions || []).indexOf('MANAGE_SERVER') !== -1;
      return perms || server.is_owner;
    });
  }

  function paintCommunities() {
    const options = communities();
    if (!options.length) {
      picker.replaceChildren(el('option', { value: '' }, 'No community you manage'));
      picker.disabled = true;
      // Nothing is offered where there is nowhere to put it.
      tools.replaceChildren();
      return;
    }
    picker.disabled = false;
    if (!serverId || !options.some((server) => server.id === serverId)) {
      serverId = options[0].id;
    }
    picker.replaceChildren(...options.map((server) => el('option', { value: server.id }, server.name)));
    picker.value = serverId;
    tools.replaceChildren(el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      'aria-label': 'Create a bot application',
      onClick: () => openCreateApplication(serverId, paint),
    }, 'Create an application'));
  }

  function applicationRow(application) {
    const credential = application.credential || {};
    const scopes = Array.isArray(credential.scopes) ? credential.scopes : [];
    return row({
      lead: el('span', { class: 'role-dot' }, icon('bot', { size: 15 })),
      title: application.name,
      sub: (application.description || 'It posts as itself, with no account behind it.')
        + ' · ' + scopes.length + ' scope' + (scopes.length === 1 ? '' : 's'),
      meta: application.status === 'active'
        ? el('span', { class: 'chip chip--on' }, 'active')
        : el('span', { class: 'chip chip--warn' }, String(application.status || 'disabled')),
      side: el('div', { class: 'cardrow-side' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'See whether ' + application.name + ' is working',
          onClick: () => openApplicationHealth(serverId, application),
        }, 'Its work'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'See the commands of ' + application.name,
          onClick: () => openCommands(serverId, application, paint),
        }, 'Commands'),
        application.status === 'active' ? el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          'aria-label': 'Issue a new token for ' + application.name,
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Issue a new token?',
              body: 'The application holds one token. The old one stops working at once, so the '
                + 'integration has to be given the new one before it is next used.',
              confirmLabel: 'Issue it',
            });
            if (!yes) return;
            try {
              const answer = await rotateApplicationToken(serverId, application.id);
              showSecret(answer && answer.token, {
                title: 'The new token of ' + application.name,
                sub: 'This is the only time the token is shown. The previous one has stopped working.',
              });
              paint();
            } catch (error) { errorToast(error); }
          },
        }, 'New token') : null,
        application.status === 'active' ? el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Revoke ' + application.name,
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Revoke this application?',
              body: 'Its token is burned at once and the application is disabled. It cannot be brought '
                + 'back with the same token.',
              confirmLabel: 'Revoke it',
              danger: true,
            });
            if (!yes) return;
            try {
              await revokeApplication(serverId, application.id, { reason: 'revoked by an operator' });
              toast('Revoked');
              paint();
            } catch (error) { errorToast(error); }
          },
        }, 'Revoke') : null),
    });
  }

  async function paint() {
    if (!serverId) {
      list.replaceChildren(blank({
        glyph: 'bot',
        title: 'No community you manage',
        text: 'An application belongs to a community, and only somebody who manages that community '
          + 'may make one.',
      }));
      return;
    }
    list.replaceChildren(hold('Reading the applications'));
    try {
      const answer = await readApplications(serverId);
      const applications = (answer && answer.applications) || [];
      list.replaceChildren(...(applications.length
        ? applications.map(applicationRow)
        : [blank({
          glyph: 'bot',
          title: 'No applications yet',
          text: 'An application posts as itself, answers slash commands, and never has an account.',
        })]));
    } catch (error) {
      list.replaceChildren(fault(error, paint));
    }
  }

  picker.addEventListener('change', () => {
    serverId = picker.value;
    paint();
  });

  return {
    node: fold([
      memo({
        tone: 'info',
        title: 'An application is not an account',
        text: 'It has no login, no session and no password. Its token is its credential, and the '
          + 'scopes on that credential say what it may do. It posts in its own name.',
      }),
      card({
        label: 'The applications of this community',
        glyph: 'bot',
        note: 'who they are, what they may do, and the commands they answer',
        actions: tools,
        body: el('div', { class: 'form-stack' }, picker, list),
      }),
    ]),
    onMount: async () => {
      if (!State.servers.length) {
        try { await refreshServers(); } catch { /* the note below says what is missing */ }
      }
      paintCommunities();
      await paint();
    },
    cleanup() {},
  };
}

// -- the page --------------------------------------------------------------------

const SECTIONS = [
  { id: 'keys', label: 'API keys', view: keysSection },
  { id: 'applications', label: 'Applications', view: applicationsSection },
];

export function renderDeveloper(ctx) {
  const tabs = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Developer console sections' });
  const stage = el('div', { class: 'fold fold--tight' });

  let current = null;
  let live = null;

  // The section may be named in the address, so that a particular one can be
  // linked to and a reader can come back to it.
  function wantedSection() {
    const asked = ctx && ctx.query ? String(ctx.query.get('section') || '') : '';
    return SECTIONS.some((section) => section.id === asked) ? asked : SECTIONS[0].id;
  }

  function paintTabs() {
    tabs.replaceChildren(...SECTIONS.map((section) => el('button', {
      class: 'segmented-item',
      type: 'button',
      'aria-selected': current === section.id ? 'true' : 'false',
      'aria-label': 'Show the ' + section.label.toLowerCase() + ' section',
      onClick: () => show(section.id),
    }, section.label)));
  }

  async function show(id) {
    const section = SECTIONS.find((entry) => entry.id === id) || SECTIONS[0];
    current = section.id;
    paintTabs();
    if (live && live.cleanup) live.cleanup();
    live = section.view();
    stage.replaceChildren(live.node);
    if (live.onMount) await live.onMount();
  }

  const node = fold([
    head({
      kicker: 'Account',
      title: 'Developer',
      lede: 'The credentials that speak for you, and the applications that speak for themselves.',
    }),
    tabs,
    stage,
  ]);

  return {
    node,
    onMount: () => show(wantedSection()),
    cleanup() {
      if (live && live.cleanup) live.cleanup();
      live = null;
    },
  };
}

export default { renderDeveloper };
