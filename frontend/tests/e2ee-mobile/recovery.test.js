// Recovering a lost device, on a phone.
//
// Recovering registers a NEW device. It does not bring the old one back: the
// old device keeps its identity until it is revoked, and revoking it is a
// separate, deliberate act. The screen says so before it asks for anything.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installPhoneStub, fieldWithLabel, formFor, order, positionOf } from './helpers.js';
import { fakeClient } from './fake-client.js';
import { waitFor } from '../helpers/dom-stub.js';

installPhoneStub();

const { encryptionBody } = await import('../../mobile/js/views/encryption.js');
const { createDevice } = await import('../../packages/e2ee/index.js');
const { State } = await import('../../packages/store.js');

State.user = { id: 'u1', username: 'reader' };

test('recovering a lost device on a phone', async (t) => {
  await t.test('the screen says what recovering does before it asks for anything', async () => {
    const client = fakeClient();
    const node = encryptionBody({ client: async () => client });

    const nodes = order(node);
    const said = positionOf(node, /Recovering registers a new device with new keys\./);
    const asked = nodes.indexOf(fieldWithLabel(node, 'The recovery key'));
    assert.ok(said > -1, 'the screen does not say that recovering registers a new device');
    assert.ok(asked > -1, 'the screen does not ask for the recovery key');
    assert.ok(said < asked, 'the screen asks for the key before it says what recovering does');
    assert.match(node.textContent, /does not take the lost device's identity/i,
      'the screen does not say that the lost device keeps its identity');
  });

  await t.test('recovering registers a new device rather than restoring the old one', async () => {
    const lost = await createDevice({ userId: 'u1', label: 'The lost phone', recoveryKey: 'the-old-recovery-key' });
    const material = { keys: lost.privateKeys(), sessions: {}, deviceId: lost.id };
    const client = fakeClient({ material });
    const node = encryptionBody({ client: async () => client });

    const field = fieldWithLabel(node, 'The recovery key');
    const form = formFor(node, field);
    assert.ok(form, 'the screen has no form to recover with');
    field.value = 'the-old-recovery-key';
    form.submit();

    assert.ok(await waitFor(() => client.calls.some((call) => call.method === 'recover')),
      'the recovery did not reach the server');

    const call = client.calls.find((entry) => entry.method === 'recover');
    const options = call.args[0];
    assert.equal(options.sourceDeviceId, lost.id, 'the recovery did not name the lost device');
    assert.notEqual(options.newDevice.id, lost.id, 'the new device took the lost device\'s identity');
    assert.notEqual(options.newDevice.keys.sk.privateKey, lost.keys.sk.privateKey,
      'the new device took the lost device\'s keys');
    assert.match(options.newDevice.label, /\(recovered\)$/, 'the new device is not marked as recovered');

    // The new device is the one this phone is, and it is registered and has
    // prekeys to offer.
    assert.ok(client.calls.some((entry) => entry.method === 'adoptDevice'
      && entry.args[0] === options.newDevice.id), 'the phone did not take the new device');
    assert.ok(client.calls.some((entry) => entry.method === 'register'), 'the new device was not registered');
    assert.ok(client.calls.some((entry) => entry.method === 'publishPrekeys'), 'the new device has no prekeys');

    assert.ok(await waitFor(() => /now a new device/.test(node.textContent)),
      'the screen does not say that this phone is now a new device');
    assert.match(node.textContent, /Revoke the lost one/i,
      'the screen does not say that the lost device has to be revoked');
  });

  await t.test('the recovery key is not left in the field', async () => {
    const lost = await createDevice({ userId: 'u1', label: 'The lost phone', recoveryKey: 'the-old-recovery-key' });
    const material = { keys: lost.privateKeys(), sessions: {}, deviceId: lost.id };
    const client = fakeClient({ material });
    const node = encryptionBody({ client: async () => client });

    const field = fieldWithLabel(node, 'The recovery key');
    field.value = 'the-old-recovery-key';
    formFor(node, field).submit();

    assert.ok(await waitFor(() => /now a new device/.test(node.textContent)));
    assert.equal(field.value, '', 'the recovery key is still in the field');
  });
});
