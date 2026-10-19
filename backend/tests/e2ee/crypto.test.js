// The primitives, measured.
//
// These are the pieces the whole protocol stands on: two agreements, a
// derivation, an authenticated cipher and a signature. Each one is tested
// for the property the protocol relies on, and the failures are tested as
// carefully as the successes - a cipher that fails to reject a tampered
// message is not a cipher that works most of the time.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const primitives = require('../../src/services/e2ee/primitives');
const protocol = require('../../src/services/e2ee/protocol');
const ratchet = require('../../src/services/e2ee/ratchet');
const client = require('./client');

test('X25519 agreement', async (t) => {
  await t.test('both sides reach the same secret', () => {
    const alice = primitives.generateKeyPair('x25519');
    const bob = primitives.generateKeyPair('x25519');
    const aliceSecret = primitives.ecdh(
      primitives.importPrivate('x25519', alice.privateKey, alice.publicKey),
      primitives.importPublic('x25519', bob.publicKey)
    );
    const bobSecret = primitives.ecdh(
      primitives.importPrivate('x25519', bob.privateKey, bob.publicKey),
      primitives.importPublic('x25519', alice.publicKey)
    );
    assert.equal(aliceSecret.length, 32);
    assert.ok(aliceSecret.equals(bobSecret), 'the two sides must agree');
  });

  await t.test('a third key gives a different secret', () => {
    const alice = primitives.generateKeyPair('x25519');
    const bob = primitives.generateKeyPair('x25519');
    const eve = primitives.generateKeyPair('x25519');
    const withBob = primitives.ecdh(
      primitives.importPrivate('x25519', alice.privateKey, alice.publicKey),
      primitives.importPublic('x25519', bob.publicKey)
    );
    const withEve = primitives.ecdh(
      primitives.importPrivate('x25519', alice.privateKey, alice.publicKey),
      primitives.importPublic('x25519', eve.publicKey)
    );
    assert.ok(!withBob.equals(withEve), 'a different peer key must give a different secret');
  });
});

test('HKDF separates domains', async (t) => {
  await t.test('two labels over the same material give two keys', () => {
    const ikm = primitives.randomBytes(32);
    const first = primitives.hkdf(ikm, protocol.ZERO_SALT, protocol.X3DH_INFO, 32);
    const second = primitives.hkdf(ikm, protocol.ZERO_SALT, protocol.RATCHET_INFO, 32);
    assert.equal(first.length, 32);
    assert.ok(!first.equals(second), 'the X3DH and ratchet labels must not collide');
  });

  await t.test('the same label gives the same key', () => {
    const ikm = primitives.randomBytes(32);
    const first = primitives.hkdf(ikm, protocol.ZERO_SALT, protocol.RATCHET_CHAIN_INFO, 32);
    const second = primitives.hkdf(ikm, protocol.ZERO_SALT, protocol.RATCHET_CHAIN_INFO, 32);
    assert.ok(first.equals(second), 'a derivation must be reproducible');
  });

  await t.test('a different salt gives a different key', () => {
    const ikm = primitives.randomBytes(32);
    const first = primitives.hkdf(ikm, protocol.ZERO_SALT, protocol.RATCHET_CHAIN_INFO, 32);
    const second = primitives.hkdf(ikm, primitives.randomBytes(32), protocol.RATCHET_CHAIN_INFO, 32);
    assert.ok(!first.equals(second), 'the salt must separate derivations');
  });
});

