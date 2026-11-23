// Invite codes: rolled short when not chosen, used as given when chosen.
//
// A code is the whole of the share - a link carries nothing else - so the
// rolled one is short enough to read out, and a chosen one is validated
// before it is stored and refused, not retried, when it is already taken.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, registerUser, apiClient } = require('../helpers/instance');

test('a rolled invite code is short and from the typeable alphabet', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const api = apiClient(instance.baseUrl, owner.token);
  const community = await api.post('/api/servers', { name: 'Codes' });
  const serverId = community.data.serverId;

  const made = await api.post('/api/servers/' + serverId + '/invites', {});
  assert.equal(made.status, 200);
  assert.match(made.data.code, /^[A-HJ-KM-NP-Z2-9]{7}$/, '7 letters or digits, none confusable');
});

test('an invite code chosen by the creator is stored as given', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const api = apiClient(instance.baseUrl, owner.token);
  const community = await api.post('/api/servers', { name: 'Chosen' });
  const serverId = community.data.serverId;

  const made = await api.post('/api/servers/' + serverId + '/invites', { code: 'launch-week' });
  assert.equal(made.status, 200);
  assert.equal(made.data.code, 'LAUNCH-WEEK');
});

test('a taken code is a conflict, not a silent second code', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const api = apiClient(instance.baseUrl, owner.token);
  const community = await api.post('/api/servers', { name: 'Taken' });
  const serverId = community.data.serverId;

  await api.post('/api/servers/' + serverId + '/invites', { code: 'samecode' });
  const second = await api.post('/api/servers/' + serverId + '/invites', { code: 'samecode' });
  assert.equal(second.status, 409);
});

test('a code that is not letters and digits is refused', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const api = apiClient(instance.baseUrl, owner.token);
  const community = await api.post('/api/servers', { name: 'Shapes' });
  const serverId = community.data.serverId;

  for (const bad of ['ab', 'has space', 'way-too-long-' + 'x'.repeat(24)]) {
    const made = await api.post('/api/servers/' + serverId + '/invites', { code: bad });
    assert.equal(made.status, 400, '"' + bad + '" is refused');
  }
});
