// The private keys stay on the device.
//
// Everything the client sends to the server is recorded, and every private
// half this device holds is looked for in it: the identity key, the
// Diffie-Hellman key, the signed prekey, the one-time prekeys, the session
// secret and the root key.
//
// A client that leaked any of them would make the whole protocol a
// performance: the server would be able to read what it stores. So this is
// measured, not assumed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startInstance, register, transportFor, recorder } from './helpers/instance.js';
import { server } from './helpers/server.js';
import * as e from '../../packages/e2ee/index.js';

const { client: serverClient } = server;

test('the private keys stay on the device', async (t) => {
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

  // A peer to talk to, so a session is opened and a message is sent.
  const bobDevice = serverClient.createDevice(bob.user.id, 'bob phone');
  await bob.post('/api/e2ee/devices', serverClient.registerBody(bobDevice));
  await bob.post('/api/e2ee/prekeys', serverClient.publishBody(bobDevice, 4));
  const opened = await alice.post('/api/dms', { userId: bob.user.id });
  const conversationId = opened.data.id;

  const session = await client.manager.establish(bobDevice.deviceId, { conversationId });
  const sent = await client.manager.encryptTo(session, {
    conversationId,
    plaintext: e.utf8('hello bob'),
  });
  await client.manager.pushState(sent.session);

  await t.test('every request the client made is on the record', () => {
    assert.ok(calls.calls.length >= 4, 'the client did make requests');
  });

  await t.test('no private half is in anything the client sent', () => {
    const device = client.device;
    const secrets = [
      ['the identity key', e.b64(device.keys.sk.privateKey)],
      ['the Diffie-Hellman key', e.b64(device.keys.ik.privateKey)],
      ['the signed prekey', e.b64(device.keys.spk.privateKey)],
      ['the session secret', sent.session.secret],
      ['the root key', sent.session.state.rk],
      ['the sending chain key', sent.session.state.cks],
    ];
    for (const prekey of Object.values(device.oneTimePreKeys)) {
      secrets.push(['a one-time prekey', prekey.privateKey]);
    }
    for (const call of calls.calls) {
      const body = JSON.stringify(call.body || null) + ' ' + String(call.form || '');
      for (const [name, secret] of secrets) {
        assert.ok(!body.includes(secret), name + ' must not be in ' + call.method + ' ' + call.path);
      }
    }
  });

  await t.test('the recovery key is never sent either', () => {
    const body = JSON.stringify(calls.calls.map((call) => call.body || null));
    assert.ok(!body.includes(client.device.recoveryKey), 'the recovery key must not be sent');
  });

  await t.test('what the server holds opens nothing', async () => {
    // The server's view of the device: the public keys, the signature and
    // the sealed private material.
    const answer = await alice.get('/api/e2ee/devices');
    const held = JSON.stringify(answer.data);
    assert.ok(held.includes(client.device.publicKeys().identityKey), 'the public key is published');
    assert.ok(!held.includes(e.b64(client.device.keys.sk.privateKey)), 'the private half is not');
    const row = await instance.db.get('SELECT * FROM e2ee_devices WHERE id = ?', [client.device.id]);
    assert.ok(row.wrapped_private_key, 'the sealed private material is there');
    for (const [name, secret] of [
      ['the identity key', e.b64(client.device.keys.sk.privateKey)],
      ['the Diffie-Hellman key', e.b64(client.device.keys.ik.privateKey)],
      ['the signed prekey', e.b64(client.device.keys.spk.privateKey)],
    ]) {
      assert.ok(!row.wrapped_private_key.includes(secret), name + ' must not be readable in the seal');
    }
  });

  await t.test('the sealed state on the server cannot be read', async () => {
    const answer = await alice.get('/api/e2ee/sessions/' + sent.session.id);
    const blob = JSON.stringify(answer.data.session.ratchetState);
    assert.ok(blob.length > 10, 'the state is there');
    assert.ok(!blob.includes(sent.session.state.rk), 'the root key must not be readable');
    // And the server's own reader cannot open it either: the key is derived
    // from the session secret, which the server never saw.
    const serverRatchet = server.ratchet;
    assert.throws(() => serverRatchet.openState(answer.data.session.ratchetState, server.primitives.randomBytes(32)));
  });
});
