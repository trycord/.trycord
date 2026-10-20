// Recovering a device that was lost.
//
// Recovery registers a NEW device. It does not take the lost device's
// identity: a recovered device that kept the old keys would be the old
// device wearing a new label, and revoking the old one would mean nothing.
//
// The proof is a signature by the lost device's identity key over a
// statement that names the account and the new device. The server checks it
// against public data, and it never sees the recovery key.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startInstance, register, transportFor } from './helpers/instance.js';
import * as e from '../../packages/e2ee/index.js';

test('recovering a lost device', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const alice = await register(instance, 'alice');

  // The device that is lost: the one that made the backup.
  const first = await e.E2eeClient.open({
    store: e.memoryStore(),
    api: e.createE2eeApi(transportFor(alice)),
  });
  await first.ready({ userId: alice.user.id, label: 'the lost laptop' });
  const lost = first.device;
  const recoveryKey = lost.recoveryKey;

  await t.test('the backup holds the private material, sealed', async () => {
    const sealed = await first.backup();
    assert.ok(sealed.salt, 'the backup has a salt');
    assert.ok(sealed.ciphertext, 'the backup has ciphertext');
    const answer = await alice.get('/api/e2ee/backup');
    assert.equal(answer.status, 200);
    assert.ok(answer.data.backup, 'the server holds the backup');
    const held = JSON.stringify(answer.data.backup);
    assert.ok(!held.includes(e.b64(lost.keys.sk.privateKey)), 'the private half is not readable');
  });

  await t.test('the wrong recovery key opens nothing', async () => {
    await assert.rejects(
      () => first.openBackup('not the recovery key'),
      (error) => !!error,
    );
  });

  // The new browser: the same account, the recovery key, and nothing else.
  const second = await e.E2eeClient.open({
    store: e.memoryStore(),
    api: e.createE2eeApi(transportFor(alice)),
  });
  await second.load();

  let recovered = null;

  await t.test('the recovery registers a new device', async () => {
    const material = await second.openBackup(recoveryKey);
    assert.ok(material, 'the backup opens with the recovery key');
    assert.equal(material.deviceId, lost.id, 'the backup names the device it came from');

    const sourceKeys = e.deviceFromBackup(material);
    assert.equal(e.b64(sourceKeys.sk.privateKey), e.b64(lost.keys.sk.privateKey),
      'the backup holds the lost device\'s signing key');

    const newDevice = await e.createDevice({
      userId: alice.user.id,
      label: 'the new browser',
      recoveryKey,
    });
    const answer = await second.recover({
      userId: alice.user.id,
      sourceDeviceId: material.deviceId,
      sourceKeys,
      newDevice,
    });
    assert.ok(answer.device, 'the server registered the new device');
    recovered = answer.device;
  });

  await t.test('the new device is not the old one', async () => {
    assert.notEqual(recovered.id, lost.id, 'a recovered device is a new device');
    assert.notEqual(recovered.identityKey, lost.publicKeys().identityKey,
      'and it does not take the lost identity');
    assert.notEqual(recovered.identityDhKey, lost.publicKeys().identityDhKey);
    assert.notEqual(recovered.keyFingerprint, await lost.fingerprint(),
      'so the fingerprint a reader compares is a new one');
  });

  await t.test('the account now has both devices', async () => {
    const answer = await alice.get('/api/e2ee/devices');
    const ids = answer.data.devices.map((device) => device.id);
    assert.ok(ids.includes(lost.id), 'the lost device is still there');
    assert.ok(ids.includes(recovered.id), 'and so is the new one');
  });

  await t.test('the lost device can still be revoked', async () => {
    const answer = await alice.del('/api/e2ee/devices/' + lost.id);
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.equal(answer.data.device.revoked, true);
  });

  await t.test('a recovery cannot be made without the old key', async () => {
    const stranger = await e.createDevice({
      userId: alice.user.id,
      label: 'a device with no claim to anything',
      recoveryKey,
    });
    await assert.rejects(
      () => second.recover({
        userId: alice.user.id,
        sourceDeviceId: lost.id,
        sourceKeys: e.deviceFromBackup({ keys: e.privateKeySet(stranger.keys) }),
        newDevice: stranger,
      }),
      (error) => error.code === 'E2EE_INVALID_SIGNATURE' || error.status === 403,
    );
  });
});
