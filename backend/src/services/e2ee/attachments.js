// Encrypted attachments.
//
// The server stores the ciphertext a client uploaded and the key material
// sealed to each member device. It never receives the attachment key in the
// clear, and it cannot open a seal: the seal is an agreement with the
// device's identity key, and the device's identity private key never leaves
// the device.
//
// filename and mime describe the ciphertext, not the content. The server
// has no idea what the attachment is, and the API does not accept a
// plaintext key - there is no field to put one in.

'use strict';

const db = require('../../db');
const { now, uuid } = require('../../clock');
const { protocolError } = require('./envelope');
const membership = require('./membership');
const devices = require('./devices');

/**
 * Register an encrypted attachment.
 *
 * The caller must be in the conversation, and every device the key is
 * sealed to must belong to somebody in it.
 */
async function register(userId, input) {
  const group = await membership.requireMembership(input.conversationId, userId);
  const memberUserIds = new Set(group.userIds);
  const seals = Array.isArray(input.sealedKeys) ? input.sealedKeys : [];
  if (!seals.length) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'an attachment needs its key sealed to somebody', 400);
  }
  for (const entry of seals) {
    const device = await devices.get(entry.deviceId);
    if (!device) {
      throw protocolError('E2EE_VALIDATION_ERROR', 'unknown device in the sealed key list', 400);
    }
    if (!memberUserIds.has(device.user_id)) {
      throw protocolError('E2EE_FORBIDDEN', 'a device outside the conversation cannot be given the key', 403);
    }
  }
  const id = String(input.id || uuid());
  const timestamp = now();
  await db.transaction(async (t) => {
    await t.run(
      `INSERT INTO e2ee_attachments (id, conversation_id, uploader_id, filename, mime, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.conversationId, userId, String(input.filename || 'attachment'),
        String(input.mime || 'application/octet-stream'), Number(input.size) || 0, timestamp]
    );
    for (const entry of seals) {
      await t.run(
        `INSERT INTO e2ee_attachment_keys (attachment_id, device_id, sealed_key, created_at)
         VALUES (?, ?, ?, ?)`,
        [id, entry.deviceId, JSON.stringify(entry.seal || entry), timestamp]
      );
    }
  });
  return { id, conversationId: input.conversationId, filename: input.filename, mime: input.mime, size: input.size };
}

/**
 * The attachment and the seals belonging to the caller's own devices.
 *
 * The seals of other people's devices are not returned: they are not the
 * caller's to have, and handing them out would let one member read
 * another's attachments.
 */
async function get(userId, attachmentId) {
  const attachment = await db.get('SELECT * FROM e2ee_attachments WHERE id = ?', [attachmentId]);
  if (!attachment) throw protocolError('E2EE_NOT_FOUND', 'no such attachment', 404);
  const group = await membership.requireMembership(attachment.conversation_id, userId);
  if (!group.userIds.includes(userId)) {
    throw protocolError('E2EE_FORBIDDEN', 'you are not in this conversation', 403);
  }
  const mine = await db.all(
    `SELECT k.device_id, k.sealed_key
       FROM e2ee_attachment_keys k
       JOIN e2ee_devices d ON d.id = k.device_id
      WHERE k.attachment_id = ? AND d.user_id = ?`,
    [attachmentId, userId]
  );
  return {
    id: attachment.id,
    conversationId: attachment.conversation_id,
    uploaderId: attachment.uploader_id,
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.created_at,
    sealedKeys: mine.map((row) => ({ deviceId: row.device_id, seal: JSON.parse(row.sealed_key) })),
  };
}

module.exports = { register, get };
