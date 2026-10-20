// The client and the server agree.
//
// This is the test the whole client stands on. The server's protocol is the
// specification and the client is a port of it, so the only question that
// matters is whether the two halves produce the same bytes: a key schedule
// that differs by one byte produces keys that do not open, and the failure
// would look like a bug in the protocol rather than in the port.
//
// The two directions are both measured, because a port that only reads what
// the server writes is not a port: the client has to write envelopes the
// server opens, and read envelopes the server writes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { server } from './helpers/server.js';
import * as e from '../../packages/e2ee/index.js';

const { primitives, ratchet, x3dh, client: serverClient } = server;

function serverBundle(device) {
  const pubs = serverClient.publicKeys(device);
  return {
    userId: device.userId,
    deviceId: device.deviceId,
    identityKey: pubs.identityKey,
    identityDhKey: pubs.identityDhKey,
    signedPreKey: pubs.signedPreKey,
  };
}

test('the client and the server agree', async (t) => {
  const alice = serverClient.createDevice('alice', 'alice laptop');
  const bob = serverClient.createDevice('bob', 'bob phone');
  const bundle = serverBundle(bob);

  await t.test('the two sides agree the same secret', async () => {
    const agreed = await e.initiate({
      ownSignedPreKeyPrivate: alice.keys.spk.privateKey,
      ownSignedPreKeyPublic: alice.keys.spk.publicKey,
      peer: {
        identityDhKey: primitives.unb64(bundle.identityDhKey),
        signedPreKey: primitives.unb64(bundle.signedPreKey),
        oneTimePreKey: null,
        oneTimePreKeyId: null,
      },
    });
    const secret = await x3dh.respond({
      ownIdentityDhPrivate: bob.keys.ik.privateKey,
      ownIdentityDhPublic: bob.keys.ik.publicKey,
      ownSignedPreKeyPrivate: bob.keys.spk.privateKey,
      ownSignedPreKeyPublic: bob.keys.spk.publicKey,
      ownOneTimePreKeyPrivate: null,
      ownOneTimePreKeyPublic: null,
      peerEphemeralPublicKey: e.b64(agreed.ephemeralPublicKey),
      peerSignedPreKeyPublic: e.b64(alice.keys.spk.publicKey),
    });
    assert.equal(primitives.b64(secret), primitives.b64(agreed.secret),
      'the client and the server must derive the same secret');
  });

  await t.test('a message the client encrypts opens with the server ratchet', async () => {
    const agreed = await e.initiate({
      ownSignedPreKeyPrivate: alice.keys.spk.privateKey,
      ownSignedPreKeyPublic: alice.keys.spk.publicKey,
      peer: {
        identityDhKey: primitives.unb64(bundle.identityDhKey),
        signedPreKey: primitives.unb64(bundle.signedPreKey),
        oneTimePreKey: null,
        oneTimePreKeyId: null,
      },
    });
    const aliceState = await e.initiatorState(agreed.secret, bundle.signedPreKey);
    const bobState = ratchet.responderState(
      agreed.secret,
      bob.keys.spk,
      primitives.unb64(aliceState.dhs.pub),
    );

    const context = {
      sid: 'session-agreement',
      cid: 'conversation-agreement',
      from: alice.deviceId,
      to: bob.deviceId,
    };
    const sent = await e.ratchetEncrypt(aliceState, e.utf8('hello bob'), context);
    const opened = ratchet.decrypt(bobState, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bob.deviceId,
    });
    assert.equal(opened.plaintext.toString('utf8'), 'hello bob');
  });

  await t.test('a message the server encrypts opens with the client ratchet', async () => {
    const agreed = await e.initiate({
      ownSignedPreKeyPrivate: alice.keys.spk.privateKey,
      ownSignedPreKeyPublic: alice.keys.spk.publicKey,
      peer: {
        identityDhKey: primitives.unb64(bundle.identityDhKey),
        signedPreKey: primitives.unb64(bundle.signedPreKey),
        oneTimePreKey: null,
        oneTimePreKeyId: null,
      },
    });
    const aliceState = await e.initiatorState(agreed.secret, bundle.signedPreKey);
    const bobState = ratchet.responderState(
      agreed.secret,
      bob.keys.spk,
      primitives.unb64(aliceState.dhs.pub),
    );

    const context = {
      sid: 'session-agreement',
      cid: 'conversation-agreement',
      from: alice.deviceId,
      to: bob.deviceId,
    };
    const sent = serverClient.encrypt(alice, aliceState, Buffer.from('hello again'), context);
    const opened = await e.ratchetDecrypt(bobState, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bob.deviceId,
    });
    assert.equal(e.fromUtf8(opened.plaintext), 'hello again');
  });

  await t.test('the two ratchets keep the same state', async () => {
    const agreed = await e.initiate({
      ownSignedPreKeyPrivate: alice.keys.spk.privateKey,
      ownSignedPreKeyPublic: alice.keys.spk.publicKey,
      peer: {
        identityDhKey: primitives.unb64(bundle.identityDhKey),
        signedPreKey: primitives.unb64(bundle.signedPreKey),
        oneTimePreKey: null,
        oneTimePreKeyId: null,
      },
    });
    const aliceState = await e.initiatorState(agreed.secret, bundle.signedPreKey);
    const bobState = ratchet.responderState(
      agreed.secret,
      bob.keys.spk,
      primitives.unb64(aliceState.dhs.pub),
    );
    const context = {
      sid: 'session-agreement',
      cid: 'conversation-agreement',
      from: alice.deviceId,
      to: bob.deviceId,
    };
    const sent = await e.ratchetEncrypt(aliceState, e.utf8('the same state'), context);

    const serverRead = ratchet.decrypt(bobState, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bob.deviceId,
    });
    const clientRead = await e.ratchetDecrypt(bobState, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bob.deviceId,
    });
    assert.deepEqual(clientRead.state, serverRead.state,
      'the state the client keeps must be the state the server keeps');
  });

  await t.test('the state the client seals is the state the server opens', async () => {
    const agreed = await e.initiate({
      ownSignedPreKeyPrivate: alice.keys.spk.privateKey,
      ownSignedPreKeyPublic: alice.keys.spk.publicKey,
      peer: {
        identityDhKey: primitives.unb64(bundle.identityDhKey),
        signedPreKey: primitives.unb64(bundle.signedPreKey),
        oneTimePreKey: null,
        oneTimePreKeyId: null,
      },
    });
    const aliceState = await e.initiatorState(agreed.secret, bundle.signedPreKey);
    const clientSealed = await e.sealState(aliceState, agreed.secret);
    const serverOpened = ratchet.openState(clientSealed, agreed.secret);
    assert.deepEqual(serverOpened, aliceState);

    const serverSealed = ratchet.sealState(aliceState, agreed.secret);
    const clientOpened = await e.openState(serverSealed, agreed.secret);
    assert.deepEqual(clientOpened, aliceState);
  });

  await t.test('the associated data is the same bytes on both sides', async () => {
    const agreed = await e.initiate({
      ownSignedPreKeyPrivate: alice.keys.spk.privateKey,
      ownSignedPreKeyPublic: alice.keys.spk.publicKey,
      peer: {
        identityDhKey: primitives.unb64(bundle.identityDhKey),
        signedPreKey: primitives.unb64(bundle.signedPreKey),
        oneTimePreKey: null,
        oneTimePreKeyId: null,
      },
    });
    const aliceState = await e.initiatorState(agreed.secret, bundle.signedPreKey);
    const context = {
      sid: 'session-agreement',
      cid: 'conversation-agreement',
      from: alice.deviceId,
      to: bob.deviceId,
    };
    const sent = await e.ratchetEncrypt(aliceState, e.utf8('the same bytes'), context);
    assert.deepEqual(
      Array.from(e.associatedData(sent.envelope)),
      Array.from(server.envelope.associatedData(sent.envelope)),
      'the associated data must be the same bytes',
    );
  });
});
