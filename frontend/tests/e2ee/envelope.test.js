// The envelope, measured against the server's rules.
//
// The server validates every envelope it is given, so a client that produces
// a slightly different envelope is a client whose messages are refused. The
// rules are the server's: the same fields, the same lengths, the same
// version, and the same refusal of anything else.

import test from 'node:test';
import assert from 'node:assert/strict';

import { server } from './helpers/server.js';
import { makeDevice, agreeAsInitiator, buildInit } from './helpers/device.js';
import * as e from '../../packages/e2ee/index.js';

const { envelope: serverEnvelope, bodies } = server;

const CONTEXT = { sid: 'session-envelope', cid: 'conversation-envelope' };

async function anEnvelope() {
  const alice = await makeDevice('alice', 'alice laptop');
  const bob = await makeDevice('bob', 'bob phone');
  const bundle = {
    userId: bob.userId,
    deviceId: bob.id,
    identityKey: bob.public.identityKey,
    identityDhKey: bob.public.identityDhKey,
    signedPreKey: bob.public.signedPreKey,
  };
  const agreed = await agreeAsInitiator(alice, bundle);
  const context = { ...CONTEXT, from: alice.id, to: bob.id };
  const init = buildInit(alice, context, agreed);
  const sent = await e.ratchetEncrypt(agreed.state, e.utf8('the message'), { ...context, init });
  return { envelope: sent.envelope, alice, bob, agreed, context, init };
}

test('an envelope the client produces', async (t) => {
  await t.test('validates under the server rules', async () => {
    const { envelope } = await anEnvelope();
    assert.doesNotThrow(() => serverEnvelope.validate(envelope));
    assert.equal(serverEnvelope.validate(envelope), envelope);
  });

  await t.test('carries the fields the server requires, and no others', async () => {
    const { envelope } = await anEnvelope();
    const required = ['v', 'sid', 'cid', 'from', 'to', 'ctr', 'dh', 'iv', 'ct', 'tag', 'hiv', 'hct', 'htag'];
    for (const field of required) {
      assert.ok(envelope[field] !== undefined && envelope[field] !== null, 'the envelope must carry ' + field);
    }
    const extra = Object.keys(envelope).filter((field) => !required.includes(field) && field !== 'init');
    assert.deepEqual(extra, [], 'the envelope must carry nothing else');
  });

  await t.test('is stored in the form the server stores it in', async () => {
    const { envelope } = await anEnvelope();
    const stored = bodies.encode([envelope]);
    const back = bodies.decode(stored);
    assert.equal(back.length, 1);
    assert.equal(back[0].ct, envelope.ct);
    const read = bodies.readStored(stored);
    assert.equal(read.encrypted, true);
    assert.equal(read.content, null, 'an encrypted row carries no text');
  });

  await t.test('is refused when a field is changed', async () => {
    const { envelope } = await anEnvelope();
    const missing = { ...envelope };
    delete missing.hct;
    assert.throws(() => serverEnvelope.validate(missing), /missing hct/);

    const future = { ...envelope, v: 2 };
    assert.throws(() => serverEnvelope.validate(future), /protocol version 2/);

    const short = { ...envelope, iv: e.b64(new Uint8Array(8)) };
    assert.throws(() => serverEnvelope.validate(short), /wrong length/);

    // The server's decoder is lenient about what it cannot read, so it is the
    // client that refuses a field that is not base64url at all.
    const notBase64 = { ...envelope, ct: 'not base64url!' };
    assert.throws(() => e.validate(notBase64), /not base64url/);
  });

  await t.test('carries an agreement the server can verify', async () => {
    const { envelope, alice } = await anEnvelope();
    const signed = serverEnvelope.initSignatureBytes({
      sid: envelope.sid,
      cid: envelope.cid,
      from: envelope.from,
      to: envelope.to,
      ek: envelope.init.ek,
      ik: envelope.init.ik,
      spk: envelope.init.spk,
      oneTimePreKeyId: envelope.init.oneTimePreKeyId || '',
    });
    assert.ok(
      server.primitives.verify(
        server.primitives.importPublic('ed25519', alice.public.identityKey),
        signed,
        server.primitives.unb64(envelope.init.signature),
      ),
      'the server must accept the agreement the client signed',
    );
  });

  await t.test('has the same associated data on both sides', async () => {
    const { envelope } = await anEnvelope();
    assert.deepEqual(
      Array.from(e.associatedData(envelope)),
      Array.from(serverEnvelope.associatedData(envelope)),
    );
  });

  await t.test('is refused by the client too, when it is not one', async () => {
    const { envelope } = await anEnvelope();
    assert.throws(() => e.validate({ ...envelope, v: 3 }), /protocol version 3/);
    assert.throws(() => e.validate({ ...envelope, ctr: -1 }), /counter/);
  });
});
