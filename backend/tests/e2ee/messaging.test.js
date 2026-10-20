// The message body of an encrypted conversation, measured against a running
// instance.
//
// The protocol underneath is tested elsewhere. What is tested here is the
// part that decides what the server stores: an encrypted conversation takes
// an envelope and nothing else, a conversation that is not encrypted takes
// text, and a body the server cannot understand is refused with nothing
// written.
//
// The refusals matter more than the acceptances. A message the server cannot
// validate must not reach the table, because a message that is stored in the
// clear after an encryption failure is the one outcome this subsystem exists
// to prevent.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startE2eeInstance } = require('./instance');
const { registerUser } = require('../helpers/instance');

test('the body of an encrypted conversation', async (t) => {
  const instance = await startE2eeInstance();
  t.after(() => instance.stop());

  const client = require('./client');
  const db = require('../../src/db');
  const bodies = require('../../src/services/e2ee/bodies');
  const primitives = require('../../src/services/e2ee/primitives');

  const alice = await registerUser(instance, 'alice');
  const bob = await registerUser(instance, 'bob');
  const carol = await registerUser(instance, 'carol');

  const aliceDevice = client.createDevice('alice', 'alice laptop');
  const bobDevice = client.createDevice('bob', 'bob phone');
  const carolDevice = client.createDevice('carol', 'carol laptop');
  aliceDevice.userId = alice.user.id;
  bobDevice.userId = bob.user.id;
  carolDevice.userId = carol.user.id;

  for (const [api, device] of [[alice, aliceDevice], [bob, bobDevice], [carol, carolDevice]]) {
    const res = await api.post('/api/e2ee/devices', client.registerBody(device));
    assert.equal(res.status, 201, JSON.stringify(res.data));
  }
  await bob.post('/api/e2ee/prekeys', client.publishBody(bobDevice, 4));

  // The conversation between alice and bob, and the key agreement that lets
  // alice send bob an envelope.
  const opened = await alice.post('/api/dms', { userId: bob.user.id });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const conversationId = opened.data.id;

  const bundle = (await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId)).data.bundle;
  const agreed = client.initiate(aliceDevice, bundle);
  const context = { sid: 'session-alice-bob', cid: conversationId, to: bobDevice.deviceId };
  const init = client.buildInit(aliceDevice, context, agreed);
  const sent = client.encrypt(aliceDevice, agreed.state, Buffer.from('hello bob'), { ...context, init });
  const envelope = sent.envelope;

  const conversationKey = primitives.randomBytes(32);
  const sealFor = (device, epoch) => ({
    deviceId: device.deviceId,
    seal: client.sealConversationKey(
      conversationId,
      epoch,
      conversationKey,
      client.publicKeys(device).identityDhKey
    ),
  });

  await t.test('the stored form tells an envelope from text', async () => {
    const stored = bodies.encode([envelope]);
    const back = bodies.decode(stored);
    assert.equal(back.length, 1);
    assert.equal(back[0].ct, envelope.ct);

    // Ordinary text is not an envelope.
    assert.equal(bodies.decode('hello bob'), null);
    assert.equal(bodies.decode(''), null);
    assert.equal(bodies.decode(null), null);
    // A JSON object that is not this subsystem's marker is not an envelope
    // either.
    assert.equal(bodies.decode(JSON.stringify({ hello: 'bob' })), null);
    // The marker has to be exactly right.
    assert.equal(bodies.decode(JSON.stringify({ e2ee: 2, envelopes: [envelope] })), null);
    assert.equal(bodies.decode(JSON.stringify({ e2ee: 1, envelopes: [] })), null);

    // A text body that would be read back as an envelope is escaped, and
    // read back as the text it is.
    const ambiguous = JSON.stringify({ e2ee: 1, envelopes: [envelope] });
    const escaped = bodies.encodeText(ambiguous);
    assert.notEqual(escaped, ambiguous);
    assert.equal(bodies.decode(escaped), null, 'an escaped body is not an envelope');
    assert.equal(bodies.decodeText(escaped), ambiguous);

    // An ordinary message is stored byte for byte as it was typed.
    assert.equal(bodies.encodeText('hello bob'), 'hello bob');
  });

  await t.test('a conversation with no key published is not encrypted', async () => {
    const state = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(state.status, 200, JSON.stringify(state.data));
    assert.equal(state.data.state, 'not-encrypted');
    assert.equal(state.data.encrypted, false);
    assert.equal(state.data.epoch, 0);

    // A text body is what such a conversation takes, and it is stored as it
    // was written.
    const accepted = await bodies.accept(conversationId, alice.user.id, { content: 'hello bob' });
    assert.equal(accepted.encrypted, false);
    assert.equal(accepted.stored, 'hello bob');
    assert.equal(accepted.content, 'hello bob');
    assert.equal(accepted.encryption.state, 'not-encrypted');
  });

  await t.test('an envelope in a conversation that is not encrypted is refused', async () => {
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: [envelope] }),
      (e) => e.code === 'E2EE_VALIDATION_ERROR' && /not encrypted/.test(e.message)
    );
  });

  await t.test('a malformed body is refused', async () => {
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: 'not a list' }),
      (e) => e.code === 'E2EE_VALIDATION_ERROR'
    );
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: [] }),
      (e) => e.code === 'E2EE_VALIDATION_ERROR'
    );
  });

  await t.test('the conversation key is published and the conversation becomes encrypted', async () => {
    const res = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 1,
      sealedKeys: [sealFor(aliceDevice, 1), sealFor(bobDevice, 1)],
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));

    const state = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(state.data.state, 'encrypted');
    assert.equal(state.data.encrypted, true);
    assert.equal(state.data.epoch, 1);
  });

  await t.test('text is refused in an encrypted conversation', async () => {
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { content: 'hello bob' }),
      (e) => e.code === 'E2EE_VALIDATION_ERROR' && /encrypted/.test(e.message)
    );
  });

  await t.test('an envelope is accepted, and the text is not in it', async () => {
    const accepted = await bodies.accept(conversationId, alice.user.id, { envelopes: [envelope] });
    assert.equal(accepted.encrypted, true);
    assert.equal(accepted.content, null, 'an encrypted message carries no text');
    assert.equal(accepted.envelopes.length, 1);
    assert.equal(accepted.envelopes[0].ct, envelope.ct);
    assert.ok(!accepted.stored.includes('hello bob'), 'the stored form holds no plaintext');
    assert.equal(accepted.encryption.state, 'encrypted');
  });

  await t.test('an envelope the server cannot validate is refused', async () => {
    // A version this build does not implement. Refused, not downgraded.
    const future = { ...envelope, v: 2 };
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: [future] }),
      (e) => e.code === 'E2EE_UNSUPPORTED_VERSION'
    );

    // A malformed envelope: the header is missing.
    const malformed = { ...envelope };
    delete malformed.hct;
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: [malformed] }),
      (e) => e.code === 'E2EE_VALIDATION_ERROR'
    );

    // An envelope for another conversation.
    const elsewhere = { ...envelope, cid: 'another-conversation' };
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: [elsewhere] }),
      (e) => e.code === 'E2EE_VALIDATION_ERROR'
    );

    // An envelope that claims to come from somebody else's device.
    const impersonated = { ...envelope, from: carolDevice.deviceId };
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: [impersonated] }),
      (e) => e.code === 'E2EE_FORBIDDEN'
    );

    // An envelope addressed to a device that is not in the conversation.
    const outsider = { ...envelope, to: carolDevice.deviceId };
    await assert.rejects(
      () => bodies.accept(conversationId, alice.user.id, { envelopes: [outsider] }),
      (e) => e.code === 'E2EE_FORBIDDEN'
    );
  });

  await t.test('a member leaving moves the epoch', async () => {
    // Bob leaves the conversation. The server is not told: the membership is
    // read from the tables, so it notices by looking.
    await db.run(
      'DELETE FROM dm_members WHERE conversation_id = ? AND user_id = ?',
      [conversationId, bob.user.id]
    );

    // The key cannot be published again at the epoch it is on: the membership
    // has changed, and a member who left still holds the key they were given
    // until the epoch moves.
    const sameEpoch = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 1,
      sealedKeys: [sealFor(aliceDevice, 1)],
    });
    assert.equal(sameEpoch.status, 409, JSON.stringify(sameEpoch.data));
    assert.equal(sameEpoch.data.error.code, 'E2EE_CONFLICT');

    // A seal for a device that is not in the conversation is refused.
    const forBob = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 2,
      sealedKeys: [sealFor(aliceDevice, 2), sealFor(bobDevice, 2)],
    });
    assert.equal(forBob.status, 403, JSON.stringify(forBob.data));
    assert.equal(forBob.data.error.code, 'E2EE_FORBIDDEN');

    // The conversation is not encrypted any more: the key has to be moved
    // before it is.
    const stale = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(stale.data.state, 'key-changed');
    assert.equal(stale.data.encrypted, false);

    // The new epoch, sealed to the membership that is left.
    const moved = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 2,
      sealedKeys: [sealFor(aliceDevice, 2)],
    });
    assert.equal(moved.status, 201, JSON.stringify(moved.data));

    const rekeyed = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(rekeyed.data.state, 'encrypted');
    assert.equal(rekeyed.data.epoch, 2);
  });
});
