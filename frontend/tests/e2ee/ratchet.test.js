// The ratchet, measured from both sides.
//
// Three things have to hold for the protocol to be worth anything: a message
// opens for the device it was sent to and for nobody else, a message that is
// offered twice is refused, and a message that arrives late is still read.
//
// The peer here is the server's own client - the one in
// backend/tests/e2ee/client.js - so what is read is read by the code the
// server's tests trust.

import test from 'node:test';
import assert from 'node:assert/strict';

import { server } from './helpers/server.js';
import { makeDevice, asServerDevice, bundleFor, agreeAsInitiator, buildInit } from './helpers/device.js';
import * as e from '../../packages/e2ee/index.js';

const { ratchet, primitives, client: serverClient } = server;

const CONTEXT = { sid: 'session-ratchet', cid: 'conversation-ratchet' };

/** A session the client opens with a peer, from the client's side. */
async function openSession(device, peer) {
  const bundle = bundleFor(peer);
  const agreed = await agreeAsInitiator(device, bundle);
  return { bundle, agreed };
}

/** The responder's state, as the server's ratchet builds it. */
function responderState(peer, secret, initiatorState) {
  return ratchet.responderState(
    secret,
    asServerDevice(peer).keys.spk,
    primitives.unb64(initiatorState.dhs.pub),
  );
}

