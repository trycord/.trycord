// A conversation that is encrypted, end to end over HTTP.
//
// The protocol underneath has its own tests. What is measured here is the
// product behaviour: what the server stores when a client sends an
// envelope, what it stores when a client sends text to a conversation that
// is not encrypted, what it refuses, and what the reader is handed back.
//
// The assertions are about the row, not about the response. A response that
// says "encrypted" while the table holds the plaintext would pass a test
// that looked at the response, and would fail the people whose messages it
// is.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startE2eeInstance } = require('../e2ee/instance');
const { registerUser } = require('../helpers/instance');

/** Wait for an event of a kind to arrive, or return null. */
async function waitForEvent(events, type, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find((e) => e.type === type);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Open a socket for a signed-in account. */
async function openSocket(instance, api, channelId) {
  const ticket = await api.post('/api/auth/ws/ticket', {});
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  const socket = new WebSocket('ws://127.0.0.1:' + instance.port + '/?ticket=' + ticket.data.ticket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const events = [];
  socket.on('message', (raw) => {
    try { events.push(JSON.parse(raw.toString())); } catch { /* not an event */ }
  });
  if (channelId) {
    socket.send(JSON.stringify({ type: 'join', channelId }));
    // The server handles the join before it handles the next frame that
    // arrives: the frame loop drains its promises between frames. The wait
    // keeps the two frames in separate turns of the event loop, so the room
    // is joined before the message that needs it is sent.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { socket, events };
}

test('a message in an encrypted conversation', async (t) => {
  const instance = await startE2eeInstance();
  t.after(() => instance.stop());

  const client = require('../e2ee/client');
  const db = require('../../src/db');
  const e2ee = require('../../src/services/e2ee');
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
  await bob.post('/api/e2ee/prekeys', client.publishBody(bobDevice, 8));
  await alice.post('/api/e2ee/prekeys', client.publishBody(aliceDevice, 8));

  // Two conversations: one that will be encrypted, one that will not.
  const encryptedDm = await alice.post('/api/dms', { userId: bob.user.id });
  assert.equal(encryptedDm.status, 200, JSON.stringify(encryptedDm.data));
  const encryptedId = encryptedDm.data.id;

  const plainDm = await alice.post('/api/dms', { userId: carol.user.id });
  assert.equal(plainDm.status, 200, JSON.stringify(plainDm.data));
  const plainId = plainDm.data.id;

  // The key agreement that lets alice send bob an envelope.
  const bundle = (await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId)).data.bundle;
  const agreed = client.initiate(aliceDevice, bundle);
  const context = { sid: 'session-alice-bob', cid: encryptedId, to: bobDevice.deviceId };
  const init = client.buildInit(aliceDevice, context, agreed);
  const first = client.encrypt(aliceDevice, agreed.state, Buffer.from('the first secret'), { ...context, init });

  // Bob's half: he reads the first message, and his ratchet state is what
  // reads the second one.
  const aliceBundle = (await bob.get('/api/e2ee/prekeys/' + aliceDevice.deviceId)).data.bundle;
  const bobState = client.respond(bobDevice, first.envelope, aliceBundle, context).state;

  const conversationKey = primitives.randomBytes(32);
  const sealFor = (conversationId, device, epoch) => ({
    deviceId: device.deviceId,
    seal: client.sealConversationKey(
      conversationId,
      epoch,
      conversationKey,
      client.publicKeys(device).identityDhKey
    ),
  });

  await t.test('a conversation with no key published is not encrypted', async () => {
    const state = await alice.get('/api/e2ee/conversations/' + plainId + '/state');
    assert.equal(state.status, 200, JSON.stringify(state.data));
    assert.equal(state.data.state, 'not-encrypted');
    assert.equal(state.data.encrypted, false);

    // A message there is stored the way it always was: as text, exactly as
    // it was written.
    const res = await alice.post('/api/dms/' + plainId + '/messages', { content: 'hello in the clear' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.content, 'hello in the clear');
    assert.equal(res.data.encrypted, false);
    assert.equal(res.data.encryption.state, 'not-encrypted');

    const row = await db.get('SELECT * FROM dm_messages WHERE id = ?', [res.data.id]);
    assert.equal(row.content, 'hello in the clear', 'the row holds the text');
  });

  await t.test('an envelope in a conversation that is not encrypted is refused', async () => {
    const before = await db.get('SELECT COUNT(*) AS n FROM dm_messages');
    const res = await alice.post('/api/dms/' + plainId + '/messages', {
      envelopes: [first.envelope],
    });
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'E2EE_VALIDATION_ERROR');
    const after = await db.get('SELECT COUNT(*) AS n FROM dm_messages');
    assert.equal(after.n, before.n, 'nothing was stored');
  });

  await t.test('the conversation key is published and the conversation becomes encrypted', async () => {
    const res = await alice.post('/api/e2ee/conversations/' + encryptedId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 1,
      sealedKeys: [sealFor(encryptedId, aliceDevice, 1), sealFor(encryptedId, bobDevice, 1)],
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));

    const state = await alice.get('/api/e2ee/conversations/' + encryptedId + '/state');
    assert.equal(state.data.state, 'encrypted');
    assert.equal(state.data.encrypted, true);
    assert.equal(state.data.epoch, 1);
    assert.deepEqual(state.data.missingDevices, []);
  });

  await t.test('an envelope the server cannot validate is refused, and nothing is stored', async () => {
    const before = await db.get('SELECT COUNT(*) AS n FROM dm_messages');

    // A version this build does not implement. Refused, never downgraded.
    const future = await alice.post('/api/dms/' + encryptedId + '/messages', {
      envelopes: [{ ...first.envelope, v: 2 }],
    });
    assert.equal(future.status, 400, JSON.stringify(future.data));
    assert.equal(future.data.error.code, 'E2EE_UNSUPPORTED_VERSION');

    // A malformed body: the header is missing.
    const malformed = { ...first.envelope };
    delete malformed.hct;
    const broken = await alice.post('/api/dms/' + encryptedId + '/messages', { envelopes: [malformed] });
    assert.equal(broken.status, 400, JSON.stringify(broken.data));
    assert.equal(broken.data.error.code, 'E2EE_VALIDATION_ERROR');

    // A body that is not a list of envelopes at all.
    const notAList = await alice.post('/api/dms/' + encryptedId + '/messages', { envelopes: 'nonsense' });
    assert.equal(notAList.status, 400, JSON.stringify(notAList.data));

    const after = await db.get('SELECT COUNT(*) AS n FROM dm_messages');
    assert.equal(after.n, before.n, 'a refused message leaves nothing behind');
  });

  await t.test('text in an encrypted conversation is refused, and nothing is stored', async () => {
    const before = await db.get('SELECT COUNT(*) AS n FROM dm_messages');
    const res = await alice.post('/api/dms/' + encryptedId + '/messages', { content: 'plain text' });
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'E2EE_VALIDATION_ERROR');
    const after = await db.get('SELECT COUNT(*) AS n FROM dm_messages');
    assert.equal(after.n, before.n, 'a refused message leaves nothing behind');
  });

  await t.test('a message in an encrypted conversation is stored as an envelope', async () => {
    const plaintext = 'the words that must never be stored';
    const sent = client.encrypt(aliceDevice, first.state, Buffer.from(plaintext), context);

    const res = await alice.post('/api/dms/' + encryptedId + '/messages', {
      envelopes: [sent.envelope],
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.encrypted, true);
    assert.equal(res.data.content, null, 'the response carries no text');
    assert.equal(res.data.envelopes.length, 1);
    assert.equal(res.data.envelopes[0].ct, sent.envelope.ct);
    assert.equal(res.data.encryption.state, 'encrypted');

    // The row. Not the response: the row.
    const row = await db.get('SELECT * FROM dm_messages WHERE id = ?', [res.data.id]);
    assert.ok(row, 'the message was stored');
    const view = JSON.stringify(row);
    assert.ok(!view.includes(plaintext), 'the plaintext must not be in the row, in whole or in part');
    assert.ok(!row.content.includes(plaintext), 'the plaintext must not be in the content column');

    // What is in the row is the envelope, and it is the envelope that was
    // sent.
    const stored = JSON.parse(row.content);
    assert.equal(stored.e2ee, 1);
    assert.equal(stored.envelopes.length, 1);
    assert.equal(stored.envelopes[0].ct, sent.envelope.ct);
    assert.equal(stored.envelopes[0].cid, encryptedId);
    assert.equal(stored.envelopes[0].from, aliceDevice.deviceId);
    assert.equal(stored.envelopes[0].to, bobDevice.deviceId);
  });

  await t.test('the reader is handed the envelope, and the envelope opens', async () => {
    const history = await bob.get('/api/dms/' + encryptedId + '/messages');
    assert.equal(history.status, 200, JSON.stringify(history.data));
    const encrypted = history.data.filter((m) => m.encrypted);
    assert.equal(encrypted.length, 1, 'the history holds the encrypted message');
    assert.equal(encrypted[0].content, null, 'the ciphertext is not handed back as the text');
    assert.equal(encrypted[0].envelopes.length, 1);

    // The message the client sent is the message the server stored: the
    // reader's ratchet state opens it.
    const read = await alice.get('/api/dms/' + encryptedId + '/messages');
    const row = read.data.find((m) => m.encrypted);
    const opened = require('../../src/services/e2ee/ratchet').decrypt(
      bobState, row.envelopes[0], { sid: row.envelopes[0].sid, cid: encryptedId, to: bobDevice.deviceId }
    );
    assert.equal(opened.plaintext.toString('utf8'), 'the words that must never be stored');
  });

  await t.test('a conversation whose members do not all hold the key is not encrypted', async () => {
    // A key that leaves bob's device out: the conversation is mixed, and it
    // says so.
    const mixed = await alice.post('/api/e2ee/conversations/' + encryptedId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 2,
      sealedKeys: [sealFor(encryptedId, aliceDevice, 2)],
    });
    assert.equal(mixed.status, 201, JSON.stringify(mixed.data));

    const state = await alice.get('/api/e2ee/conversations/' + encryptedId + '/state');
    assert.equal(state.data.state, 'mixed');
    assert.equal(state.data.encrypted, false);
    assert.deepEqual(state.data.missingDevices, [bobDevice.deviceId]);

    // The message says so: the conversation is not encrypted, so the message
    // is stored as text and the client is told what is true.
    const res = await alice.post('/api/dms/' + encryptedId + '/messages', { content: 'nobody can read this' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.encrypted, false);
    assert.equal(res.data.encryption.state, 'mixed');
    assert.equal(res.data.encryption.encrypted, false);

    const row = await db.get('SELECT * FROM dm_messages WHERE id = ?', [res.data.id]);
    assert.equal(row.content, 'nobody can read this');
  });

  await t.test('the realtime path carries the envelope and refuses what the REST path refuses', async () => {
    // A community with a channel, so the socket path has a conversation of
    // its own.
    const community = await alice.post('/api/servers', {
      name: 'Encrypted Community',
      description: 'A community whose channel is encrypted.',
    });
    assert.equal(community.status, 200, JSON.stringify(community.data));
    const serverId = community.data.serverId;
    const channelId = community.data.channelId;

    const invite = await alice.post('/api/servers/' + serverId + '/invites', { maxUses: 5 });
    assert.equal(invite.status, 200, JSON.stringify(invite.data));
    const joined = await bob.post('/api/invites/' + invite.data.code + '/join', {});
    assert.equal(joined.status, 200, JSON.stringify(joined.data));

    // The channel's key, sealed to both member devices.
    const key = await alice.post('/api/e2ee/conversations/' + channelId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 1,
      sealedKeys: [sealFor(channelId, aliceDevice, 1), sealFor(channelId, bobDevice, 1)],
    });
    assert.equal(key.status, 201, JSON.stringify(key.data));
    const state = await alice.get('/api/e2ee/conversations/' + channelId + '/state');
    assert.equal(state.data.state, 'encrypted');

    // A session of its own for the channel.
    const channelBundle = (await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId)).data.bundle;
    const channelAgreed = client.initiate(aliceDevice, channelBundle);
    const channelContext = { sid: 'session-alice-bob-channel', cid: channelId, to: bobDevice.deviceId };
    const channelInit = client.buildInit(aliceDevice, channelContext, channelAgreed);
    const channelSent = client.encrypt(
      aliceDevice, channelAgreed.state, Buffer.from('a secret over the socket'), { ...channelContext, init: channelInit }
    );

    const aliceSocket = await openSocket(instance, alice, channelId);
    const bobSocket = await openSocket(instance, bob, channelId);
    t.after(() => {
      // Terminated rather than closed: the close handshake waits for the
      // server, and the run must not be held open by a socket.
      aliceSocket.socket.terminate();
      bobSocket.socket.terminate();
    });

    // The socket carries the envelope, and the store holds the envelope.
    aliceSocket.socket.send(JSON.stringify({ type: 'msg', envelopes: [channelSent.envelope] }));
    let event = await waitForEvent(bobSocket.events, 'message', 2000);
    if (!event) {
      // The room was not joined in time. Join again and send again.
      aliceSocket.socket.send(JSON.stringify({ type: 'join', channelId }));
      bobSocket.socket.send(JSON.stringify({ type: 'join', channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      aliceSocket.socket.send(JSON.stringify({ type: 'msg', envelopes: [channelSent.envelope] }));
      event = await waitForEvent(bobSocket.events, 'message', 5000);
    }
    assert.ok(event, 'the message event arrived over the socket');
    assert.equal(event.encrypted, true);
    assert.equal(event.content, null, 'the event carries no ciphertext as if it were text');
    assert.equal(event.envelopes.length, 1);
    assert.equal(event.envelopes[0].ct, channelSent.envelope.ct);

    const row = await db.get('SELECT * FROM messages WHERE id = ?', [event.id]);
    assert.ok(row, 'the message was stored');
    assert.ok(!JSON.stringify(row).includes('a secret over the socket'), 'the plaintext is not in the row');

    // The socket refuses what the REST path refuses.
    const before = await db.get('SELECT COUNT(*) AS n FROM messages');
    aliceSocket.socket.send(JSON.stringify({ type: 'msg', envelopes: [{ ...channelSent.envelope, v: 2 }] }));
    aliceSocket.socket.send(JSON.stringify({ type: 'msg', content: 'plain text over the socket' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await db.get('SELECT COUNT(*) AS n FROM messages');
    assert.equal(after.n, before.n, 'the socket stored nothing the REST path would refuse');
  });

  await t.test('a member leaving an encrypted conversation moves the epoch', async () => {
    // The community from the socket test: alice and bob are in it, and the
    // channel is encrypted.
    const community = await alice.post('/api/servers', {
      name: 'Leaving Community',
      description: 'A community a member leaves.',
    });
    const serverId = community.data.serverId;
    const channelId = community.data.channelId;
    const invite = await alice.post('/api/servers/' + serverId + '/invites', { maxUses: 5 });
    await bob.post('/api/invites/' + invite.data.code + '/join', {});
    await alice.post('/api/e2ee/conversations/' + channelId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 1,
      sealedKeys: [sealFor(channelId, aliceDevice, 1), sealFor(channelId, bobDevice, 1)],
    });

    const encrypted = await alice.get('/api/e2ee/conversations/' + channelId + '/state');
    assert.equal(encrypted.data.state, 'encrypted');

    // Bob leaves the community.
    const left = await bob.post('/api/servers/' + serverId + '/leave', {});
    assert.equal(left.status, 200, JSON.stringify(left.data));

    // The epoch has to move: a member who left still holds the key they
    // were given until it does.
    const sameEpoch = await alice.post('/api/e2ee/conversations/' + channelId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 1,
      sealedKeys: [sealFor(channelId, aliceDevice, 1)],
    });
    assert.equal(sameEpoch.status, 409, JSON.stringify(sameEpoch.data));
    assert.equal(sameEpoch.data.error.code, 'E2EE_CONFLICT');

    // A seal for a device that is not in the conversation is refused.
    const forBob = await alice.post('/api/e2ee/conversations/' + channelId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 2,
      sealedKeys: [sealFor(channelId, aliceDevice, 2), sealFor(channelId, bobDevice, 2)],
    });
    assert.equal(forBob.status, 403, JSON.stringify(forBob.data));
    assert.equal(forBob.data.error.code, 'E2EE_FORBIDDEN');

    // The conversation says what is true of it: the key has to move.
    const stale = await alice.get('/api/e2ee/conversations/' + channelId + '/state');
    assert.equal(stale.data.state, 'key-changed');
    assert.equal(stale.data.encrypted, false);

    // The new epoch, sealed to the membership that is left.
    const moved = await alice.post('/api/e2ee/conversations/' + channelId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 2,
      sealedKeys: [sealFor(channelId, aliceDevice, 2)],
    });
    assert.equal(moved.status, 201, JSON.stringify(moved.data));

    const rekeyed = await alice.get('/api/e2ee/conversations/' + channelId + '/state');
    assert.equal(rekeyed.data.state, 'encrypted');
    assert.equal(rekeyed.data.epoch, 2);
  });

  await t.test('the state endpoint reports the truth about each conversation', async () => {
    const plain = await alice.get('/api/e2ee/conversations/' + plainId + '/state');
    assert.equal(plain.data.state, 'not-encrypted');
    assert.equal(plain.data.encrypted, false);

    const mixed = await alice.get('/api/e2ee/conversations/' + encryptedId + '/state');
    assert.equal(mixed.data.state, 'mixed');
    assert.equal(mixed.data.encrypted, false);
    assert.deepEqual(mixed.data.missingDevices, [bobDevice.deviceId]);
    assert.ok(mixed.data.memberDevices.length >= 2, 'the devices of the members are named');

    // An outsider cannot ask about a conversation it is not in.
    const outsider = await carol.get('/api/e2ee/conversations/' + encryptedId + '/state');
    assert.equal(outsider.status, 403, JSON.stringify(outsider.data));
  });

  await t.test('an encrypted attachment stores ciphertext, and the server holds no key', async () => {
    const fileText = 'the bytes of a file only the members can read';
    const fileKey = primitives.randomBytes(32);
    // The client encrypts the file before it uploads it.
    const iv = primitives.randomBytes(primitives.GCM_IV_BYTES);
    const sealed = primitives.encrypt(fileKey, iv, Buffer.from(fileText), Buffer.from('trycord-e2ee-v1|attachment'));
    const ciphertext = Buffer.concat([sealed.iv, sealed.ciphertext, sealed.tag]);

    // The attachment id is the client's, so the seal can be bound to it.
    const attachmentId = 'attachment-' + Date.now();
    const seal = client.sealAttachmentKey(
      encryptedId, attachmentId, fileKey, client.publicKeys(bobDevice).identityDhKey
    );

    const stored = await e2ee.storeEncryptedAttachment(alice.user.id, {
      id: attachmentId,
      conversationId: encryptedId,
      filename: 'secret.txt',
      mime: 'application/octet-stream',
      buffer: ciphertext,
      sealedKeys: [{ deviceId: bobDevice.deviceId, seal }],
    });
    assert.equal(stored.id, attachmentId);

    // What is on disk is the ciphertext, not the file.
    const attachment = await db.get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
    assert.ok(attachment, 'the file was stored');
    const bytes = require('fs').readFileSync(
      require('path').join(process.env.UPLOAD_DIR, 'channel', 'dm-' + encryptedId, 'attachment', attachmentId)
    );
    assert.ok(!bytes.toString('utf8').includes(fileText), 'the file is not stored in the clear');
    assert.ok(bytes.equals(ciphertext), 'the file is stored as the ciphertext that was uploaded');

    // The key is not in the server's reach: only the seal is, and the
    // member's device is the one that opens it.
    const keys = await db.all('SELECT * FROM e2ee_attachment_keys WHERE attachment_id = ?', [attachmentId]);
    assert.equal(keys.length, 1);
    assert.ok(!JSON.stringify(keys).includes(fileKey.toString('hex')), 'the key is not in the server view');
    const opened = client.openAttachmentKey(encryptedId, attachmentId, JSON.parse(keys[0].sealed_key), bobDevice);
    assert.ok(opened.equals(fileKey), 'the member device opens the seal');

    // A plaintext key is refused rather than quietly ignored.
    await assert.rejects(
      () => e2ee.storeEncryptedAttachment(alice.user.id, {
        id: attachmentId + '-two',
        conversationId: encryptedId,
        filename: 'secret.txt',
        buffer: ciphertext,
        key: fileKey.toString('base64'),
        sealedKeys: [{ deviceId: bobDevice.deviceId, seal }],
      }),
      (e) => e.code === 'E2EE_VALIDATION_ERROR'
    );
  });
});
