// Reading a message that may be encrypted.
//
// Two rules, and the second is the one that gets forgotten: an encrypted row
// carries no text, and a message the client cannot open is shown as a message
// it cannot read rather than as an empty bubble.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from '../helpers/dom-stub.js';

import * as e from '../../packages/e2ee/index.js';

installDomStub();
const { readRow } = await import('../../js/ui/encrypted.js');

const CONVERSATION = 'conversation-1';

function envelopeFor(deviceId, counter = 1) {
  return {
    v: 1,
    sid: 'session-1',
    cid: CONVERSATION,
    from: 'their-device',
    to: deviceId,
    ctr: counter,
    dh: e.b64(new Uint8Array(32)),
    iv: e.b64(new Uint8Array(12)),
    ct: e.b64(new Uint8Array(4)),
    tag: e.b64(new Uint8Array(16)),
    hiv: e.b64(new Uint8Array(12)),
    hct: e.b64(new Uint8Array(4)),
    htag: e.b64(new Uint8Array(16)),
  };
}

test('reading a message', async (t) => {
  await t.test('a message that is not encrypted is its own text', async () => {
    const read = await e.readMessage(
      { id: 'm1', content: 'hello bob', encrypted: false },
      { deviceId: 'my-device', manager: null, conversationId: CONVERSATION },
    );
    assert.equal(read.content, 'hello bob');
    assert.equal(read.encrypted, false);
    assert.equal(read.unreadable, false);
  });

  await t.test('an encrypted message carries no text, and none is shown', async () => {
    const manager = {
      decryptEnvelope: async () => ({ plaintext: e.utf8('the real text') }),
    };
    const read = await e.readMessage(
      {
        id: 'm2',
        content: null,
        encrypted: true,
        envelopes: [envelopeFor('my-device')],
      },
      { deviceId: 'my-device', manager, conversationId: CONVERSATION },
    );
    assert.equal(read.content, 'the real text');
    assert.equal(read.encrypted, true);
    assert.equal(read.unreadable, false);
  });

  await t.test('the text of an encrypted row is never what is shown', async () => {
    // A server that answered an encrypted row with text anyway: the client
    // opens the envelope, and the text it did not open is not what the
    // reader sees.
    const manager = {
      decryptEnvelope: async () => ({ plaintext: e.utf8('the real text') }),
    };
    const read = await e.readMessage(
      {
        id: 'm3',
        content: 'a text the server should not have sent',
        encrypted: true,
        envelopes: [envelopeFor('my-device')],
      },
      { deviceId: 'my-device', manager, conversationId: CONVERSATION },
    );
    assert.equal(read.content, 'the real text');
    assert.ok(!String(read.content).includes('should not have sent'));
  });

  await t.test('a message for another device cannot be read here', async () => {
    const manager = {
      decryptEnvelope: async () => { throw new Error('it should not be called'); },
    };
    const read = await e.readMessage(
      {
        id: 'm4',
        content: null,
        encrypted: true,
        envelopes: [envelopeFor('another-device')],
      },
      { deviceId: 'my-device', manager, conversationId: CONVERSATION },
    );
    assert.equal(read.content, null);
    assert.equal(read.unreadable, true);
    assert.ok(read.reason && read.reason.length > 10, 'the reason has to say what happened');
  });

  await t.test('a message that cannot be opened is unreadable, with the reason', async () => {
    const manager = {
      decryptEnvelope: async () => { throw new Error('the tag does not verify'); },
    };
    const read = await e.readMessage(
      {
        id: 'm5',
        content: null,
        encrypted: true,
        envelopes: [envelopeFor('my-device')],
      },
      { deviceId: 'my-device', manager, conversationId: CONVERSATION },
    );
    assert.equal(read.content, null);
    assert.equal(read.unreadable, true);
    assert.ok(/could not be opened/i.test(read.reason), 'the reason is in words: ' + read.reason);
  });

  await t.test('a row that cannot be read is shown as a message that cannot be read', async () => {
    const row = await readRow({
      id: 'm6',
      content: null,
      encrypted: true,
      envelopes: [envelopeFor('another-device')],
    }, CONVERSATION);
    assert.ok(row.content, 'the reader is shown something');
    assert.notEqual(row.content, 'null', 'the word null is not a message');
    assert.notEqual(row.content, '', 'an empty bubble is not a message either');
    assert.equal(row.unreadable, true);
    assert.ok(/cannot|could not|not addressed/i.test(row.content), 'the reason is in words: ' + row.content);
  });

  await t.test('a row that is not encrypted is left alone', async () => {
    const row = await readRow({ id: 'm7', content: 'hello bob' }, CONVERSATION);
    assert.equal(row.content, 'hello bob');
    assert.equal(row.unreadable, false);
  });
});
