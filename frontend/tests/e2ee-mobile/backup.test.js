// The key backup and the recovery key, on a phone.
//
// The recovery key is shown once. The screen says so before it shows it, and
// once it has shown it the screen offers no way to see it again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installPhoneStub, buttonWithLabel, buttonWithText } from './helpers.js';
import { fakeClient } from './fake-client.js';
import { waitFor } from '../helpers/dom-stub.js';

installPhoneStub();

const { encryptionBody } = await import('../../mobile/js/views/encryption.js');

test('the key backup on a phone', async (t) => {
  await t.test('the screen says whether there is a backup', async () => {
    const client = fakeClient();
    const node = encryptionBody({ client: async () => client });
    assert.ok(await waitFor(() => /There is no key backup/.test(node.textContent)));
    assert.match(node.textContent, /There is no key backup/, 'the screen does not say that there is none');
  });

  await t.test('the recovery key is shown once, and never offered again', async () => {
    localStorage.clear();
    const client = fakeClient();
    const node = encryptionBody({ client: async () => client });
    assert.ok(await waitFor(() => buttonWithLabel(node, 'Show the recovery key')),
      'the screen does not offer the recovery key at all');

    const show = buttonWithLabel(node, 'Show the recovery key');
    show.click();

    const sheetNode = await waitFor(() => document.body.querySelector('[role="dialog"]'));
    assert.ok(sheetNode, 'the recovery key did not open in a sheet');
    assert.match(sheetNode.textContent, /only time the recovery key is shown/i,
      'the sheet does not say that the key is shown once');
    assert.ok(sheetNode.textContent.includes('the-recovery-key-of-this-device'),
      'the sheet does not carry the key');

    // The screen offers it no more.
    assert.ok(await waitFor(() => /Shown once\. It cannot be shown again\./.test(node.textContent)),
      'the screen does not say that the key cannot be shown again');
    assert.equal(buttonWithLabel(node, 'Show the recovery key'), null,
      'the screen still offers the recovery key');

    // And the key is gone from the sheet when it is closed.
    const done = buttonWithText(sheetNode, 'I have it');
    assert.ok(done, 'the sheet has no way to close');
    done.click();
    assert.ok(await waitFor(() => !document.body.querySelector('[role="dialog"]')),
      'the sheet did not close');
  });

  await t.test('the key is not left in the screen once the sheet is closed', async () => {
    localStorage.clear();
    const client = fakeClient();
    const node = encryptionBody({ client: async () => client });
    assert.ok(await waitFor(() => buttonWithLabel(node, 'Show the recovery key')));
    buttonWithLabel(node, 'Show the recovery key').click();
    const sheetNode = await waitFor(() => document.body.querySelector('[role="dialog"]'));
    buttonWithText(sheetNode, 'I have it').click();
    assert.ok(await waitFor(() => !document.body.querySelector('[role="dialog"]')));
    assert.ok(!node.textContent.includes('the-recovery-key-of-this-device'),
      'the screen still carries the recovery key');
  });
});
