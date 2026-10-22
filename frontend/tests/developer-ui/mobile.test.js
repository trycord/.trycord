// The developer console, on a phone.
//
// The phone is not a smaller desk: the keys and the applications are the same
// things, arranged as a list and a sheet. The promise that has to hold on both
// is the same one - a secret is shown once, in the sheet that made it, and
// nowhere afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from '../helpers/dom-stub.js';

// The document is installed once for the module, because the modules beside
// this one read it as they load, and again for every check: a check that
// draws a dialog must not find the dialog of the check before it.
//
// The first install is guarded. Two files in one run would otherwise replace
// the document under a check that is already running, and the check would be
// looking at a document that is no longer there.
if (!globalThis.document) installDomStub();

// The phone's sheet asks the browser for the next frame. Node has no such
// thing, so the check gives it one.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

const { State } = await import('../../packages/store.js');
const { renderDeveloper } = await import('../../mobile/js/views/developer.js');

// -- finding things -------------------------------------------------------------

function findAll(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) findAll(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

function byLabel(node, label) {
  return findAll(node, (entry) => entry.getAttribute('aria-label') === label);
}

function sheets() {
  return findAll(document.body, classed('m-sheet'));
}

function sheetWith(text) {
  return sheets().filter((node) => String(node.textContent || '').indexOf(text) !== -1)[0] || null;
}

// The control of a labelled field, found by the label that names it.
function fieldControl(node, label) {
  const fields = findAll(node, classed('m-field')).filter((entry) => {
    const text = String(entry.textContent || '');
    return text.indexOf(label) === 0;
  });
  if (!fields.length) return null;
  return findAll(fields[0], (entry) => entry.tagName === 'INPUT' || entry.tagName === 'TEXTAREA')[0] || null;
}

// A button found by the words written on it. The phone's smaller actions have
// no label of their own: their text is their name.
function buttonWith(node, text) {
  return findAll(node, (entry) => entry.tagName === 'BUTTON'
    && String(entry.textContent || '').trim() === text)[0] || null;
}

function tabOf(view, name) {
  const button = byLabel(view.node, 'Show the ' + name.toLowerCase() + ' section')[0];
  assert.ok(button, 'the console has no ' + name + ' section');
  button.click();
  return button;
}

// -- the fixtures ----------------------------------------------------------------

const SECRET = 'tc_handle.the-secret-value';

const KEY = {
  id: 'k_abc',
  name: 'Nightly report',
  kind: 'user',
  status: 'active',
  ownerUserId: 'u1',
  scopes: ['messages:read'],
  rateLimitPerMinute: 120,
  createdAt: '2026-02-01T09:00:00.000Z',
  lastUsedAt: '2026-02-02T09:00:00.000Z',
};

const SCOPES = {
  groups: [
    {
      name: 'credentials',
      scopes: [
        { name: 'keys:read', description: 'Read the keys of the owner.' },
        { name: 'keys:write', description: 'Create, rotate and revoke API keys.' },
      ],
    },
  ],
};

const APPLICATION = {
  id: 'app1',
  serverId: 's1',
  ownerUserId: 'u1',
  name: 'Night owl',
  description: 'Posts the nightly report.',
  status: 'active',
  credential: {
    id: 'k_bot',
    scopes: ['messages:read'],
    rateLimitPerMinute: 60,
    status: 'active',
    lastUsedAt: null,
    createdAt: '2026-02-01T09:00:00.000Z',
  },
};

const V1 = 'http://localhost/api/v1';

function baseRoutes(extra) {
  return Object.assign({
    [V1 + '/keys']: { json: { keys: [KEY] } },
    [V1 + '/scopes']: { json: SCOPES },
  }, extra || {});
}

// -- the tests --------------------------------------------------------------------

test('the phone creates a key and shows the secret once', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes({
    [V1 + '/keys']: (body) => {
      if (body) return { json: { key: KEY, secret: SECRET } };
      return { json: { keys: [KEY] } };
    },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  byLabel(view.node, 'Create an API key')[0].click();
  const sheet = await waitFor(() => {
    const found = sheetWith('Create an API key');
    if (!found) return null;
    return /keys:write/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(sheet, 'the key form did not open');

  const name = fieldControl(sheet, 'The name of the key');
  assert.ok(name, 'the key form has no name field');
  name.value = 'Nightly report';

  const scope = byLabel(sheet, 'Grant messages:read')[0] || byLabel(sheet, 'Grant keys:write')[0];
  assert.ok(scope, 'the key form did not offer the scopes');
  scope.checked = true;
  scope.dispatch('change');

  const create = findAll(sheet, classed('m-btn--primary'))[0];
  create.click();

  const secret = await waitFor(() => {
    const found = sheetWith('Your new key');
    if (!found) return null;
    return /tc_handle/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(secret, 'the secret was never shown');
  assert.match(secret.textContent, /only time it is shown/,
    'the secret was not marked as the only time it is shown');

  const posted = await waitFor(() => calls.find((call) => call.options.method === 'POST' && call.url === V1 + '/keys'));
  assert.ok(posted, 'the key was never created');
  assert.equal(posted.body.name, 'Nightly report');
  assert.ok(Array.isArray(posted.body.scopes), 'the key carried no scope list');
});

test('the phone does not keep the secret after the sheet is closed', async () => {
  installDomStub();
  installFetchStub(baseRoutes({
    [V1 + '/keys']: (body) => {
      if (body) return { json: { key: KEY, secret: SECRET } };
      return { json: { keys: [KEY] } };
    },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  byLabel(view.node, 'Create an API key')[0].click();
  const sheet = await waitFor(() => {
    const found = sheetWith('Create an API key');
    if (!found) return null;
    return /keys:write/.test(String(found.textContent || '')) ? found : null;
  });
  fieldControl(sheet, 'The name of the key').value = 'Nightly report';
  findAll(sheet, classed('m-btn--primary'))[0].click();

  const secret = await waitFor(() => {
    const found = sheetWith('Your new key');
    if (!found) return null;
    return /tc_handle/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(secret, 'the secret was never shown');

  const done = findAll(secret, classed('m-btn--primary'))[0];
  done.click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(view.node.textContent.indexOf('tc_handle'), -1,
    'the list of keys carries the secret');
});

test('the phone revokes a key', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes({
    [V1 + '/keys/k_abc/revoke']: { json: { key: Object.assign({}, KEY, { status: 'revoked' }) } },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  const key = await waitFor(() => findAll(view.node, (node) => node.tagName === 'BUTTON'
    && /Nightly report/.test(String(node.textContent || '')))[0]);
  assert.ok(key, 'the key is not listed');
  key.click();

  const sheet = await waitFor(() => sheetWith('Nightly report'));
  assert.ok(sheet, 'the key did not open');

  const revoke = findAll(sheet, classed('m-btn--danger'))[0];
  assert.ok(revoke, 'there is no way to revoke a key');
  revoke.click();

  const confirm = await waitFor(() => {
    const found = sheets().filter((node) => String(node.textContent || '').indexOf('Revoke this key?') !== -1)[0];
    if (!found) return null;
    return findAll(found, classed('m-btn--danger'))[0];
  });
  assert.ok(confirm, 'revoking a key asked nothing');
  confirm.click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'POST'
    && call.url === V1 + '/keys/k_abc/revoke'));
  assert.ok(sent, 'the key was never revoked');
});

test('the phone shows an application token once', async () => {
  installDomStub();
  State.servers = [{ id: 's1', name: 'A community', permissions: ['MANAGE_SERVER'], is_owner: false }];
  const calls = installFetchStub(baseRoutes({
    [V1 + '/communities/s1/applications']: (body) => {
      if (body) return { json: { application: APPLICATION, token: 'bot_token_value', credential: APPLICATION.credential } };
      return { json: { applications: [APPLICATION] } };
    },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Applications');

  await waitFor(() => findAll(view.node, (node) => node.tagName === 'BUTTON'
    && /Night owl/.test(String(node.textContent || '')))[0]);

  byLabel(view.node, 'Create a bot application')[0].click();
  const sheet = await waitFor(() => {
    const found = sheetWith('Create a bot application');
    if (!found) return null;
    return /keys:write/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(sheet, 'the application form did not open');

  fieldControl(sheet, 'The name of the application').value = 'Night owl';
  findAll(sheet, classed('m-btn--primary'))[0].click();

  const token = await waitFor(() => {
    const found = sheetWith('The token of Night owl');
    if (!found) return null;
    return /bot_token_value/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(token, 'the token was never shown');
  assert.match(token.textContent, /only time it is shown/,
    'the token was not marked as the only time it is shown');

  const posted = await waitFor(() => calls.find((call) => call.options.method === 'POST'
    && call.url === V1 + '/communities/s1/applications'));
  assert.ok(posted, 'the application was never created');
});

// -- the application lifecycle ----------------------------------------------------
//
// The phone's sheet is the one place an application is managed, so the acts
// the desk offers are the acts the phone offers, reached from the row itself.

function applicationListRoutes(extra) {
  const state = Object.assign({}, APPLICATION);
  return Object.assign({
    [V1 + '/communities/s1/applications']: () => {
      return { json: { applications: state.deleted ? [] : [Object.assign({}, state)] } };
    },
    [V1 + '/communities/s1/applications/app1']: (body) => {
      if (body) {
        Object.assign(state, body);
        return { json: { application: Object.assign({}, state) } };
      }
      return { json: { applications: state.deleted ? [] : [Object.assign({}, state)] } };
    },
  }, extra || {});
}

// Open the application's sheet by waiting for the row that reads the wanted
// state, so an act and the list that follows it are never confused: a row
// that still reads the old state is not the one to act on.
async function openListedApplication(view, status) {
  const row = await waitFor(() => findAll(view.node, (node) => node.tagName === 'BUTTON'
    && /Night owl/.test(String(node.textContent || ''))
    && (!status || String(node.textContent || '').indexOf(status) !== -1))[0]);
  assert.ok(row, 'the application is not listed' + (status ? ' as ' + status : ''));
  row.click();
  // The sheet that just closed stays in the tree until its leaving animation
  // ends, so the newest sheet that matches is the one to read.
  return waitFor(() => {
    const found = sheets().filter((node) => String(node.textContent || '')
      .indexOf('The scopes it carries') !== -1);
    return found.length ? found[found.length - 1] : null;
  });
}

test('the phone changes an application without a new token', async () => {
  installDomStub();
  State.servers = [{ id: 's1', name: 'A community', permissions: ['MANAGE_SERVER'], is_owner: false }];
  const calls = installFetchStub(baseRoutes(applicationListRoutes()));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Applications');

  const sheet = await openListedApplication(view, 'active');

  const change = buttonWith(sheet, 'Change');
  assert.ok(change, 'the phone offered no way to change an application');
  change.click();

  const form = await waitFor(() => sheetWith('Change Night owl'));
  assert.ok(form, 'changing an application did not open a form');
  fieldControl(form, 'The name of the application').value = 'Night owl II';
  buttonWith(form, 'Save it').click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'PATCH'
    && call.url === V1 + '/communities/s1/applications/app1'));
  assert.ok(sent, 'the application was never changed');
  assert.equal(sent.body.name, 'Night owl II');
  assert.ok(!calls.some((call) => /rotate/.test(call.url)),
    'changing an application issued a token');
});

test('the phone switches an application off and on', async () => {
  installDomStub();
  State.servers = [{ id: 's1', name: 'A community', permissions: ['MANAGE_SERVER'], is_owner: false }];
  const calls = installFetchStub(baseRoutes(applicationListRoutes()));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Applications');

  let sheet = await openListedApplication(view, 'active');
  const off = buttonWith(sheet, 'Switch off');
  assert.ok(off, 'there is no way to switch an application off');
  off.click();

  const lowered = await waitFor(() => calls.find((call) => call.options.method === 'PATCH'
    && call.url === V1 + '/communities/s1/applications/app1'));
  assert.ok(lowered, 'the application was never switched off');
  assert.equal(lowered.body.status, 'disabled');

  sheet = await openListedApplication(view, 'disabled');
  const on = buttonWith(sheet, 'Switch on');
  assert.ok(on, 'a switched-off application had no way back');
  on.click();

  const raised = await waitFor(() => calls.find((call) => call.options.method === 'PATCH'
    && call.url === V1 + '/communities/s1/applications/app1' && call.body.status === 'active'));
  assert.ok(raised, 'the application was never switched on');
});

test('the phone deletes a switched-off application for good', async () => {
  installDomStub();
  State.servers = [{ id: 's1', name: 'A community', permissions: ['MANAGE_SERVER'], is_owner: false }];
  const calls = installFetchStub(baseRoutes({
    [V1 + '/communities/s1/applications']: () => {
      return { json: { applications: [Object.assign({}, APPLICATION, { status: 'disabled' })] } };
    },
    [V1 + '/communities/s1/applications/app1']: () => ({ json: { ok: true } }),
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Applications');

  const sheet = await openListedApplication(view, 'disabled');
  assert.ok(/It is disabled/.test(String(sheet.textContent || '')),
    'the sheet did not say the application is switched off');

  const remove = byLabel(sheet, 'Delete Night owl')[0];
  assert.ok(remove, 'there is no way to delete a switched-off application');
  remove.click();

  const asked = await waitFor(() => {
    const found = sheets().filter((node) => String(node.textContent || '').indexOf('Delete Night owl?') !== -1)[0];
    if (!found) return null;
    return findAll(found, classed('m-btn--danger'))[0];
  });
  assert.ok(asked, 'deleting an application asked nothing');
  const said = sheets().filter((node) => String(node.textContent || '').indexOf('Delete Night owl?') !== -1)[0];
  assert.match(said.textContent, /The messages it wrote stay/,
    'the deletion did not say what happens to what the application wrote');
  asked.click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'DELETE'
    && call.url === V1 + '/communities/s1/applications/app1'));
  assert.ok(sent, 'the application was never deleted');
});
