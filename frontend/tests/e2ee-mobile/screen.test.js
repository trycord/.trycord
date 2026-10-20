// The phone's encryption settings.
//
// The screen is the phone's half of the account's encryption settings: the
// device this phone is, the devices the account has, the safety number with a
// peer, the key backup, and the way back into a device that was lost.
//
// These checks ask the screen what it shows, and what it offers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installPhoneStub, resetPhone, find } from './helpers.js';
import { fakeClient } from './fake-client.js';
import { waitFor } from '../helpers/dom-stub.js';

installPhoneStub();

const { encryptionBody } = await import('../../mobile/js/views/encryption.js');

test('the encryption screen on a phone', async (t) => {
  await t.test('it lists this device and the account\'s devices', async () => {
    resetPhone();
    const client = fakeClient({
      devices: [
        { id: 'device-this-phone', label: 'This phone', keyFingerprint: 'a1b2', recoveryEnabled: true },
        { id: 'device-old-laptop', label: 'The old laptop', keyFingerprint: 'c3d4', recoveryEnabled: false },
      ],
    });
    const node = encryptionBody({ client: async () => client });

    assert.ok(
      await waitFor(() => /The old laptop/.test(node.textContent) && /A1B2C3D4/.test(node.textContent)),
      'the screen did not draw this device and the account\'s devices',
    );

    const text = node.textContent;
    assert.match(text, /This device/, 'the screen says which device it is about');
    assert.match(text, /This account's devices/, 'and which devices the account has');
    assert.match(text, /This phone/, 'this device is on it');
    assert.match(text, /The old laptop/, 'and the other one is too');
    assert.match(text, /Registered with the server/, 'the screen says whether this device is registered');
    assert.match(text, /A1B2C3D4 E5F60718/, 'the fingerprint is in the blocks a reader compares');
  });

  await t.test('it says when this phone has no device yet', async () => {
    resetPhone();
    const client = fakeClient({ device: null });
    const node = encryptionBody({ client: async () => client });
    assert.ok(await waitFor(() => /no device yet/.test(node.textContent)));
    const register = find(node, (n) => n.tagName === 'BUTTON' && /Register this phone/.test(n.textContent))[0];
    assert.ok(register, 'the screen does not offer to register this phone');
  });

  await t.test('the screen keeps the rules it says it keeps', async () => {
    resetPhone();
    const client = fakeClient({ devices: [{ id: 'device-old-laptop', label: 'The old laptop' }] });
    const node = encryptionBody({ client: async () => client });
    const drawn = await waitFor(() => /The old laptop/.test(node.textContent) && /shown once/i.test(node.textContent));
    assert.ok(drawn, 'the screen did not draw its rules: ' + node.textContent);
    const text = node.textContent;
    assert.match(text, /private keys stay on this phone/i, 'the screen says the private keys stay here');
    assert.match(text, /cannot open/i, 'the screen says the server cannot open the sealed blob');
    assert.match(text, /shown once/i, 'the screen says the recovery key is shown once');
    assert.match(text, /registers a new device/i, 'the screen says recovering registers a new device');
  });
});
