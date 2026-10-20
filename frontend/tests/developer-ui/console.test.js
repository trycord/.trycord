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

  const view = renderDeveloper({ page: { id: 'developer' }, params: {}, rest: [] });
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

  const view = renderDeveloper({ page: { id: 'developer' }, params: {}, rest: [] });
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

  const view = renderDeveloper({ page: { id: 'developer' }, params: {}, rest: [] });
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

  const view = renderDeveloper({ page: { id: 'developer' }, params: {}, rest: [] });
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

  const view = renderDeveloper({ page: { id: 'developer' }, params: {}, rest: [] });
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

  const view = renderDeveloper({ page: { id: 'developer' }, params: {}, rest: [] });
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

  const view = renderDeveloper({ page: { id: 'developer' }, params: {}, rest: [] });
  await view.onMount();

  await waitFor(() => findAll(view.node, (node) => String(node.textContent || '').indexOf('Nightly report') !== -1)[0]);
  assert.match(view.node.textContent, /1 scope/, 'the key did not say how many scopes it carries');
  const sent = calls.find((call) => call.options.method === 'GET' && call.url === V1 + '/keys');
  assert.ok(sent, 'the keys were never read');
  assert.equal(view.node.textContent.indexOf('tc_'), -1,
    'the list of keys carries a secret');
});
