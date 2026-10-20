// The account's encryption settings.
//
// The page shows the devices the account has registered, where this
// browser's private keys are, the safety number with a peer, and the way
// back into a device that was lost. It is the only place a reader can see
// what the account's keys are, so it says where they are and what the
// recovery key is for.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from '../helpers/dom-stub.js';

installDomStub();
const { encryptionView } = await import('../../js/features/encryption.js');

test('the encryption settings', async (t) => {
  await t.test('the page is built', () => {
    const page = encryptionView();
    assert.ok(page && page.node, 'the page has a node');
    assert.equal(typeof page.onMount, 'function');
    const text = page.node.textContent;
    assert.ok(/Encryption/.test(text), 'the page says what it is');
    assert.ok(/devices/i.test(text), 'the devices are on it');
    assert.ok(/safety number/i.test(text), 'the safety number is on it');
    assert.ok(/recovery/i.test(text), 'and so is the recovery');
  });

  await t.test('the page mounts without a device and without a server', async () => {
    const page = encryptionView();
    await page.onMount();
    // The device is registered when there is one to register; with no signed
    // in reader there is none, and the page says so rather than failing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = page.node.textContent;
    assert.ok(text.length > 0);
    page.cleanup();
  });
});
