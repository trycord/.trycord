// Encrypted attachments.
//
// A file is encrypted with a key of its own, the key is sealed to the member
// devices, and the ciphertext is uploaded. The server holds bytes it cannot
// read and a seal it cannot open, and the id is the client's - because the
// key is sealed to the attachment before the file is uploaded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startInstance, register, transportFor } from './helpers/instance.js';
import { server } from './helpers/server.js';
import * as e from '../../packages/e2ee/index.js';

const { client: serverClient } = server;

test('an encrypted attachment', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const alice = await register(instance, 'alice');
  const bob = await register(instance, 'bob');

  const client = await e.E2eeClient.open({
    store: e.memoryStore(),
    api: e.createE2eeApi(transportFor(alice)),
  });
  await client.ready({ userId: alice.user.id, label: 'alice laptop' });

  const bobDevice = serverClient.createDevice(bob.user.id, 'bob phone');
  await bob.post('/api/e2ee/devices', serverClient.registerBody(bobDevice));
  await bob.post('/api/e2ee/prekeys', serverClient.publishBody(bobDevice, 4));

  const opened = await alice.post('/api/dms', { userId: bob.user.id });
  const conversationId = opened.data.id;

  const plaintext = e.utf8('the secret contents of the file');
  let attachmentId = null;

  await t.test('the file is uploaded as ciphertext, under the client\'s id', async () => {
    const members = [
      { deviceId: client.device.id },
      { deviceId: bobDevice.deviceId },
    ];
    const uploaded = await client.uploadFile({
      conversationId,
      bytes: plaintext,
      filename: 'notes.txt',
      mime: 'text/plain',
      memberDevices: members,
    });
    attachmentId = uploaded.id;
    assert.ok(attachmentId, 'the client chose the id');

    const row = await instance.db.get('SELECT * FROM e2ee_attachments WHERE id = ?', [attachmentId]);
    assert.ok(row, 'the server holds the attachment');
    assert.equal(row.conversation_id, conversationId);
    assert.equal(row.uploader_id, alice.user.id);

    // The stored file is the ciphertext, and the server names it as such.
    const stored = await instance.db.get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
    assert.ok(stored, 'the file itself is there');
    assert.equal(stored.filename, 'attachment.enc');
    assert.equal(stored.mime, 'application/octet-stream');

    const bytes = await client.api.attachmentBytes(attachmentId);
    assert.notEqual(e.fromUtf8(bytes), 'the secret contents of the file');
    assert.ok(!e.fromUtf8(bytes).includes('secret contents'));
  });

  await t.test('the key is sealed to the member devices, and to nobody else', async () => {
    const answer = await client.api.attachment(attachmentId);
    const sealed = answer.attachment.sealedKeys;
    assert.equal(sealed.length, 1, 'the caller only sees the seals of its own devices');
    assert.equal(sealed[0].deviceId, client.device.id);
    const rows = await instance.db.all('SELECT * FROM e2ee_attachment_keys WHERE attachment_id = ?', [attachmentId]);
    assert.equal(rows.length, 2, 'both member devices are given a seal');
  });

  await t.test('the device opens the file with its own seal', async () => {
    const opened = await client.openAttachment(conversationId, attachmentId);
    assert.equal(e.fromUtf8(opened), 'the secret contents of the file');
  });

  await t.test('a device that was not given the key cannot open the file', async () => {
    const other = await e.E2eeClient.open({
      store: e.memoryStore(),
      api: e.createE2eeApi(transportFor(alice)),
    });
    await other.ready({ userId: alice.user.id, label: 'another browser' });
    await assert.rejects(
      () => other.openAttachment(conversationId, attachmentId),
      (error) => error.code === 'E2EE_FORBIDDEN',
    );
  });
});