test('AES-256-GCM', async (t) => {
  const key = primitives.randomBytes(32);
  const iv = primitives.randomBytes(primitives.GCM_IV_BYTES);
  const aad = Buffer.from('conversation|device|counter');

  await t.test('a message round trips', () => {
    const sealed = primitives.encrypt(key, iv, Buffer.from('the message'), aad);
    const opened = primitives.decrypt(key, sealed.iv, sealed.ciphertext, sealed.tag, aad);
    assert.equal(opened.toString('utf8'), 'the message');
    assert.equal(sealed.tag.length, primitives.GCM_TAG_BYTES);
  });

  await t.test('a changed ciphertext does not decrypt', () => {
    const sealed = primitives.encrypt(key, iv, Buffer.from('the message'), aad);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] ^= 0xff;
    assert.throws(() => primitives.decrypt(key, sealed.iv, tampered, sealed.tag, aad));
  });

  await t.test('a changed tag does not decrypt', () => {
    const sealed = primitives.encrypt(key, iv, Buffer.from('the message'), aad);
    const tampered = Buffer.from(sealed.tag);
    tampered[0] ^= 0xff;
    assert.throws(() => primitives.decrypt(key, sealed.iv, sealed.ciphertext, tampered, aad));
  });

  await t.test('changed associated data does not decrypt', () => {
    const sealed = primitives.encrypt(key, iv, Buffer.from('the message'), aad);
    assert.throws(() => primitives.decrypt(key, sealed.iv, sealed.ciphertext, sealed.tag, Buffer.from('other')));
  });

  await t.test('a different key does not decrypt', () => {
    const sealed = primitives.encrypt(key, iv, Buffer.from('the message'), aad);
    assert.throws(() => primitives.decrypt(primitives.randomBytes(32), sealed.iv, sealed.ciphertext, sealed.tag, aad));
  });
});

test('Ed25519 signatures', async (t) => {
  const pair = primitives.generateKeyPair('ed25519');
  const message = Buffer.from('the bundle');

  await t.test('a good signature verifies', () => {
    const signature = primitives.sign(primitives.importPrivate('ed25519', pair.privateKey, pair.publicKey), message);
    assert.equal(signature.length, primitives.SIGNATURE_BYTES);
    assert.ok(primitives.verify(primitives.importPublic('ed25519', pair.publicKey), message, signature));
  });

  await t.test('a changed message does not verify', () => {
    const signature = primitives.sign(primitives.importPrivate('ed25519', pair.privateKey, pair.publicKey), message);
    assert.ok(!primitives.verify(primitives.importPublic('ed25519', pair.publicKey), Buffer.from('other'), signature));
  });

  await t.test('a changed signature does not verify', () => {
    const signature = primitives.sign(primitives.importPrivate('ed25519', pair.privateKey, pair.publicKey), message);
    const tampered = Buffer.from(signature);
    tampered[0] ^= 0xff;
    assert.ok(!primitives.verify(primitives.importPublic('ed25519', pair.publicKey), message, tampered));
  });

  await t.test('another key does not verify', () => {
    const other = primitives.generateKeyPair('ed25519');
    const signature = primitives.sign(primitives.importPrivate('ed25519', pair.privateKey, pair.publicKey), message);
    assert.ok(!primitives.verify(primitives.importPublic('ed25519', other.publicKey), message, signature));
  });
});

