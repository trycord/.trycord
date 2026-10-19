// The E2EE API, measured through HTTP.
//
// These are the journeys a client actually takes: register a device, publish
// a bundle, take a peer's bundle, revoke a device that was lost, ask what
// the state of a conversation really is, and find out that somebody else's
// key material is not yours to read.
//
// The assertions are about what the server does, not about what a client
// shows: a device that is revoked but still allowed to publish is revoked
// in name only, and a conversation that reports itself as encrypted while
// a member device holds no key is lying to its users.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startE2eeInstance } = require('./instance');
const { registerUser } = require('../helpers/instance');

test('the E2EE API', async (t) => {
  const instance = await startE2eeInstance();
  t.after(() => instance.stop());

  const client = require('./client');
  const db = require('../../src/db');

  const alice = await registerUser(instance, 'alice');
  const bob = await registerUser(instance, 'bob');
  const carol = await registerUser(instance, 'carol');

  const aliceDevice = client.createDevice('alice', 'alice laptop');
  const alicePhone = client.createDevice('alice', 'alice phone');
  const bobDevice = client.createDevice('bob', 'bob desktop');
  aliceDevice.userId = alice.user.id;
  alicePhone.userId = alice.user.id;
  bobDevice.userId = bob.user.id;

  let conversationId = null;
  let bobRecoveryKey = null;

  await t.test('a device registers, and the account can list it', async () => {
    const res = await alice.post('/api/e2ee/devices', client.registerBody(aliceDevice));
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.device.id, aliceDevice.deviceId);
    assert.equal(res.data.device.revoked, false);
    // The sealed private material is the client's business, not the
    // account's to read back.
    assert.equal(res.data.device.wrappedPrivateKey, undefined);

    const second = await alice.post('/api/e2ee/devices', client.registerBody(alicePhone));
    assert.equal(second.status, 201);
    // Bob's device carries sealed private material, so the recovery flow
    // has something to recover from.
    const bobBody = client.registerBody(bobDevice, { withRecovery: true });
    const third = await bob.post('/api/e2ee/devices', bobBody);
    assert.equal(third.status, 201);
    bobRecoveryKey = bobBody.recoveryKey;

    const list = await alice.get('/api/e2ee/devices');
    assert.equal(list.status, 200);
    assert.equal(list.data.devices.length, 2, 'alice has two devices');
  });

  await t.test('a device with no session token is refused', async () => {
    const res = await fetch(instance.baseUrl + '/api/e2ee/devices');
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'AUTH_REQUIRED');
  });

  await t.test('a bundle is published and fetched, with signatures that verify', async () => {
    const published = await bob.post('/api/e2ee/prekeys', client.publishBody(bobDevice, 4));
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.ok(published.data.availablePreKeys >= 1);

    const fetched = await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId);
    assert.equal(fetched.status, 200, JSON.stringify(fetched.data));
    const verified = client.verifyBundle(fetched.data.bundle);
    assert.ok(verified.bundleOk, 'the bundle signature must verify');
    assert.ok(verified.prekeyOk, 'the prekey signature must verify');
  });

  await t.test('a bundle whose signature does not verify is refused', async () => {
    const body = client.publishBody(bobDevice, 1);
    body.signature = client.bundleSignature(client.createDevice('impostor', 'impostor'));
    const res = await bob.post('/api/e2ee/prekeys', body);
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'E2EE_INVALID_SIGNATURE');
  });

  await t.test('a conversation is created for the state to be reported about', async () => {
    const res = await alice.post('/api/dms', { userId: bob.user.id });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    conversationId = res.data.id;
    assert.ok(conversationId);
  });

  await t.test('the conversation state is the truth about the keys', async () => {
    const primitives = require('../../src/services/e2ee/primitives');
    // One conversation key, sealed to each member device the way a client
    // seals it. The server stores the seals and cannot open any of them.
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

    // No key has been published: the conversation is not encrypted, and
    // saying otherwise would be a lie.
    const before = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.equal(before.data.state, 'not-encrypted');
    assert.equal(before.data.encrypted, false);
    assert.equal(before.data.epoch, 0);

    // Every member device holds the key: encrypted.
    const all = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 1,
      sealedKeys: [
        sealFor(aliceDevice, 1),
        sealFor(alicePhone, 1),
        sealFor(bobDevice, 1),
      ],
    });
    assert.equal(all.status, 201, JSON.stringify(all.data));

    const encrypted = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(encrypted.data.state, 'encrypted');
    assert.equal(encrypted.data.encrypted, true);
    assert.equal(encrypted.data.epoch, 1);
    assert.equal(encrypted.data.missingDevices.length, 0);
    assert.equal(encrypted.data.deviceCount, 3);

    // The member device opens its own seal, and gets the conversation key.
    const forBob = await bob.get('/api/e2ee/conversations/' + conversationId + '/key?deviceId=' + bobDevice.deviceId);
    assert.equal(forBob.status, 200, JSON.stringify(forBob.data));
    const opened = client.openConversationKey(conversationId, 1, forBob.data.seal, bobDevice);
    assert.ok(opened.equals(conversationKey), 'the member device opens its own seal');

    // A key that leaves out somebody else's device: mixed, and named.
    const mixed = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 2,
      sealedKeys: [sealFor(aliceDevice, 2), sealFor(alicePhone, 2)],
    });
    assert.equal(mixed.status, 201, JSON.stringify(mixed.data));

    const mixedState = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(mixedState.data.state, 'mixed', 'a device without the key must not be reported as encrypted');
    assert.equal(mixedState.data.encrypted, false);
    assert.deepEqual(mixedState.data.missingDevices, [bobDevice.deviceId]);

    // A key that leaves out one of the caller's own devices: the caller's
    // device has to catch up, and it is told so.
    const behind = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 3,
      sealedKeys: [sealFor(aliceDevice, 3), sealFor(bobDevice, 3)],
    });
    assert.equal(behind.status, 201, JSON.stringify(behind.data));

    const behindState = await alice.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(behindState.data.state, 'key-changed');
    assert.equal(behindState.data.epoch, 3);
    assert.deepEqual(behindState.data.missingDevices, [alicePhone.deviceId]);
    assert.deepEqual(behindState.data.outdatedDevices, [alicePhone.deviceId]);
  });

  await t.test('a sealed key cannot be fetched by a device that is not yours', async () => {
    const res = await alice.get('/api/e2ee/conversations/' + conversationId + '/key?deviceId=' + bobDevice.deviceId);
    assert.equal(res.status, 403, JSON.stringify(res.data));
  });

  await t.test('another account cannot read the key material', async () => {
    const device = await carol.get('/api/e2ee/devices/' + aliceDevice.deviceId);
    assert.equal(device.status, 403, JSON.stringify(device.data));
    assert.equal(device.data.error.code, 'E2EE_FORBIDDEN');

    const revoke = await carol.del('/api/e2ee/devices/' + aliceDevice.deviceId);
    assert.equal(revoke.status, 403, 'another account cannot revoke a device either');

    const key = await carol.get('/api/e2ee/conversations/' + conversationId + '/key?deviceId=' + aliceDevice.deviceId);
    assert.equal(key.status, 403, JSON.stringify(key.data));

    const publish = await carol.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 9,
      sealedKeys: [],
    });
    assert.equal(publish.status, 403, 'an outsider cannot rekey a conversation');

    const state = await carol.get('/api/e2ee/conversations/' + conversationId + '/state');
    assert.equal(state.status, 403, 'an outsider cannot ask about a conversation it is not in');
  });

  await t.test('a session belongs to the account that made it', async () => {
    const created = await alice.post('/api/e2ee/sessions', {
      id: 'alice-session',
      deviceId: aliceDevice.deviceId,
      peerDeviceId: bobDevice.deviceId,
      peerUserId: bob.user.id,
      conversationId,
      ratchetState: { iv: 'nonce', ciphertext: 'sealed', tag: 'tag' },
      sendCounter: 1,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const mine = await alice.get('/api/e2ee/sessions/alice-session');
    assert.equal(mine.status, 200);
    assert.equal(mine.data.session.sendCounter, 1);

    const theirs = await carol.get('/api/e2ee/sessions/alice-session');
    assert.equal(theirs.status, 403, JSON.stringify(theirs.data));
  });

  await t.test('a revoked device can neither publish nor take a bundle', async () => {
    const res = await alice.del('/api/e2ee/devices/' + alicePhone.deviceId);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.device.revoked, true);

    const publish = await alice.post('/api/e2ee/prekeys', client.publishBody(alicePhone, 2));
    assert.equal(publish.status, 403, JSON.stringify(publish.data));
    assert.equal(publish.data.error.code, 'E2EE_DEVICE_REVOKED');

    const fetch = await bob.get('/api/e2ee/prekeys/' + alicePhone.deviceId);
    assert.equal(fetch.status, 403, JSON.stringify(fetch.data));
    assert.equal(fetch.data.error.code, 'E2EE_DEVICE_REVOKED');

    // Its prekeys are gone, and its sessions are dead.
    const prekeys = await db.all('SELECT * FROM e2ee_prekeys WHERE device_id = ?', [alicePhone.deviceId]);
    assert.equal(prekeys.length, 0, 'a revoked device keeps no prekeys');
    const sessions = await db.all('SELECT * FROM e2ee_sessions WHERE device_id = ? OR peer_device_id = ?',
      [alicePhone.deviceId, alicePhone.deviceId]);
    for (const session of sessions) {
      assert.equal(session.status, 'dead', 'a revoked device leaves no live session');
    }
  });

  await t.test('a conversation key cannot be given to a device outside it', async () => {
    const carolDevice = client.createDevice('carol', 'carol laptop');
    carolDevice.userId = carol.user.id;
    const registered = await carol.post('/api/e2ee/devices', client.registerBody(carolDevice));
    assert.equal(registered.status, 201);

    const res = await alice.post('/api/e2ee/conversations/' + conversationId + '/key', {
      deviceId: aliceDevice.deviceId,
      epoch: 4,
      sealedKeys: [{
        deviceId: carolDevice.deviceId,
        seal: { ephemeralPublicKey: 'x', iv: 'y', ciphertext: 'z', tag: 't' },
      }],
    });
    assert.equal(res.status, 403, JSON.stringify(res.data));
  });

  await t.test('an attachment records its sealed key material, and only for its members', async () => {
    const registered = await alice.post('/api/e2ee/attachments', {
      conversationId,
      filename: 'photo.jpg.enc',
      mime: 'application/octet-stream',
      size: 4096,
      sealedKeys: [{
        deviceId: aliceDevice.deviceId,
        seal: { ephemeralPublicKey: 'x', iv: 'y', ciphertext: 'z', tag: 't' },
      }],
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    const attachmentId = registered.data.attachment.id;

    const mine = await alice.get('/api/e2ee/attachments/' + attachmentId);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.attachment.sealedKeys.length, 1);
    assert.equal(mine.data.attachment.sealedKeys[0].deviceId, aliceDevice.deviceId);
    // The record describes the ciphertext, and the server has no key.
    assert.equal(mine.data.attachment.filename, 'photo.jpg.enc');

    const theirs = await carol.get('/api/e2ee/attachments/' + attachmentId);
    assert.equal(theirs.status, 403, 'an outsider cannot take the sealed key material');
  });

  await t.test('a key backup is stored as an opaque blob', async () => {
    const res = await alice.post('/api/e2ee/backup', {
      salt: 'c2FsdA',
      iterations: 200000,
      iv: 'bm9uY2U',
      ciphertext: 'ZW5jcnlwdGVk',
      tag: 'dGFn',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));

    const fetched = await alice.get('/api/e2ee/backup');
    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.backup.ciphertext, 'ZW5jcnlwdGVk');
    assert.equal(fetched.data.backup.iterations, 200000);

    const theirs = await bob.get('/api/e2ee/backup');
    assert.equal(theirs.status, 404, 'a backup belongs to the account that stored it');
  });

  await t.test('a safety number is a fingerprint of both sides keys', async () => {
    const res = await alice.get('/api/e2ee/safety-number?userId=' + bob.user.id);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.digits.length, 60, 'sixty digits');
    assert.equal(res.data.display.split(' ').length, 12, 'twelve groups of five');

    const again = await bob.get('/api/e2ee/safety-number?userId=' + alice.user.id);
    assert.equal(again.data.digits, res.data.digits, 'both sides read the same number');

    const other = await alice.get('/api/e2ee/safety-number?userId=' + carol.user.id);
    assert.notEqual(other.data.digits, res.data.digits, 'a different peer is a different number');
  });

  await t.test('a device is recovered with a proof, and it is a new identity', async () => {
    const primitives = require('../../src/services/e2ee/primitives');
    const deviceKeys = require('../../src/services/e2ee/deviceKeys');
    const recovery = require('../../src/services/e2ee/recovery');

    // The holder of the recovery key opens the lost device's material
    // locally, makes a new identity, and signs a statement with the old
    // device's identity key.
    const stored = await db.get('SELECT * FROM e2ee_devices WHERE id = ?', [bobDevice.deviceId]);
    const lost = deviceKeys.openPrivateMaterial(JSON.parse(stored.wrapped_private_key), bobRecoveryKey);
    assert.ok(lost.sk.privateKey.equals(bobDevice.keys.sk.privateKey),
      'the recovery key opens the sealed material on the client');
    const newDevice = client.createDevice('bob', 'bob new laptop');
    newDevice.userId = bob.user.id;
    const proof = primitives.b64(primitives.sign(
      primitives.importPrivate('ed25519', lost.sk.privateKey, lost.sk.publicKey),
      recovery.proofBytes(bob.user.id, bobDevice.deviceId, newDevice.deviceId)
    ));

    const res = await bob.post('/api/e2ee/recovery', {
      sourceDeviceId: bobDevice.deviceId,
      recoveryProof: proof,
      device: client.registerBody(newDevice),
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.device.id, newDevice.deviceId);
    assert.notEqual(res.data.device.identityKey, primitives.b64(lost.sk.publicKey),
      'a recovered device must not keep the lost identity');

    // A recovered device that claims the lost identity is refused: that
    // would make the old device and the new one the same key, and the
    // revocation of the old one would mean nothing.
    const same = client.createDevice('bob', 'impostor');
    same.userId = bob.user.id;
    const sameBody = client.registerBody(same);
    sameBody.identityKey = primitives.b64(lost.sk.publicKey);
    const sameRes = await bob.post('/api/e2ee/recovery', {
      sourceDeviceId: bobDevice.deviceId,
      recoveryProof: primitives.b64(primitives.sign(
        primitives.importPrivate('ed25519', lost.sk.privateKey, lost.sk.publicKey),
        recovery.proofBytes(bob.user.id, bobDevice.deviceId, same.deviceId)
      )),
      device: sameBody,
    });
    assert.equal(sameRes.status, 400, JSON.stringify(sameRes.data));

    // A proof that does not verify is refused.
    const forged = await bob.post('/api/e2ee/recovery', {
      sourceDeviceId: bobDevice.deviceId,
      recoveryProof: primitives.b64(primitives.randomBytes(64)),
      device: client.registerBody(client.createDevice('bob', 'forged')),
    });
    assert.equal(forged.status, 403, JSON.stringify(forged.data));
  });
});
