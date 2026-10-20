// Revoking a device, on a phone.
//
// Revoking is the one thing on this screen that takes something away, so the
// screen says what it does before it does it: the device stops reading
// anything new, and the others have to rekey what they shared with it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installPhoneStub, resetPhone, find, buttonWithText, lastDialog } from './helpers.js';
import { fakeClient } from './fake-client.js';
import { waitFor } from '../helpers/dom-stub.js';

installPhoneStub();

const { encryptionBody } = await import('../../mobile/js/views/encryption.js');

test('revoking a device on a phone', async (t) => {
  await t.test('the screen says what revoking means', async () => {
    resetPhone();
    const client = fakeClient({
      devices: [
        { id: 'device-this-phone', label: 'This phone' },
        { id: 'device-old-laptop', label: 'The old laptop' },
      ],
    });
    const node = encryptionBody({ client: async () => client });
    assert.ok(await waitFor(() => /The old laptop/.test(node.textContent)));

    const text = node.textContent;
    assert.match(text, /stops it reading anything new/i, 'the screen does not say what revoking stops');
    assert.match(text, /rekey/i, 'the screen does not say what the other devices have to do');
  });

  await t.test('a device can be revoked, and the sheet asks first', async () => {
    resetPhone();
    const client = fakeClient({
      devices: [
        { id: 'device-this-phone', label: 'This phone' },
        { id: 'device-old-laptop', label: 'The old laptop' },
      ],
    });
    const node = encryptionBody({ client: async () => client });
    assert.ok(await waitFor(() => /The old laptop/.test(node.textContent)));

    const revoke = find(node, (n) => n.tagName === 'BUTTON'
      && n.getAttribute('aria-label') === 'Revoke The old laptop')[0];
    assert.ok(revoke, 'the other device cannot be revoked from the screen');
    revoke.click();

    const sheetNode = await waitFor(() => lastDialog(document.body));
    assert.ok(sheetNode, 'the screen did not ask before revoking');
    assert.match(sheetNode.textContent, /stops being able to read/i);
    assert.match(sheetNode.textContent, /rekey/i);

    const yes = buttonWithText(sheetNode, 'Revoke');
    assert.ok(yes, 'the sheet has no way to confirm');
    yes.click();

    assert.ok(await waitFor(() => client.calls.some((call) => call.method === 'revokeDevice')),
      'the device was not revoked');
    const call = client.calls.find((entry) => entry.method === 'revokeDevice');
    assert.equal(call.args[0], 'device-old-laptop', 'the wrong device was revoked');
  });

  await t.test('this phone cannot revoke itself', async () => {
    resetPhone();
    const client = fakeClient({
      devices: [
        { id: 'device-this-phone', label: 'This phone' },
        { id: 'device-old-laptop', label: 'The old laptop' },
      ],
    });
    const node = encryptionBody({ client: async () => client });
    assert.ok(await waitFor(() => /The old laptop/.test(node.textContent)));
    const self = find(node, (n) => n.tagName === 'BUTTON'
      && n.getAttribute('aria-label') === 'Revoke This phone')[0];
    assert.equal(self, undefined, 'this phone offers to revoke itself');
  });
});
