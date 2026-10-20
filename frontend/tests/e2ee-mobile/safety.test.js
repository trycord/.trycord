// The safety number with a peer, on a phone.
//
// Two people who read the same number over a channel they trust are talking
// to the same keys. The number changes when a device is added or revoked,
// which is the moment it is worth looking again - so the screen remembers the
// last one it saw and says so when it changes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installPhoneStub, resetPhone, fieldWithLabel, formFor } from './helpers.js';
import { fakeClient } from './fake-client.js';
import { waitFor } from '../helpers/dom-stub.js';

installPhoneStub();

const { encryptionBody } = await import('../../mobile/js/views/encryption.js');

test('the safety number with a peer, on a phone', async (t) => {
  await t.test('the screen shows the number', async () => {
    resetPhone();
    const client = fakeClient();
    const node = encryptionBody({ client: async () => client });

    const field = fieldWithLabel(node, 'The other person\'s user id');
    assert.ok(field, 'the screen does not ask for the peer');
    field.value = 'u2';
    formFor(node, field).submit();

    assert.ok(await waitFor(() => /00000 11111/.test(node.textContent)),
      'the screen did not show the safety number');
    assert.match(node.textContent, /00000 11111 22222 33333 44444 55555/,
      'the safety number is not in the groups a reader compares');
    assert.ok(client.calls.some((call) => call.method === 'safetyNumber' && call.args[0] === 'u2'),
      'the peer was not asked about');
  });

  await t.test('a change is flagged', async () => {
    resetPhone();
    const client = fakeClient();
    const node = encryptionBody({ client: async () => client });

    client.state.safety = {
      digits: '111112222233333444445555566666',
      display: '11111 22222 33333 44444 55555 66666',
    };
    let field = fieldWithLabel(node, 'The other person\'s user id');
    field.value = 'u3';
    formFor(node, field).submit();
    assert.ok(await waitFor(() => /11111 22222/.test(node.textContent)));
    assert.doesNotMatch(node.textContent, /has changed/i, 'a number that has not changed is flagged');

    // The peer adds a device: the number moves.
    client.state.safety = {
      digits: '999998888877777666665555544444',
      display: '99999 88888 77777 66666 55555 44444',
    };
    field = fieldWithLabel(node, 'The other person\'s user id');
    field.value = 'u3';
    formFor(node, field).submit();

    assert.ok(await waitFor(() => /has changed/i.test(node.textContent)),
      'the screen did not flag the change');
    assert.match(node.textContent, /The safety number has changed/);
    assert.match(node.textContent, /11111 22222 33333 44444 55555 66666/,
      'the screen does not say what the number was');
    assert.match(node.textContent, /Compare it again/i,
      'the screen does not tell the reader what to do about it');
  });

  await t.test('a number that has not changed is not flagged', async () => {
    resetPhone();
    const client = fakeClient();
    const node = encryptionBody({ client: async () => client });

    const field = fieldWithLabel(node, 'The other person\'s user id');
    field.value = 'u4';
    formFor(node, field).submit();
    assert.ok(await waitFor(() => /00000 11111/.test(node.textContent)));

    field.value = 'u4';
    formFor(node, field).submit();
    assert.ok(await waitFor(() => client.calls.filter((call) => call.method === 'safetyNumber').length === 2),
      'the peer was not asked about twice');
    assert.doesNotMatch(node.textContent, /has changed/i, 'an unchanged number is flagged');
  });
});
