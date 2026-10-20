// The community's settings, read back and written.
//
// A setting that can be written but not read is a setting the interface
// cannot show: the box is empty, the operator types what they think is
// there, and the write replaces whatever was actually there.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { apiClient, registerUser } = require('../helpers/instance');
const { startInstance } = require('../helpers/instance');

test('the settings are read back as they stand', async (t) => {
  const instance = await startInstance({ client: false, publicSite: false });
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Community' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const serverId = created.data.serverId;

  const empty = await owner.get('/api/servers/' + serverId + '/settings');
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  assert.deepEqual(empty.data, {
    welcomeContent: '',
    welcomeEnabled: false,
    guidelines: '',
    notificationDefaults: '',
    interactionSettings: '',
  }, 'the settings of a new community are not empty');

  const written = await owner.patch('/api/servers/' + serverId + '/settings', {
    welcome_content: 'Welcome to the community.',
    welcome_enabled: true,
    guidelines: 'Be kind. No spam.',
    notification_defaults: '{"messages":true}',
    interaction_settings: '{"slowMode":false}',
  });
  assert.equal(written.status, 200, JSON.stringify(written.data));

  const read = await owner.get('/api/servers/' + serverId + '/settings');
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.welcomeContent, 'Welcome to the community.');
  assert.equal(read.data.welcomeEnabled, true);
  assert.equal(read.data.guidelines, 'Be kind. No spam.');
  assert.equal(read.data.notificationDefaults, '{"messages":true}');
  assert.equal(read.data.interactionSettings, '{"slowMode":false}');
});

test('a member may read the settings of the community they are in', async (t) => {
  const instance = await startInstance({ client: false, publicSite: false });
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Community' });
  const serverId = created.data.serverId;
  await owner.patch('/api/servers/' + serverId + '/settings', { guidelines: 'Be kind.' });

  const invite = await owner.post('/api/servers/' + serverId + '/invites', {});
  const member = await registerUser(instance, 'ada');
  const joined = await member.post('/api/invites/' + invite.data.code + '/join', {});
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  const read = await member.get('/api/servers/' + serverId + '/settings');
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.guidelines, 'Be kind.');
});

test('a member who cannot manage the community may not write the settings', async (t) => {
  const instance = await startInstance({ client: false, publicSite: false });
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Community' });
  const serverId = created.data.serverId;
  await owner.patch('/api/servers/' + serverId + '/settings', { guidelines: 'Be kind.' });

  const invite = await owner.post('/api/servers/' + serverId + '/invites', {});
  const member = await registerUser(instance, 'ada');
  await member.post('/api/invites/' + invite.data.code + '/join', {});

  const refused = await member.patch('/api/servers/' + serverId + '/settings', {
    guidelines: 'Anything I like.',
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));

  const read = await owner.get('/api/servers/' + serverId + '/settings');
  assert.equal(read.data.guidelines, 'Be kind.', 'the guidelines were changed by a member');
});

test('the settings are written as strings, and nothing else is accepted', async (t) => {
  const instance = await startInstance({ client: false, publicSite: false });
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Community' });
  const serverId = created.data.serverId;

  const refused = await owner.patch('/api/servers/' + serverId + '/settings', {
    welcome_content: 42,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.data));

  const empty = await owner.patch('/api/servers/' + serverId + '/settings', {});
  assert.equal(empty.status, 400, JSON.stringify(empty.data));
});
