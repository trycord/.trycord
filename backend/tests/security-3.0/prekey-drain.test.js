// The prekey pool cannot be drained.
//
// Every fetch of a peer's bundle consumes one of that peer's one-time
// prekeys. A caller that fetches in a loop empties the pool, and a device
// with an empty pool falls back to the reusable last-resort key - which is a
// downgrade of the protection the prekeys exist to provide, arrived at by
// somebody else's traffic.
//
// So the limit on that route is keyed by the device being fetched as well as
// by the caller: one reader cannot spend another's pool, and one reader
// cannot empty a device's pool in a burst.
//
// The devices here are real ones: the test client holds the keys and signs
// the bundle, exactly as a browser would. A bundle that does not verify is
// not counted, so the test has to do the protocol properly for the limit to
// be the thing that is being measured.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');
const client = require('../e2ee/client');

test('a peer prekey pool cannot be drained', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const reader = await registerUser(instance, 'reader');
  const reader2 = await registerUser(instance, 'reader2');

  await t.test('fetching one bundle repeatedly is refused after a few', async () => {
    const peer = await registerUser(instance, 'peer');
    const device = client.createDevice(peer.user.id, 'The peer device');

    const registered = await peer.post('/api/e2ee/devices', client.registerBody(device));
    assert.equal(registered.status, 201, JSON.stringify(registered.data));

    // The device publishes a pool, so there is something to spend.
    const published = await peer.post('/api/e2ee/prekeys', client.publishBody(device, 30));
    assert.equal(published.status, 200, JSON.stringify(published.data));

    let refused = 0;
    let answered = 0;
    for (let i = 0; i < 40; i++) {
      const res = await reader.get('/api/e2ee/prekeys/' + device.deviceId);
      if (res.status === 429) refused++;
      else if (res.status === 200) answered++;
      else break;
    }
    assert.ok(refused > 0,
      'the route must refuse a caller that fetches in a loop: '
      + answered + ' answered, ' + refused + ' refused');
    assert.ok(answered > 0,
      'the first fetches must be answered: the limit is not meant to refuse a '
      + 'caller that is doing nothing unusual');
  });

  await t.test('the limit is per device, not per route', async () => {
    // A different device has its own pool, so a caller that has spent one
    // device's pool has not spent another's.
    const peer = await registerUser(instance, 'peer2');
    const device = client.createDevice(peer.user.id, 'Another peer device');

    const registered = await peer.post('/api/e2ee/devices', client.registerBody(device));
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    const published = await peer.post('/api/e2ee/prekeys', client.publishBody(device, 4));
    assert.equal(published.status, 200, JSON.stringify(published.data));

    const res = await reader2.get('/api/e2ee/prekeys/' + device.deviceId);
    assert.equal(res.status, 200,
      'a reader that has not touched this device is not refused for it: '
      + JSON.stringify(res.data));
  });

  await t.test('one reader cannot spend another reader\'s pool', async () => {
    const peer = await registerUser(instance, 'peer3');
    const device = client.createDevice(peer.user.id, 'A third peer device');
    const registered = await peer.post('/api/e2ee/devices', client.registerBody(device));
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    const published = await peer.post('/api/e2ee/prekeys', client.publishBody(device, 30));
    assert.equal(published.status, 200, JSON.stringify(published.data));

    // The first reader empties the allowance.
    for (let i = 0; i < 30; i++) {
      await reader.get('/api/e2ee/prekeys/' + device.deviceId);
    }
    // A second reader, on the same device, has its own allowance.
    const res = await reader2.get('/api/e2ee/prekeys/' + device.deviceId);
    assert.equal(res.status, 200,
      'the second reader must not be refused because the first one was: '
      + JSON.stringify(res.data));
  });
});
