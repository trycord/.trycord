// Sending, measured against a running server.
//
// Three things have to hold. A conversation the server reports as encrypted
// takes envelopes and nothing else - a client that put text there is a
// client whose message is refused. A conversation that is not fully
// encrypted has to be said out loud before the message goes out in the
// clear. And a refusal is a refusal: the client does not send the same
// message again in the clear.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startInstance, register, transportFor, recorder } from './helpers/instance.js';
import { server } from './helpers/server.js';
import * as e from '../../packages/e2ee/index.js';

const { client: serverClient } = server;

test('sending', async (t) => {
  await t.test('what each state means', async () => {
    assert.deepEqual(
      e.decide({ state: 'encrypted' }),
      { mode: 'encrypted', warn: null, state: 'encrypted' },
    );
    assert.deepEqual(
      e.decide({ state: 'not-encrypted' }),
      { mode: 'text', warn: null, state: 'not-encrypted' },
    );

    const mixed = e.decide({ state: 'mixed' });
    assert.equal(mixed.mode, 'text');
    assert.ok(mixed.warn && mixed.warn.length > 20, 'a mixed conversation must be said out loud');
    assert.ok(/not fully encrypted/i.test(mixed.warn));

    const changed = e.decide({ state: 'key-changed' });
    assert.equal(changed.mode, 'text');
    assert.ok(changed.warn && changed.warn.length > 20, 'a changed key must be said out loud');
    assert.ok(/key/i.test(changed.warn));
  });

  const instance = await startInstance();
  t.after(() => instance.stop());

  const alice = await register(instance, 'alice');
  const bob = await register(instance, 'bob');

  const calls = recorder(transportFor(alice));
  const client = await e.E2eeClient.open({
    store: e.memoryStore(),
    api: e.createE2eeApi(calls),
  });
  await client.ready({ userId: alice.user.id, label: 'alice laptop' });

  // Bob's device: the server's own, registered and publishing prekeys.
  const bobDevice = serverClient.createDevice(bob.user.id, 'bob phone');
  await bob.post('/api/e2ee/devices', serverClient.registerBody(bobDevice));
  await bob.post('/api/e2ee/prekeys', serverClient.publishBody(bobDevice, 4));

  const opened = await alice.post('/api/dms', { userId: bob.user.id });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const conversationId = opened.data.id;

  await t.test('a conversation with no key is not encrypted, and takes text', async () => {
    const state = await client.conversationState(conversationId);
    assert.equal(state.state, 'not-encrypted');
    const prepared = await client.prepareMessage(conversationId, { content: 'hello bob' });
    assert.equal(prepared.mode, 'text');
    assert.equal(prepared.warn, null);
    assert.equal(prepared.body.content, 'hello bob');
  });

  await t.test('a mixed conversation is said out loud before anything is sent', async () => {
    // The key is published for this device alone, so Bob's device is missing
    // it and the conversation is not fully encrypted.
    const seal = await e.sealForDevice(
      await e.newConversationKey(),
      client.device.id,
      client.device.publicKeys().identityDhKey,
      conversationId,
      1,
    );
    const published = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: client.device.id,
      epoch: 1,
      sealedKeys: [seal],
    });
    assert.equal(published.status, 201, JSON.stringify(published.data));

    const state = await client.conversationState(conversationId);
    assert.equal(state.state, 'mixed');

    const prepared = await client.prepareMessage(conversationId, { content: 'hello bob' });
    assert.equal(prepared.mode, 'text');
    assert.ok(prepared.warn, 'the reader has to be told');
    assert.ok(/not fully encrypted/i.test(prepared.warn));

    // Sending it without the reader acknowledging is refused.
    await assert.rejects(
      () => client.sendPrepared(prepared, (body) => alice.post('/api/dms/' + conversationId + '/messages', body)),
      (error) => error.code === 'E2EE_NOT_ACKNOWLEDGED',
    );

    // And with the reader's acknowledgement, it goes out - in the clear,
    // which is what the warning said would happen.
    const sent = await client.sendPrepared(
      prepared,
      (body) => alice.post('/api/dms/' + conversationId + '/messages', body),
      { acknowledged: true },
    );
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    assert.equal(sent.data.encrypted, false);
  });

  await t.test('the server refuses text in a conversation it reports as encrypted', async () => {
    // The client publishes the key again, sealed to the devices that are in
    // the conversation now - so both of them hold it.
    const published = await client.publishConversationKey(conversationId);
    assert.ok(published.epoch >= 2, 'the key moved to a new epoch');
    assert.deepEqual(published.devices.sort(), [bobDevice.deviceId, client.device.id].sort());

    const state = await client.conversationState(conversationId);
    assert.equal(state.state, 'encrypted', 'both devices hold the key now');
    assert.equal(state.encrypted, true);

    // The server refuses a text body.
    const refused = await alice.post('/api/dms/' + conversationId + '/messages', { content: 'in the clear' });
    assert.equal(refused.status, 400, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'E2EE_VALIDATION_ERROR');
    assert.ok(/encrypted/.test(refused.data.error.message));

    // And the client's own preparation produces envelopes, not text.
    const prepared = await client.prepareMessage(conversationId, { content: 'hello bob' });
    assert.equal(prepared.mode, 'encrypted');
    assert.equal(prepared.body.content, undefined, 'an encrypted message carries no text');
    assert.ok(Array.isArray(prepared.body.envelopes));
    assert.equal(prepared.body.envelopes.length, 1, 'one envelope for the other device');

    // The envelope the client produced is accepted.
    const sent = await client.sendPrepared(
      prepared,
      (body) => alice.post('/api/dms/' + conversationId + '/messages', body),
    );
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    assert.equal(sent.data.encrypted, true);
    assert.equal(sent.data.content, null, 'the stored message carries no text');
    assert.equal(sent.data.envelopes.length, 1);
  });

  await t.test('a refused message is not sent again in the clear', async () => {
    // A conversation the server does not call encrypted: an envelope is
    // refused, and the client does not answer that by sending text.
    const other = await alice.post('/api/dms', { userId: bob.user.id });
    const plain = other.data.id;
    const prepared = await client.prepareMessage(conversationId, { content: 'hello bob' });
    const envelope = prepared.body.envelopes[0];

    const before = calls.calls.length;
    await assert.rejects(
      () => client.sendPrepared(
        { mode: 'encrypted', warn: null, state: 'encrypted', body: { envelopes: [{ ...envelope, cid: plain }] } },
        (body) => alice.post('/api/dms/' + plain + '/messages', body),
      ),
      (error) => error.status === 400,
    );
    const posted = calls.calls.slice(before).filter((call) => call.path.indexOf('/messages') !== -1);
    assert.equal(posted.length, 1, 'the message is offered once and once only');
    assert.equal(posted[0].body.content, undefined, 'and nothing was sent in the clear');
  });
});
