// The primitives, measured against the server's.
//
// Every one of these is a comparison with the server's own implementation,
// because the client and the server have to agree byte for byte: a
// derivation that differs in one byte produces keys that do not open, and the
// failure looks like a broken protocol rather than a broken port.
//
// The two halves hold their bytes in different types - the server in Node
// buffers, the client in Uint8Arrays - so each side is given the input in
// its own convention and the outputs are compared.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { server } from './helpers/server.js';
import * as e from '../../packages/e2ee/index.js';

const { primitives, protocol, deviceKeys } = server;

test('the primitives agree with the server', async (t) => {
  await t.test('base64url is the same encoding', () => {
    for (let i = 1; i < 64; i += 1) {
      const bytes = crypto.randomBytes(i);
      const mine = e.b64(new Uint8Array(bytes));
      assert.equal(mine, bytes.toString('base64url'), 'the encoding must be the same');
      assert.deepEqual(Array.from(e.unb64(mine)), Array.from(bytes), 'and it must decode back');
    }
  });

  await t.test('base64url refuses what is not base64url', () => {
    assert.throws(() => e.unb64('not base64!'), /base64url/);
    assert.throws(() => e.unb64(''), /base64url/);
    assert.throws(() => e.unb64('a'), /base64url/);
  });

  await t.test('the canonical bytes are the same bytes', () => {
    const mine = e.canonical(
      ['context', 'trycord-e2ee-v1'],
      ['version', 1],
      ['session', 'session-1'],
      ['counter', new Uint8Array([0, 0, 0, 7])],
    );
    const theirs = protocol.canonical(
      ['context', 'trycord-e2ee-v1'],
      ['version', 1],
      ['session', 'session-1'],
      ['counter', Buffer.from([0, 0, 0, 7])],
    );
    assert.deepEqual(Array.from(mine), Array.from(theirs));
  });

  await t.test('HKDF gives the same key for every label', async () => {
    const ikm = crypto.randomBytes(32);
    const salt = new Uint8Array(32);
    for (const info of [protocol.X3DH_INFO, protocol.RATCHET_ROOT_SEED_INFO, protocol.RATCHET_ROOT_INFO,
      protocol.RATCHET_CHAIN_INFO, protocol.RATCHET_HEADER_INFO, protocol.RATCHET_STATE_INFO,
      protocol.GROUP_SEAL_INFO, protocol.ATTACHMENT_SEAL_INFO, protocol.RECOVERY_WRAP_INFO]) {
      const mine = await e.hkdf(new Uint8Array(ikm), salt, info, 32);
      const theirs = primitives.hkdf(ikm, salt, info, 32);
      assert.deepEqual(Array.from(mine), Array.from(theirs), 'the label ' + info + ' must give the same key');
    }
  });

  await t.test('HKDF gives the same key for the lengths the protocol uses', async () => {
    const ikm = crypto.randomBytes(32);
    const salt = new Uint8Array(32);
    for (const length of [32, 64]) {
      const mine = await e.hkdf(new Uint8Array(ikm), salt, protocol.RATCHET_CHAIN_INFO, length);
      const theirs = primitives.hkdf(ikm, salt, protocol.RATCHET_CHAIN_INFO, length);
      assert.deepEqual(Array.from(mine), Array.from(theirs));
    }
  });

  await t.test('the X25519 agreement is the same secret', () => {
    const mine = e.generateKeyPair('x25519');
    const theirs = primitives.generateKeyPair('x25519');
    const shared = e.ecdh(mine.privateKey, new Uint8Array(theirs.publicKey));
    const serverShared = primitives.ecdh(
      primitives.importPrivate('x25519', theirs.privateKey, theirs.publicKey),
      primitives.importPublic('x25519', e.b64(mine.publicKey)),
    );
    assert.deepEqual(Array.from(shared), Array.from(serverShared));
  });

  await t.test('the Ed25519 signature is the same signature', () => {
    const mine = e.generateKeyPair('ed25519');
    const message = e.utf8('the bundle');
    const signature = e.sign(mine.privateKey, message);
    assert.ok(
      primitives.verify(
        primitives.importPublic('ed25519', e.b64(mine.publicKey)),
        Buffer.from(message),
        Buffer.from(signature),
      ),
      'the server must accept the signature the client made',
    );
    const theirs = primitives.generateKeyPair('ed25519');
    const serverSignature = primitives.sign(
      primitives.importPrivate('ed25519', theirs.privateKey, theirs.publicKey),
      Buffer.from(message),
    );
    assert.ok(
      e.verify(new Uint8Array(theirs.publicKey), message, new Uint8Array(serverSignature)),
      'the client must accept the signature the server made',
    );
  });

  await t.test('AES-256-GCM is the same cipher', async () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const aad = Buffer.from('the associated data');
    const plaintext = Buffer.from('the message');
    const mine = await e.aesEncrypt(
      new Uint8Array(key), new Uint8Array(iv), new Uint8Array(plaintext), new Uint8Array(aad),
    );
    const theirs = primitives.encrypt(key, iv, plaintext, aad);
    assert.deepEqual(Array.from(mine.ciphertext), Array.from(theirs.ciphertext));
    assert.deepEqual(Array.from(mine.tag), Array.from(theirs.tag));
    const opened = await e.aesDecrypt(
      new Uint8Array(key),
      new Uint8Array(iv),
      new Uint8Array(theirs.ciphertext),
      new Uint8Array(theirs.tag),
      new Uint8Array(aad),
    );
    assert.equal(e.fromUtf8(opened), 'the message');
  });

  await t.test('SHA-256 and SHA-512 are the same digests', async () => {
    const bytes = crypto.randomBytes(100);
    assert.deepEqual(
      Array.from(await e.sha256(new Uint8Array(bytes))),
      Array.from(primitives.sha256(bytes)),
    );
    assert.deepEqual(
      Array.from(await e.sha512(new Uint8Array(bytes))),
      Array.from(primitives.sha512(bytes)),
    );
  });

  await t.test('the fingerprint of an identity key is the same', async () => {
    const keys = e.generateKeySet();
    const identity = e.b64(keys.sk.publicKey);
    assert.equal(await e.fingerprint(identity), deviceKeys.fingerprint(identity));
  });

  await t.test('the recovery wrap is the same wrap', async () => {
    const keySet = e.generateKeySet();
    const recoveryKey = e.generateRecoveryKey();
    const mine = await e.sealPrivateMaterial(keySet, recoveryKey);
    // The server seals with the salt the client chose, and opens what the
    // client sealed.
    const theirs = deviceKeys.sealPrivateMaterial({
      ik: { publicKey: keySet.ik.publicKey, privateKey: keySet.ik.privateKey },
      sk: { publicKey: keySet.sk.publicKey, privateKey: keySet.sk.privateKey },
      spk: { publicKey: keySet.spk.publicKey, privateKey: keySet.spk.privateKey },
    }, recoveryKey, { salt: mine.salt, iterations: mine.iterations });
    const opened = deviceKeys.openPrivateMaterial(theirs, recoveryKey);
    assert.equal(primitives.b64(opened.sk.privateKey), e.b64(keySet.sk.privateKey));

    // And the client opens what the server sealed.
    const serverSealed = deviceKeys.sealPrivateMaterial({
      ik: { publicKey: keySet.ik.publicKey, privateKey: keySet.ik.privateKey },
      sk: { publicKey: keySet.sk.publicKey, privateKey: keySet.sk.privateKey },
      spk: { publicKey: keySet.spk.publicKey, privateKey: keySet.spk.privateKey },
    }, recoveryKey);
    const clientOpened = await e.openPrivateMaterial(serverSealed, recoveryKey);
    assert.equal(e.b64(clientOpened.sk.privateKey), e.b64(keySet.sk.privateKey));
  });
});
