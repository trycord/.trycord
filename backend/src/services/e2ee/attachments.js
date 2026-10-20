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
// plaintext key - there is no field to put one in, and a body that carries
// one is refused rather than quietly dropped.

'use strict';

const db = require('../../db');
const { now, uuid } = require('../../clock');
const { Codes } = require('../../errors');
const { protocolError } = require('./envelope');
const protocol = require('./protocol');
const membership = require('./membership');
const devices = require('./devices');
const uploads = require('../uploads');
const storage = require('../storage');

// The name the ciphertext is stored under. The server does not know what the
// attachment is, so it does not get a name that says: the file is opaque
// bytes, and the name the client gave is kept in the encrypted record.
const STORED_FILENAME = 'attachment.enc';

// The fields a client must never send. An attachment key is sealed to the
// member devices; there is no field in this subsystem that holds one.
const KEY_FIELDS = ['key', 'attachmentKey', 'fileKey', 'secret'];

// An attachment id is used in an object key and in a row id, and it has to
// be one the message path will accept as an attachment of a message: the
// uuid shape every generated id in this codebase has.
const ID = /^[a-f0-9-]{1,64}$/i;

/**
 * Check the seals of an attachment.
 *
 * Every device the key is sealed to has to belong to somebody in the
 * conversation: a seal for a stranger is a key the stranger did not ask
 * for.
 *
 * @param {{userIds: string[]}} group
 * @param {object[]} seals
 */
async function checkSeals(group, seals) {
  if (!seals.length) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'an attachment needs its key sealed to somebody', 400);
  }
  const memberUserIds = new Set(group.userIds);
  for (const entry of seals) {
    const device = await devices.get(entry.deviceId);
    if (!device) {
      throw protocolError('E2EE_VALIDATION_ERROR', 'unknown device in the sealed key list', 400);
    }
    if (!memberUserIds.has(device.user_id)) {
      throw protocolError('E2EE_FORBIDDEN', 'a device outside the conversation cannot be given the key', 403);
    }
    if (device.revoked_at) {
      throw protocolError('E2EE_DEVICE_REVOKED', 'a revoked device cannot be given the key', 403);
    }
  }
}

/**
 * Register an encrypted attachment.
 *
 * The caller must be in the conversation, and every device the key is
 * sealed to must belong to somebody in it.
 */
async function register(userId, input) {
  const group = await membership.requireMembership(input.conversationId, userId);
  const seals = Array.isArray(input.sealedKeys) ? input.sealedKeys : [];
  await checkSeals(group, seals);
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
 * Store an encrypted attachment: the ciphertext, and the key sealed to each
 * member device.
 *
 * The id is the client's, because the key is sealed to the attachment and
 * the client has to know which attachment it is sealing for before it
 * uploads. The bytes go through the storage service under that id, and the
 * ordinary attachment record is written beside them, so the file is served,
 * counted and deleted the way every other attachment is.
 *
 * What is stored is the ciphertext: the client encrypted the file before it
 * uploaded it, and the server cannot tell the difference - which is exactly
 * what an end-to-end encrypted attachment is.
 *
 * @param {string} userId
 * @param {object} input { id, conversationId, filename, mime, buffer, sealedKeys }
 */
async function store(userId, input) {
  const group = await membership.requireMembership(input.conversationId, userId);
  for (const field of KEY_FIELDS) {
    if (input[field] !== undefined && input[field] !== null) {
      throw protocolError(
        'E2EE_VALIDATION_ERROR',
        'an attachment key is never sent to the server: seal it to the member devices instead',
        400
      );
    }
  }
  const buffer = input.buffer;
  if (!buffer || !buffer.length) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'an attachment needs its bytes', 400);
  }
  if (buffer.length > uploads.MAX_SIZE) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the attachment is too large', 400);
  }
  const id = String(input.id || uuid());
  if (!ID.test(id)) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the attachment id is not an id', 400);
  }
  const seals = Array.isArray(input.sealedKeys) ? input.sealedKeys : [];
  await checkSeals(group, seals);

  // The account's quota, counted the way the ordinary upload path counts it.
  const usage = await uploads.quota(userId);
  if (usage.used + buffer.length > usage.limit) {
    throw protocolError(
      'QUOTA_EXCEEDED',
      'Storage quota reached; delete an attachment or ask a moderator to raise your limit',
      Codes.QUOTA_EXCEEDED
    );
  }

  const scope = group.kind === 'channel' ? input.conversationId : 'dm-' + input.conversationId;
  const key = storage.key.messageMedia(scope, id);
  await storage.put(key, buffer, uploads.UNKNOWN_MIME);
  try {
    await db.run(
      `INSERT INTO attachments (id, message_id, channel_id, dm_conversation_id, uploader_id, filename, mime, size, url, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, group.kind === 'channel' ? input.conversationId : null,
        group.kind === 'dm' ? input.conversationId : null,
        userId, STORED_FILENAME, uploads.UNKNOWN_MIME, buffer.length,
        '/api/attachments/' + id, now()]
    );
  } catch (e) {
    // An object with no row is an object nobody can ever delete.
    await storage.delete(key).catch(() => {});
    throw e;
  }

  try {
    const attachment = await register(userId, {
      id,
      conversationId: input.conversationId,
      filename: input.filename || 'attachment',
      mime: input.mime || uploads.UNKNOWN_MIME,
      size: buffer.length,
      sealedKeys: seals,
    });
    return Object.assign({}, attachment, { url: '/api/attachments/' + id });
  } catch (e) {
    // A file with no sealed key is a file nobody can open. The bytes and the
    // row are taken back out rather than left behind.
    await db.run('DELETE FROM attachments WHERE id = ?', [id]);
    await storage.delete(key).catch(() => {});
    throw e;
  }
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

/**
 * The associated data an attachment key seal is bound to.
 *
 * The client seals and opens with exactly these bytes, so a seal cannot be
 * moved to another attachment or to another conversation and opened there.
 */
function sealAad(conversationId, attachmentId) {
  return protocol.canonical(
    ['context', protocol.ATTACHMENT_SEAL_INFO],
    ['conversation', conversationId],
    ['attachment', attachmentId]
  );
}

module.exports = { register, store, get, sealAad };