test('the double ratchet', async (t) => {
  // Two devices that have agreed a secret, the way they would after X3DH.
  const alice = client.createDevice('alice', 'alice laptop');
  const bob = client.createDevice('bob', 'bob phone');
  const bobBundle = {
    userId: bob.userId,
    deviceId: bob.deviceId,
    identityKey: client.publicKeys(bob).identityKey,
    identityDhKey: client.publicKeys(bob).identityDhKey,
    signedPreKey: client.publicKeys(bob).signedPreKey,
  };
  const agreed = client.initiate(alice, bobBundle);
  let aliceState = agreed.state;
  let bobState = ratchet.responderState(
    agreed.secret,
    bob.keys.spk,
    primitives.unb64(aliceState.dhs.pub)
  );
  const context = { sid: 'session-1', cid: 'conversation-1' };

  await t.test('a message encrypts and decrypts', () => {
    const sent = client.encrypt(alice, aliceState, Buffer.from('hello bob'), { ...context, to: bob.deviceId });
    const received = ratchet.decrypt(bobState, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bob.deviceId,
    });
    assert.equal(received.plaintext.toString('utf8'), 'hello bob');
    aliceState = sent.state;
    bobState = received.state;
  });

  await t.test('every message has its own key, and the chain advances', () => {
    const before = aliceState.cks;
    const first = client.encrypt(alice, aliceState, Buffer.from('one'), { ...context, to: bob.deviceId });
    const second = client.encrypt(alice, first.state, Buffer.from('two'), { ...context, to: bob.deviceId });
    assert.notEqual(first.state.cks, before, 'the sending chain key must advance');
    assert.notEqual(second.state.cks, first.state.cks, 'the sending chain key must advance again');
    assert.equal(first.envelope.ctr + 1, second.envelope.ctr, 'the counter must increase');
    assert.notEqual(first.envelope.iv, second.envelope.iv, 'each message gets its own nonce');
    assert.notEqual(first.envelope.ct, second.envelope.ct, 'the ciphertexts must differ');

    const chain = ratchet.deriveChain(primitives.randomBytes(32));
    const again = ratchet.deriveChain(primitives.randomBytes(32));
    assert.ok(!chain.messageKey.equals(again.messageKey), 'two chains must not share a message key');
  });

  await t.test('a message cannot be moved to another conversation', () => {
    const sent = client.encrypt(alice, aliceState, Buffer.from('for this conversation'), {
      ...context, to: bob.deviceId,
    });
    assert.throws(() => ratchet.decrypt(bobState, sent.envelope, {
      sid: context.sid, cid: 'another-conversation', to: bob.deviceId,
    }));
  });

  await t.test('a replayed message is refused', () => {
    const sent = client.encrypt(alice, aliceState, Buffer.from('once'), { ...context, to: bob.deviceId });
    const first = ratchet.decrypt(bobState, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bob.deviceId,
    });
    assert.throws(() => ratchet.decrypt(first.state, sent.envelope, {
      sid: context.sid, cid: context.cid, to: bob.deviceId,
    }), /already been received|no message key/);
  });

  await t.test('a skipped key reads a message that arrives late', () => {
    // A fresh pair, so the counters and the chains start from nothing.
    const carol = client.createDevice('carol', 'carol');
    const dave = client.createDevice('dave', 'dave');
    const daveBundle = {
      userId: dave.userId,
      deviceId: dave.deviceId,
      identityKey: client.publicKeys(dave).identityKey,
      identityDhKey: client.publicKeys(dave).identityDhKey,
      signedPreKey: client.publicKeys(dave).signedPreKey,
    };
    const carolAgreed = client.initiate(carol, daveBundle);
    let carolState = carolAgreed.state;
    let daveState = ratchet.responderState(
      carolAgreed.secret,
      dave.keys.spk,
      primitives.unb64(carolState.dhs.pub)
    );

    const first = client.encrypt(carol, carolState, Buffer.from('first'), { ...context, to: dave.deviceId });
    const second = client.encrypt(carol, first.state, Buffer.from('second'), { ...context, to: dave.deviceId });
    const third = client.encrypt(carol, second.state, Buffer.from('third'), { ...context, to: dave.deviceId });

    // The third message arrives first. The receiver has to pass over two
    // message keys to reach it, and files them.
    const outOfOrder = ratchet.decrypt(daveState, third.envelope, {
      sid: context.sid, cid: context.cid, to: dave.deviceId,
    });
    assert.equal(outOfOrder.plaintext.toString('utf8'), 'third');
    daveState = outOfOrder.state;
    assert.ok(Object.keys(daveState.skipped).length >= 2, 'the passed-over keys must be filed');

    // The first message now arrives late, and the filed key opens it.
    const late = ratchet.decrypt(daveState, first.envelope, {
      sid: context.sid, cid: context.cid, to: dave.deviceId,
    });
    assert.equal(late.plaintext.toString('utf8'), 'first');
  });
});

test('nonces do not repeat', async (t) => {
  await t.test('a thousand messages use a thousand different nonces', () => {
    const alice = client.createDevice('alice', 'alice');
    const bob = client.createDevice('bob', 'bob');
    const bobBundle = {
      userId: bob.userId,
      deviceId: bob.deviceId,
      identityKey: client.publicKeys(bob).identityKey,
      identityDhKey: client.publicKeys(bob).identityDhKey,
      signedPreKey: client.publicKeys(bob).signedPreKey,
    };
    const agreed = client.initiate(alice, bobBundle);
    let state = agreed.state;
    const nonces = new Set();
    const messageKeys = new Set();
    const context = { sid: 'session-2', cid: 'conversation-2' };
    for (let i = 0; i < 1000; i++) {
      const sent = client.encrypt(alice, state, Buffer.from('message ' + i), { ...context, to: bob.deviceId });
      nonces.add(sent.envelope.iv);
      messageKeys.add(ratchet.deriveChain(primitives.unb64(state.cks)).messageKey.toString('hex'));
      state = sent.state;
    }
    assert.equal(nonces.size, 1000, 'every message needs its own nonce');
    assert.equal(messageKeys.size, 1000, 'every message needs its own key');
  });
});
