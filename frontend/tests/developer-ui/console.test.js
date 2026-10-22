// The developer console.
//
// The keys and the applications a person holds. The thing these checks are
// about is the secret: it is shown once, at the moment it is made or rotated,
// and it is never carried anywhere afterwards. A console that kept it would be
// a console that could leak it.

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

const { State } = await import('../../packages/store.js');
const { renderDeveloper } = await import('../../js/features/developer.js');

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

function dialogs() {
  return findAll(document.body, classed('dialog'));
}

function dialogWith(text) {
  return dialogs().filter((node) => String(node.textContent || '').indexOf(text) !== -1)[0] || null;
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
  communityId: null,
  botApplicationId: null,
  rateLimitPerMinute: 120,
  createdAt: '2026-02-01T09:00:00.000Z',
  lastUsedAt: '2026-02-02T09:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  revokedReason: null,
  rotatedAt: null,
  rotatedFrom: null,
  previousSecretExpiresAt: null,
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
    {
      name: 'messages',
      scopes: [
        { name: 'messages:read', description: 'Read the recent messages of a channel.' },
        { name: 'messages:write', description: 'Post a message in the name of the caller.' },
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
  iconUrl: null,
  status: 'active',
  createdAt: '2026-02-01T09:00:00.000Z',
  credential: {
    id: 'k_bot',
    scopes: ['messages:read', 'messages:write'],
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

test('a key is created and the secret is shown once', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes({
    [V1 + '/keys']: (body, all) => {
      if (body) return { json: { key: KEY, secret: SECRET } };
      return { json: { keys: [KEY] } };
    },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  byLabel(view.node, 'Create an API key')[0].click();
  const dialog = await waitFor(() => {
    const found = dialogWith('Create an API key');
    if (!found) return null;
    return /keys:write/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(dialog, 'the key form did not open');

  const name = byLabel(dialog, 'The name of the key')[0];
  assert.ok(name, 'the key form has no name field');
  name.value = 'Nightly report';

  const scope = byLabel(dialog, 'Grant messages:read')[0];
  assert.ok(scope, 'the key form did not offer the scopes');
  scope.checked = true;
  scope.dispatch('change');

  const create = findAll(dialog, classed('btn--primary'))[0];
  create.click();

  const secret = await waitFor(() => {
    const found = dialogWith('Your new key');
    if (!found) return null;
    return /tc_handle/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(secret, 'the secret was never shown');
  assert.match(secret.textContent, /only time the secret is shown/,
    'the secret was not marked as the only time it is shown');
  assert.match(secret.textContent, /cannot be recovered/,
    'the secret did not say that it cannot be recovered');

  const posted = await waitFor(() => calls.find((call) => call.options.method === 'POST' && call.url === V1 + '/keys'));
  assert.ok(posted, 'the key was never created');
  assert.equal(posted.body.name, 'Nightly report');
  assert.deepEqual(posted.body.scopes, ['messages:read']);
});

test('the list afterwards does not carry the secret', async () => {
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
  const dialog = await waitFor(() => {
    const found = dialogWith('Create an API key');
    if (!found) return null;
    return /keys:write/.test(String(found.textContent || '')) ? found : null;
  });
  byLabel(dialog, 'The name of the key')[0].value = 'Nightly report';
  findAll(dialog, classed('btn--primary'))[0].click();

  const secret = await waitFor(() => {
    const found = dialogWith('Your new key');
    if (!found) return null;
    return /tc_handle/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(secret, 'the secret was never shown');

  // The secret is dismissed, and the list is read again.
  const dismiss = findAll(secret, classed('btn--primary'))[0];
  dismiss.click();
  await waitFor(() => calls.filter((call) => call.options.method === 'GET' && call.url === V1 + '/keys').length >= 2);

  assert.equal(view.node.textContent.indexOf('tc_handle'), -1,
    'the list of keys carries the secret');
});

test('a rotation produces a new secret and says when the old one stops', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes({
    [V1 + '/keys/k_abc/rotate']: {
      json: {
        key: KEY,
        secret: 'tc_handle.the-new-secret',
        previousSecretExpiresAt: '2026-02-02T09:05:00.000Z',
      },
    },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  const rotate = byLabel(view.node, 'Rotate Nightly report')[0];
  assert.ok(rotate, 'there is no way to rotate a key');
  rotate.click();

  const dialog = await waitFor(() => dialogWith('Rotate Nightly report'));
  assert.ok(dialog, 'the rotation did not ask anything');
  findAll(dialog, classed('btn--primary'))[0].click();

  const secret = await waitFor(() => {
    const found = dialogWith('The new secret');
    if (!found) return null;
    return /the-new-secret/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(secret, 'the new secret was never shown');
  assert.match(secret.textContent, /previous secret stops working/i,
    'the rotation did not say when the old secret stops working');

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'POST'
    && call.url === V1 + '/keys/k_abc/rotate'));
  assert.ok(sent, 'the key was never rotated');
});

test('a revocation stops the key', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes({
    [V1 + '/keys/k_abc/revoke']: { json: { key: Object.assign({}, KEY, { status: 'revoked' }) } },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  const revoke = byLabel(view.node, 'Revoke Nightly report')[0];
  assert.ok(revoke, 'there is no way to revoke a key');
  revoke.click();

  const confirm = await waitFor(() => {
    const found = dialogs().filter((node) => String(node.textContent || '').indexOf('Revoke this key?') !== -1)[0];
    if (!found) return null;
    return findAll(found, classed('btn--danger'))[0];
  });
  assert.ok(confirm, 'revoking a key asked nothing');
  assert.match(dialogs().filter((node) => String(node.textContent || '').indexOf('Revoke this key?') !== -1)[0].textContent,
    /stops working at once/, 'the revocation did not say what it does');
  confirm.click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'POST'
    && call.url === V1 + '/keys/k_abc/revoke'));
  assert.ok(sent, 'the key was never revoked');
});

test('an application is not a person, and its token is shown once', async () => {
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

  await waitFor(() => findAll(view.node, (node) => String(node.textContent || '').indexOf('Night owl') !== -1)[0]);
  assert.match(view.node.textContent, /An application is not an account/,
    'the console did not say that an application is not a person');

  byLabel(view.node, 'Create a bot application')[0].click();
  const dialog = await waitFor(() => {
    const found = dialogs().filter((node) => String(node.textContent || '').indexOf('Create a bot application') !== -1)[0];
    if (!found) return null;
    return /keys:write/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(dialog, 'the application form did not open');

  byLabel(dialog, 'The name of the application')[0].value = 'Night owl';
  findAll(dialog, classed('btn--primary'))[0].click();

  const token = await waitFor(() => {
    const found = dialogWith('The token of Night owl');
    if (!found) return null;
    return /bot_token_value/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(token, 'the token was never shown');
  assert.match(token.textContent, /only time the token is shown/,
    'the token was not marked as the only time it is shown');
  assert.match(token.textContent, /no account behind it/,
    'the token did not say what it is');

  const posted = await waitFor(() => calls.find((call) => call.options.method === 'POST'
    && call.url === V1 + '/communities/s1/applications'));
  assert.ok(posted, 'the application was never created');
  assert.equal(posted.body.name, 'Night owl');
});

test('the applications of a community the reader does not manage are not offered', async () => {
  installDomStub();
  State.servers = [{ id: 's1', name: 'A community', permissions: ['messages:read'], is_owner: false }];
  installFetchStub(baseRoutes());

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Applications');

  await waitFor(() => findAll(view.node, (node) => String(node.textContent || '').indexOf('No community you manage') !== -1)[0]);
  assert.equal(byLabel(view.node, 'Create a bot application').length, 0,
    'the console offered to make an application in a community the reader does not manage');
});

test('the keys a reader holds are listed with their scopes and never their secret', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes({
    [V1 + '/keys']: { json: { keys: [KEY] } },
  }));

  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  await waitFor(() => findAll(view.node, (node) => String(node.textContent || '').indexOf('Nightly report') !== -1)[0]);
  assert.match(view.node.textContent, /1 scope/, 'the key did not say how many scopes it carries');
  const sent = calls.find((call) => call.options.method === 'GET' && call.url === V1 + '/keys');
  assert.ok(sent, 'the keys were never read');
  assert.equal(view.node.textContent.indexOf('tc_'), -1,
    'the list of keys carries a secret');
});

// -- the application lifecycle ---------------------------------------------------
//
// One application whose state the routes hold, so an act and the list that is
// read after it agree about what happened. A test that fakes each answer
// separately can pass while the real console shows a state that was never
// true.

function applicationRoutes() {
  const state = Object.assign({}, APPLICATION);
  return {
    [V1 + '/communities/s1/applications']: () => {
      return { json: { applications: state.deleted ? [] : [Object.assign({}, state)] } };
    },
    [V1 + '/communities/s1/applications/app1']: (body, calls) => {
      const method = (calls[calls.length - 1].options && calls[calls.length - 1].options.method) || 'GET';
      if (method === 'PATCH') {
        Object.assign(state, body);
        return { json: { application: Object.assign({}, state) } };
      }
      if (method === 'DELETE') {
        state.deleted = true;
        return { json: { ok: true } };
      }
      return { json: { application: Object.assign({}, state), credential: APPLICATION.credential } };
    },
    [V1 + '/communities/s1/applications/app1/credential']: (body) => {
      return { json: { credential: Object.assign({}, APPLICATION.credential, body) } };
    },
  };
}

async function applicationView(calls) {
  State.servers = [{ id: 's1', name: 'A community', permissions: ['MANAGE_SERVER'], is_owner: false }];
  const view = renderDeveloper({ page: { id: 'developer' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Applications');
  await waitFor(() => byLabel(view.node, 'Manage Night owl')[0]);
  void calls;
  return view;
}

async function managedApplication(view) {
  byLabel(view.node, 'Manage Night owl')[0].click();
  return waitFor(() => dialogWith('What it is, what it may do'));
}

test('an application is changed without touching its token', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes(applicationRoutes()));

  const view = await applicationView(calls);
  const manage = await managedApplication(view);

  byLabel(manage, 'Change for Night owl')[0].click();
  const form = await waitFor(() => dialogWith('Change Night owl'));
  assert.ok(form, 'changing an application did not open a form');
  byLabel(form, 'The name of the application')[0].value = 'Night owl II';
  findAll(form, classed('btn--primary'))[0].click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'PATCH'
    && call.url === V1 + '/communities/s1/applications/app1'));
  assert.ok(sent, 'the application was never changed');
  assert.equal(sent.body.name, 'Night owl II');
  assert.ok(!calls.some((call) => /rotate/.test(call.url)),
    'changing an application issued a token');
  const look = await waitFor(() => calls.find((call) => call.options.method === 'GET'
    && call.url === V1 + '/communities/s1/applications/app1'));
  assert.ok(look, 'the console did not look again at the application it changed');
});

test('the scopes of an application change after the fact', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes(applicationRoutes()));

  const view = await applicationView(calls);
  const manage = await managedApplication(view);

  byLabel(manage, 'Scopes for Night owl')[0].click();
  const form = await waitFor(() => dialogWith('The credential of Night owl'));
  const box = await waitFor(() => byLabel(form, 'Grant messages:read')[0]);
  assert.ok(box.checked, 'the form did not start from the scopes the application carries');
  box.checked = false;
  box.dispatch('change');
  const limit = byLabel(form, 'Requests per minute the application may make')[0];
  assert.ok(limit, 'the form did not offer the limit');
  limit.value = '30';
  findAll(form, classed('btn--primary'))[0].click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'PUT'
    && call.url === V1 + '/communities/s1/applications/app1/credential'));
  assert.ok(sent, 'the credential was never saved');
  assert.deepEqual(sent.body.scopes, ['messages:write']);
  assert.equal(sent.body.rateLimitPerMinute, 30);
  assert.ok(!calls.some((call) => /rotate|\/revoke/.test(call.url) && call.options.method === 'POST'),
    'changing the credential burned the token');
});

test('a switched-off application comes back, still itself', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes(applicationRoutes()));

  const view = await applicationView(calls);
  const manage = await managedApplication(view);

  byLabel(manage, 'Switch off Night owl')[0].click();
  const off = await waitFor(() => calls.find((call) => call.options.method === 'PATCH'
    && call.url === V1 + '/communities/s1/applications/app1'));
  assert.ok(off, 'the application was never switched off');
  assert.equal(off.body.status, 'disabled');

  await waitFor(() => byLabel(view.node, 'Switch on Night owl')[0]);
  byLabel(view.node, 'Switch on Night owl')[0].click();
  const back = await waitFor(() => calls.find((call) => call.options.method === 'PATCH'
    && call.url === V1 + '/communities/s1/applications/app1' && call.body.status === 'active'));
  assert.ok(back, 'the application was never switched on');
});

test('an application is deleted for good, and the list says so', async () => {
  installDomStub();
  const calls = installFetchStub(baseRoutes(applicationRoutes()));

  const view = await applicationView(calls);
  const manage = await managedApplication(view);

  byLabel(manage, 'Delete Night owl')[0].click();
  const answer = await waitFor(() => {
    const found = dialogWith('Delete Night owl?');
    return found ? findAll(found, classed('btn--danger'))[0] : null;
  });
  assert.ok(answer, 'deleting an application asked nothing');
  const asked = dialogWith('Delete Night owl?');
  assert.match(asked.textContent, /The messages it wrote stay/,
    'the deletion did not say what happens to what the application wrote');
  answer.click();

  const gone = await waitFor(() => !dialogWith('What it is, what it may do'));
  assert.ok(gone, 'the application kept a place after it was deleted');
  await waitFor(() => String(view.node.textContent).indexOf('No applications yet') !== -1);
  const sent = calls.find((call) => call.options.method === 'DELETE'
    && call.url === V1 + '/communities/s1/applications/app1');
  assert.ok(sent, 'the application was never deleted');
});