test('the ratchet, from both sides', async (t) => {
  await t.test('a message opens for the device it was sent to', async () => {
    const alice = await makeDevice('alice', 'alice laptop');
    const bob = await makeDevice('bob', 'bob phone');
    const { bundle, agreed } = await openSession(alice, bob);
    const context = { ...CONTEXT, from: alice.id, to: bob.id };
    const init = buildInit(alice, context, agreed);
    const sent = await e.ratchetEncrypt(agreed.state, e.utf8('hello bob'), { ...context, init });

    // The server's own client reads it: the agreement, the ratchet and all.
    const opened = serverClient.respond(asServerDevice(bob), sent.envelope, bundleFor(alice), context);
    assert.equal(opened.plaintext.toString('utf8'), 'hello bob');
    assert.equal(primitives.b64(opened.secret), primitives.b64(agreed.secret),
      'both sides must agree the secret');
  });

  await t.test('a message opens for two devices and for nobody else', async () => {
    const alice = await makeDevice('alice', 'alice laptop');
    const bob = await makeDevice('bob', 'bob phone');
    const carol = await makeDevice('carol', 'carol laptop');
    const stranger = await makeDevice('dave', 'dave phone');

    const withBob = await openSession(alice, bob);
    const withCarol = await openSession(alice, carol);

    const toBob = { ...CONTEXT, from: alice.id, to: bob.id };
    const toCarol = { ...CONTEXT, from: alice.id, to: carol.id };
    const first = await e.ratchetEncrypt(withBob.agreed.state, e.utf8('for both of you'), {
      ...toBob, init: buildInit(alice, toBob, withBob.agreed),
    });
    const second = await e.ratchetEncrypt(withCarol.agreed.state, e.utf8('for both of you'), {
      ...toCarol, init: buildInit(alice, toCarol, withCarol.agreed),
    });

    const bobRead = serverClient.respond(asServerDevice(bob), first.envelope, bundleFor(alice), toBob);
    const carolRead = serverClient.respond(asServerDevice(carol), second.envelope, bundleFor(alice), toCarol);
    assert.equal(bobRead.plaintext.toString('utf8'), 'for both of you');
    assert.equal(carolRead.plaintext.toString('utf8'), 'for both of you');

    // A third device, in the conversation, cannot open an envelope that was
    // not addressed to it: the address is in the associated data.
    assert.throws(
      () => ratchet.decrypt(
        responderState(carol, withCarol.agreed.secret, withCarol.agreed.state),
        first.envelope,
        { sid: CONTEXT.sid, cid: CONTEXT.cid, to: carol.id },
      ),
      /addressed to another device/,
    );

    // And a device that is not in the conversation cannot open it either.
    assert.throws(
      () => ratchet.decrypt(
        responderState(stranger, withBob.agreed.secret, withBob.agreed.state),
        first.envelope,
        { sid: CONTEXT.sid, cid: CONTEXT.cid, to: stranger.id },
      ),
      /addressed to another device/,
    );
  });

  await t.test('a message cannot be moved to another conversation', async () => {
    const alice = await makeDevice('alice', 'alice laptop');
    const bob = await makeDevice('bob', 'bob phone');
    const { agreed } = await openSession(alice, bob);
    const context = { ...CONTEXT, from: alice.id, to: bob.id };
    const sent = await e.ratchetEncrypt(agreed.state, e.utf8('for this conversation'), {
      ...context, init: buildInit(alice, context, agreed),
    });
    const state = responderState(bob, agreed.secret, agreed.state);
    assert.throws(
      () => ratchet.decrypt(state, sent.envelope, {
        sid: CONTEXT.sid, cid: 'another-conversation', to: bob.id,
      }),
      /another conversation/,
    );
  });

  await t.test('a replayed message is refused', async () => {
    const alice = await makeDevice('alice', 'alice laptop');
    const bob = await makeDevice('bob', 'bob phone');
    const { agreed } = await openSession(alice, bob);
    const context = { ...CONTEXT, from: alice.id, to: bob.id };
    const sent = await e.ratchetEncrypt(agreed.state, e.utf8('once only'), {
      ...context, init: buildInit(alice, context, agreed),
    });
    const state = responderState(bob, agreed.secret, agreed.state);
    const first = ratchet.decrypt(state, sent.envelope, { sid: CONTEXT.sid, cid: CONTEXT.cid, to: bob.id });
    assert.equal(first.plaintext.toString('utf8'), 'once only');
    assert.throws(
      () => ratchet.decrypt(first.state, sent.envelope, { sid: CONTEXT.sid, cid: CONTEXT.cid, to: bob.id }),
      /already been received|no message key/,
    );
  });

  await t.test('a skipped key reads a message that arrives late', async () => {
    const alice = await makeDevice('alice', 'alice laptop');
    const bob = await makeDevice('bob', 'bob phone');
    const { agreed } = await openSession(alice, bob);
    const context = { ...CONTEXT, from: alice.id, to: bob.id };
    const init = buildInit(alice, context, agreed);

    const first = await e.ratchetEncrypt(agreed.state, e.utf8('first'), { ...context, init });
    const second = await e.ratchetEncrypt(first.state, e.utf8('second'), context);
    const third = await e.ratchetEncrypt(second.state, e.utf8('third'), context);

    let state = responderState(bob, agreed.secret, agreed.state);
    // The third message arrives first: the receiver has to pass over two
    // message keys to reach it, and files them.
    const outOfOrder = ratchet.decrypt(state, third.envelope, {
      sid: CONTEXT.sid, cid: CONTEXT.cid, to: bob.id,
    });
    assert.equal(outOfOrder.plaintext.toString('utf8'), 'third');
    state = outOfOrder.state;
    assert.ok(Object.keys(state.skipped).length >= 2, 'the passed-over keys must be filed');

    // The first message now arrives late, and the filed key opens it.
    const late = ratchet.decrypt(state, first.envelope, {
      sid: CONTEXT.sid, cid: CONTEXT.cid, to: bob.id,
    });
    assert.equal(late.plaintext.toString('utf8'), 'first');
  });

  await t.test('the client files the skipped keys too', async () => {
    const alice = await makeDevice('alice', 'alice laptop');
    const bob = await makeDevice('bob', 'bob phone');
    const { agreed } = await openSession(alice, bob);
    const context = { ...CONTEXT, from: alice.id, to: bob.id };
    const init = buildInit(alice, context, agreed);

    const first = await e.ratchetEncrypt(agreed.state, e.utf8('first'), { ...context, init });
    const second = await e.ratchetEncrypt(first.state, e.utf8('second'), context);
    const third = await e.ratchetEncrypt(second.state, e.utf8('third'), context);

    let state = responderState(bob, agreed.secret, agreed.state);
    const outOfOrder = await e.ratchetDecrypt(state, third.envelope, {
      sid: CONTEXT.sid, cid: CONTEXT.cid, to: bob.id,
    });
    state = outOfOrder.state;
    assert.ok(Object.keys(state.skipped).length >= 2, 'the client must file the keys it passed over');
    const late = await e.ratchetDecrypt(state, first.envelope, {
      sid: CONTEXT.sid, cid: CONTEXT.cid, to: bob.id,
    });
    assert.equal(e.fromUtf8(late.plaintext), 'first');
  });

  await t.test('every message has its own key and its own nonce', async () => {
    const alice = await makeDevice('alice', 'alice laptop');
    const bob = await makeDevice('bob', 'bob phone');
    const { agreed } = await openSession(alice, bob);
    const context = { ...CONTEXT, from: alice.id, to: bob.id };
    const init = buildInit(alice, context, agreed);
    const first = await e.ratchetEncrypt(agreed.state, e.utf8('one'), { ...context, init });
    const second = await e.ratchetEncrypt(first.state, e.utf8('two'), context);
    assert.notEqual(first.state.cks, second.state.cks, 'the sending chain key must advance');
    assert.equal(first.envelope.ctr + 1, second.envelope.ctr, 'the counter must increase');
    assert.notEqual(first.envelope.iv, second.envelope.iv, 'each message gets its own nonce');
    assert.notEqual(first.envelope.ct, second.envelope.ct, 'the ciphertexts must differ');
  });
});
