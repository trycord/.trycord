// The devices this instance may reach a reader on.
//
// The rules that matter are about ownership: a device belongs to the account
// that registered it, a token already held by somebody else is not taken
// away, and a registration is removed when the account that made it is
// deleted.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

test('push device registration', async (t) => {
  // The feature is off by default in the base environment, so this instance
  // is started with it on - the flag is what the endpoint answers on.
  const instance = await startInstance({ env: { PUSH_NOTIFICATIONS_ENABLED: 'on' } });
  t.after(() => instance.stop());

  await t.test('a device is registered and listed without its token', async () => {
    const api = await registerUser(instance, 'pusher');
    const res = await api.post('/api/me/push-devices', {
      token: 'device-token-abc',
      platform: 'ios',
      instanceOrigin: instance.baseUrl,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.registered, true);

    const list = await api.get('/api/me/push-devices');
    assert.equal(list.status, 200);
    assert.equal(list.data.devices.length, 1);
    assert.equal(list.data.devices[0].platform, 'ios');
    assert.equal(list.data.enabled, true);
    // The token is the device's secret. A reader who can list their own
    // registry does not need it in the answer.
    assert.ok(!JSON.stringify(list.data).includes('device-token-abc'),
      'the token is not returned');
  });

  await t.test('registering the same device again updates it rather than duplicating it', async () => {
    const api = await registerUser(instance, 'again');
    await api.post('/api/me/push-devices', { token: 'token-repeat', platform: 'android' });
    await api.post('/api/me/push-devices', { token: 'token-repeat', platform: 'android' });
    const list = await api.get('/api/me/push-devices');
    assert.equal(list.data.devices.length, 1);
  });

  await t.test('a token already held by another account is refused', async () => {
    const first = await registerUser(instance, 'holder');
    await first.post('/api/me/push-devices', { token: 'shared-token', platform: 'ios' });

    const second = await registerUser(instance, 'claimer');
    const res = await second.post('/api/me/push-devices', { token: 'shared-token', platform: 'ios' });
    assert.equal(res.status, 409, 'a device is not taken from the account that has it');
    assert.equal(res.data.error.code, 'CONFLICT');

    const list = await first.get('/api/me/push-devices');
    assert.equal(list.data.devices.length, 1, 'the first account still has it');
  });

  await t.test('an unknown platform is refused', async () => {
    const api = await registerUser(instance, 'odd');
    const res = await api.post('/api/me/push-devices', { token: 't', platform: 'fax' });
    assert.equal(res.status, 400);
  });

  await t.test('a missing token is refused', async () => {
    const api = await registerUser(instance, 'empty');
    const res = await api.post('/api/me/push-devices', { platform: 'ios' });
    assert.equal(res.status, 400);
  });

  await t.test('a device is removed by its owner and by nobody else', async () => {
    const owner = await registerUser(instance, 'leaver');
    await owner.post('/api/me/push-devices', { token: 'to-remove', platform: 'ios' });

    const other = await registerUser(instance, 'stranger');
    const refused = await other.delete('/api/me/push-devices/to-remove');
    assert.equal(refused.status, 200, 'the request is answered');

    const still = await owner.get('/api/me/push-devices');
    assert.equal(still.data.devices.length, 1, 'another account did not remove it');

    const removed = await owner.delete('/api/me/push-devices/to-remove');
    assert.equal(removed.status, 200);
    const after = await owner.get('/api/me/push-devices');
    assert.equal(after.data.devices.length, 0);
  });

  await t.test('the registration is removed when the account is erased', async () => {
    const api = await registerUser(instance, 'erased');
    await api.post('/api/me/push-devices', { token: 'erased-token', platform: 'ios' });
    const before = await api.get('/api/me/push-devices');
    assert.equal(before.data.devices.length, 1);

    // The erasure is the operator-facing step at the end of the deletion
    // request, so it is driven where it lives rather than through the
    // request form.
    const accountDeletion = require('../../src/services/accountDeletion');
    await accountDeletion.eraseAccount({ userId: api.user.id, actorId: api.user.id });

    // The instance holds its own database, and this test reads it through a
    // second connection rather than through the module the instance is using.
    const path = require('path');
    const file = path.join(instance.dir, 'instance.db');
    const reader = await require('../../src/db/sqlite').connect(file);
    try {
      const rows = await reader.all('SELECT id FROM push_devices WHERE user_id = ?', [api.user.id]);
      assert.equal(rows.length, 0, 'the registration went with the account');
    } finally {
      await reader.close();
    }
  });

  // This one starts a second instance, so it comes last: an instance and the
  // modules it loaded belong together, and a second instance replaces them.
  await t.test('an instance with push switched off refuses the registration', async () => {
    const off = await startInstance({ env: { PUSH_NOTIFICATIONS_ENABLED: 'off' } });
    try {
      const api = await registerUser(off, 'unlucky');
      const res = await api.post('/api/me/push-devices', { token: 't', platform: 'ios' });
      assert.equal(res.status, 403, 'an instance that will not push says so');
      assert.equal(res.data.error.code, 'FEATURE_DISABLED');
    } finally {
      await off.stop();
    }
  });
});
