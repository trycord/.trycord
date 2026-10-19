// The protocol between two devices, measured against a running instance.
//
// This is the part that has to be true: two devices that have never met
// agree a secret through the server, the server cannot derive that secret
// from anything it holds, a message survives the trip, and the same
// message offered twice is refused.
//
// The instance is started first and the E2EE modules are required after it,
// because starting an instance clears the module registry: the services
// hold singletons, and they have to be the ones bound to this run's
// database rather than a previous run's.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startE2eeInstance } = require('./instance');
const { registerUser } = require('../helpers/instance');

test('a session between two devices', async (t) => {
  const instance = await startE2eeInstance();
  t.after(() => instance.stop());

  const client = require('./client');
  const primitives = require('../../src/services/e2ee/primitives');
  const ratchet = require('../../src/services/e2ee/ratchet');
  const deviceKeys = require('../../src/services/e2ee/deviceKeys');
  const db = require('../../src/db');

  const alice = await registerUser(instance, 'alice');
  const bob = await registerUser(instance, 'bob');

  const aliceDevice = client.createDevice('alice', 'alice laptop');
  const bobDevice = client.createDevice('bob', 'bob phone');
  aliceDevice.userId = alice.user.id;
  bobDevice.userId = bob.user.id;

  await t.test('a device registers with its public keys and a sealed private half', async () => {
    const body = client.registerBody(aliceDevice, { withRecovery: true });
    const res = await alice.post('/api/e2ee/devices', body);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.device.id, aliceDevice.deviceId);
    assert.equal(res.data.device.recoveryEnabled, true);

    const stored = await db.get('SELECT * FROM e2ee_devices WHERE id = ?', [aliceDevice.deviceId]);
    assert.ok(stored.wrapped_private_key, 'the sealed material is stored');
    // The sealed blob must not contain the private halves in the clear.
    for (const name of deviceKeys.KEY_NAMES) {
      const priv = primitives.b64(aliceDevice.keys[name].privateKey);
      assert.ok(!stored.wrapped_private_key.includes(priv), name + ' must not be readable in the store');
      assert.ok(!JSON.stringify(stored).includes(priv), name + ' must not be readable anywhere in the row');
    }
    // The account holder can open it, with the recovery key, on their own
    // machine. The server never had the key.
    const opened = deviceKeys.openPrivateMaterial(JSON.parse(stored.wrapped_private_key), body.recoveryKey);
    assert.ok(opened.sk.privateKey.equals(aliceDevice.keys.sk.privateKey), 'the recovery key opens the blob');

    // The other side registers its device too.
    const bobRes = await bob.post('/api/e2ee/devices', client.registerBody(bobDevice));
    assert.equal(bobRes.status, 201, JSON.stringify(bobRes.data));
  });

  await t.test('a device publishes a signed bundle', async () => {
    const res = await bob.post('/api/e2ee/prekeys', client.publishBody(bobDevice, 8));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.availablePreKeys >= 1, 'the device published one-time prekeys');
  });

  await t.test('a peer takes the bundle and the signatures verify', async () => {
    const res = await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const bundle = res.data.bundle;
    assert.equal(bundle.deviceId, bobDevice.deviceId);
    assert.ok(bundle.oneTimePreKey, 'the bundle carries a one-time prekey');
    const verified = client.verifyBundle(bundle);
    assert.ok(verified.bundleOk, 'the bundle signature must verify');
    assert.ok(verified.prekeyOk, 'the one-time prekey signature must verify');
  });

  await t.test('a one-time prekey cannot be handed out twice', async () => {
    const first = await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId);
    const second = await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId);
    const firstId = first.data.bundle.oneTimePreKey && first.data.bundle.oneTimePreKey.id;
    const secondId = second.data.bundle.oneTimePreKey && second.data.bundle.oneTimePreKey.id;
    assert.ok(firstId, 'the first bundle carried a prekey');
    assert.notEqual(firstId, secondId, 'a consumed prekey must not be handed out again');

    const rows = await db.all('SELECT id, consumed_at, claimed_at FROM e2ee_prekeys WHERE device_id = ?', [bobDevice.deviceId]);
    const consumed = rows.filter((row) => row.consumed_at);
    assert.ok(consumed.length >= 2, 'each fetch consumed a prekey of its own');
    for (const row of consumed) {
      assert.equal(consumed.filter((other) => other.id === row.id).length, 1);
    }
  });

  let agreed = null;
  let firstEnvelope = null;

  await t.test('the two sides agree the same secret', async () => {
    const res = await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId);
    const bundle = res.data.bundle;
    agreed = client.initiate(aliceDevice, bundle);
    assert.ok(agreed.secret.length === 32, 'the session secret is 32 bytes');

    // The responder's half: it fetches the initiator's published bundle -
    // that is where the identity key that verifies the message comes from -
    // and agrees the secret from the first message.
    const peerBundleRes = await bob.get('/api/e2ee/prekeys/' + aliceDevice.deviceId);
    const peerBundle = peerBundleRes.data.bundle;

    const context = { sid: 'session-alice-bob', cid: 'conversation-1', to: bobDevice.deviceId };
    const init = client.buildInit(aliceDevice, context, agreed);
    const sent = client.encrypt(aliceDevice, agreed.state, Buffer.from('hello bob'), { ...context, init });
    firstEnvelope = sent.envelope;

    const received = client.respond(bobDevice, sent.envelope, peerBundle, context);
    assert.ok(received.secret.equals(agreed.secret), 'both sides must agree the secret');
    assert.equal(received.plaintext.toString('utf8'), 'hello bob');
  });

  await t.test('the first message cannot have its key agreement swapped', async () => {
    const res = await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId);
    const bundle = res.data.bundle;
    const fresh = client.initiate(aliceDevice, bundle);
    const context = { sid: 'session-swapped', cid: 'conversation-1', to: bobDevice.deviceId };
    const init = client.buildInit(aliceDevice, context, fresh);
    const sent = client.encrypt(aliceDevice, fresh.state, Buffer.from('hello bob'), { ...context, init });

    // Another device's ephemeral key in place of the initiator's: the
    // signature over the agreement no longer verifies, and the agreement
    // is covered by the associated data besides.
    const tampered = {
      ...sent.envelope,
      init: { ...init, ek: primitives.b64(primitives.randomBytes(32)) },
    };
    const peerBundleRes = await bob.get('/api/e2ee/prekeys/' + aliceDevice.deviceId);
    assert.throws(() => client.respond(bobDevice, tampered, peerBundleRes.data.bundle, context));
  });

  await t.test('the responder claims the one-time prekey the session used', async () => {
    assert.ok(agreed.oneTimePreKeyId, 'the session used a one-time prekey');
    const claim = await bob.post('/api/e2ee/prekeys/claim', {
      deviceId: bobDevice.deviceId,
      prekeyId: agreed.oneTimePreKeyId,
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.data));
    assert.equal(claim.data.prekey.id, agreed.oneTimePreKeyId);

    // The same prekey cannot start a second session.
    const again = await bob.post('/api/e2ee/prekeys/claim', {
      deviceId: bobDevice.deviceId,
      prekeyId: agreed.oneTimePreKeyId,
    });
    assert.equal(again.status, 409, JSON.stringify(again.data));
  });

  await t.test('the server cannot derive the session secret', async () => {
    // Everything the server holds about this exchange.
    const devices = await db.all('SELECT * FROM e2ee_devices');
    const prekeys = await db.all('SELECT * FROM e2ee_prekeys');
    const sessions = await db.all('SELECT * FROM e2ee_sessions');
    const view = JSON.stringify({ devices, prekeys, sessions });

    // No private key material anywhere in it.
    for (const device of [aliceDevice, bobDevice]) {
      for (const name of deviceKeys.KEY_NAMES) {
        const priv = primitives.b64(device.keys[name].privateKey);
        assert.ok(!view.includes(priv), name + ' must not be in the server view');
      }
      for (const pair of device.oneTimePreKeys.values()) {
        assert.ok(!view.includes(primitives.b64(pair.privateKey)), 'a one-time prekey half must not be in the server view');
      }
    }
    // And the secret itself is nowhere in it.
    assert.ok(!view.includes(agreed.secret.toString('hex')), 'the session secret must not be in the server view');
    assert.ok(!view.includes(primitives.b64(agreed.secret)), 'the session secret must not be in the server view');
  });

  await t.test('the ratchet state the server stores is sealed', async () => {
    const sealed = ratchet.sealState(agreed.state, agreed.secret);
    const res = await alice.post('/api/e2ee/sessions', {
      id: 'session-alice-bob',
      deviceId: aliceDevice.deviceId,
      peerDeviceId: bobDevice.deviceId,
      peerUserId: bob.user.id,
      conversationId: 'conversation-1',
      ratchetState: sealed,
      sendCounter: agreed.state.ctr,
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));

    const stored = await db.get('SELECT * FROM e2ee_sessions WHERE id = ?', ['session-alice-bob']);
    assert.ok(stored.ratchet_state, 'the state is stored');
    assert.ok(!stored.ratchet_state.includes(primitives.b64(agreed.state.rk)), 'the root key must not be readable');

    // The owner opens it with the session secret. The server cannot.
    const fetched = await alice.get('/api/e2ee/sessions/session-alice-bob');
    assert.equal(fetched.status, 200);
    const opened = ratchet.openState(fetched.data.session.ratchetState, agreed.secret);
    assert.equal(opened.rk, agreed.state.rk);
    assert.throws(() => ratchet.openState(fetched.data.session.ratchetState, primitives.randomBytes(32)));
  });

  await t.test('a session counter cannot go backwards', async () => {
    const res = await alice.patch('/api/e2ee/sessions/session-alice-bob', {
      ratchetState: { iv: 'x', ciphertext: 'y', tag: 'z' },
      sendCounter: 0,
    });
    assert.equal(res.status, 409, 'a counter that does not advance is refused');
    assert.equal(res.data.error.code, 'E2EE_REPLAY');
  });

  await t.test('a replayed envelope is refused', async () => {
    const res = await alice.get('/api/e2ee/prekeys/' + bobDevice.deviceId);
    const bundle = res.data.bundle;
    const fresh = client.initiate(aliceDevice, bundle);
    const context = { sid: 'session-replay', cid: 'conversation-1', to: bobDevice.deviceId };
    const peerBundleRes = await bob.get('/api/e2ee/prekeys/' + aliceDevice.deviceId);
    const init = client.buildInit(aliceDevice, context, fresh);
    const sent = client.encrypt(aliceDevice, fresh.state, Buffer.from('once only'), { ...context, init });

    const first = client.respond(bobDevice, sent.envelope, peerBundleRes.data.bundle, context);
    assert.equal(first.plaintext.toString('utf8'), 'once only');
    // The same envelope, offered again to the state that has already read
    // it: the message key has been used, and a used key is refused.
    assert.throws(() => ratchet.decrypt(first.state, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bobDevice.deviceId,
    }), /already been received|no message key/);
  });
});
