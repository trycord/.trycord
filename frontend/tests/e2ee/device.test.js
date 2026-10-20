// The device, against a running server.
//
// The client registers its public keys, publishes prekeys, and opens a
// session with a peer - all over the server's own API. The private halves
// stay on the device: what the server is given is the public keys, a
// signature over the bundle, and the private material sealed under a key
// the server never sees.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startInstance, register, transportFor } from './helpers/instance.js';
import { server } from './helpers/server.js';
import * as e from '../../packages/e2ee/index.js';

const { client: serverClient, primitives } = server;

test('the device, against a running server', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const alice = await register(instance, 'alice');
  const bob = await register(instance, 'bob');

  const client = await e.E2eeClient.open({
    store: e.memoryStore(),
    api: e.createE2eeApi(transportFor(alice)),
  });

  await t.test('the device registers with its public keys', async () => {
    const device = await client.ready({ userId: alice.user.id, label: 'alice laptop' });
    assert.ok(device.id, 'the device has an id');
    assert.ok(device.recoveryKey, 'the device has a recovery key');

    const answer = await alice.get('/api/e2ee/devices');
    assert.equal(answer.status, 200);
    assert.equal(answer.data.devices.length, 1);
    const registered = answer.data.devices[0];
    assert.equal(registered.id, device.id);
    assert.equal(registered.label, 'alice laptop');
    assert.equal(registered.identityKey, device.publicKeys().identityKey);
    assert.equal(registered.identityDhKey, device.publicKeys().identityDhKey);
    assert.equal(registered.signedPreKey, device.publicKeys().signedPreKey);
    assert.equal(registered.keyFingerprint, await device.fingerprint());
    assert.equal(registered.recoveryEnabled, true, 'the sealed private material is with the server');
  });

  await t.test('the device publishes prekeys it has signed', async () => {
    const answer = await alice.get('/api/e2ee/prekeys/' + client.device.id);
    assert.equal(answer.status, 200);
    const bundle = answer.data.bundle;
    assert.ok(bundle.oneTimePreKey, 'the bundle carries a one-time prekey');
    const verified = serverClient.verifyBundle(bundle);
    assert.ok(verified.bundleOk, 'the bundle signature must verify');
    assert.ok(verified.prekeyOk, 'the one-time prekey signature must verify');
  });

  await t.test('a second device opens a session with it', async () => {
    // A peer that is not the client: the server's own device, registered and
    // publishing prekeys the way the client does.
    const peer = serverClient.createDevice(bob.user.id, 'bob phone');
    const registered = await bob.post('/api/e2ee/devices', serverClient.registerBody(peer));
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    const published = await bob.post('/api/e2ee/prekeys', serverClient.publishBody(peer, 4));
    assert.equal(published.status, 200, JSON.stringify(published.data));

    const session = await client.manager.establish(peer.deviceId, { conversationId: 'conversation-1' });
    assert.ok(session.id, 'the session has an id');
    assert.equal(session.peerDeviceId, peer.deviceId);
    assert.ok(session.secret, 'the session secret is on the device');

    // The server knows about the session, and holds a state it cannot read.
    const answer = await alice.get('/api/e2ee/sessions/' + session.id);
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.equal(answer.data.session.deviceId, client.device.id);
    assert.equal(answer.data.session.peerDeviceId, peer.deviceId);
    assert.ok(answer.data.session.ratchetState, 'the state is with the server');
    assert.ok(
      !JSON.stringify(answer.data.session.ratchetState).includes(session.state.rk),
      'the root key must not be readable in what the server holds',
    );
  });

  await t.test('a message the client sends opens at the peer', async () => {
    const peer = serverClient.createDevice(bob.user.id, 'bob phone');
    const registered = await bob.post('/api/e2ee/devices', serverClient.registerBody(peer));
    assert.equal(registered.status, 201);
    await bob.post('/api/e2ee/prekeys', serverClient.publishBody(peer, 4));

    const session = await client.manager.sessionFor(peer.deviceId, { conversationId: 'conversation-1' });
    const sent = await client.manager.encryptTo(session, {
      conversationId: 'conversation-1',
      plaintext: e.utf8('hello bob'),
    });

    // The peer is the server's own client: the agreement, the signature and
    // the ratchet all have to be right for this to open.
    const context = { sid: session.id, cid: 'conversation-1', to: peer.deviceId };
    const opened = serverClient.respond(peer, sent.envelope, {
      userId: client.device.userId,
      deviceId: client.device.id,
      identityKey: client.device.publicKeys().identityKey,
      identityDhKey: client.device.publicKeys().identityDhKey,
      signedPreKey: client.device.publicKeys().signedPreKey,
    }, context);
    assert.equal(opened.plaintext.toString('utf8'), 'hello bob');
  });

  await t.test('the state the client pushes after a message is sealed', async () => {
    const peer = serverClient.createDevice(bob.user.id, 'bob phone');
    await bob.post('/api/e2ee/devices', serverClient.registerBody(peer));
    await bob.post('/api/e2ee/prekeys', serverClient.publishBody(peer, 4));

    const session = await client.manager.sessionFor(peer.deviceId, { conversationId: 'conversation-1' });
    const sent = await client.manager.encryptTo(session, {
      conversationId: 'conversation-1',
      plaintext: e.utf8('another one'),
    });
    await client.manager.pushState(sent.session);

    const answer = await alice.get('/api/e2ee/sessions/' + session.id);
    assert.equal(answer.status, 200);
    assert.equal(answer.data.session.sendCounter, sent.session.state.ctr);

    // The owner opens the state with the secret the device holds.
    const opened = await e.openState(answer.data.session.ratchetState, e.unb64(sent.session.secret));
    assert.equal(opened.ctr, sent.session.state.ctr);
    assert.equal(opened.rk, sent.session.state.rk);
    assert.ok(!primitives.b64(opened.rk).includes('nothing'), 'the state is the state');
  });

  await t.test('the client opens a message addressed to it, and answers', async () => {
    // The peer starts the session this time: the client's device is the
    // responder, which is the half a client spends most of its life in.
    const peer = serverClient.createDevice(bob.user.id, 'bob phone');
    await bob.post('/api/e2ee/devices', serverClient.registerBody(peer));
    await bob.post('/api/e2ee/prekeys', serverClient.publishBody(peer, 4));

    // The peer takes the client's bundle from the server, the way any peer
    // does, and opens a session with it.
    const bundleAnswer = await bob.get('/api/e2ee/prekeys/' + client.device.id);
    assert.equal(bundleAnswer.status, 200, JSON.stringify(bundleAnswer.data));
    const bundle = bundleAnswer.data.bundle;
    const verified = serverClient.verifyBundle(bundle);
    assert.ok(verified.bundleOk, 'the bundle the server hands out must be signed');
    assert.ok(verified.prekeyOk, 'the one-time prekey must be signed too');

    const context = {
      sid: 'session-the-server-chose',
      cid: 'conversation-2',
      from: peer.deviceId,
      to: client.device.id,
    };
    const agreed = serverClient.initiate(peer, bundle);
    const init = serverClient.buildInit(peer, context, agreed);
    const sent = serverClient.encrypt(peer, agreed.state, Buffer.from('hello from the server'), { ...context, init });

    // The client opens it: the agreement is checked against the identity key
    // the server published for that device.
    const opened = await client.manager.decryptEnvelope(sent.envelope, { conversationId: 'conversation-2' });
    assert.equal(e.fromUtf8(opened.plaintext), 'hello from the server');
    assert.equal(opened.session.role, 'responder');
    assert.equal(opened.session.peerDeviceId, peer.deviceId);

    // And the client answers, with a session of its own.
    const reply = await client.manager.encryptTo(opened.session, {
      conversationId: 'conversation-2',
      plaintext: e.utf8('hello from the client'),
    });
    assert.equal(reply.envelope.to, peer.deviceId);
    assert.equal(reply.envelope.from, client.device.id);
    assert.equal(reply.envelope.init, undefined, 'the agreement travels with the first message only');

    const read = server.ratchet.decrypt(agreed.state, reply.envelope, {
      sid: reply.envelope.sid,
      cid: 'conversation-2',
      to: peer.deviceId,
    });
    assert.equal(read.plaintext.toString('utf8'), 'hello from the client');
  });
});
