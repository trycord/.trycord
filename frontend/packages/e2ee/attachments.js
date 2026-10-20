// Encrypted attachments.
//
// The file is encrypted with a random key before it is uploaded, and that key
// is sealed to each member device. The server stores the ciphertext and the
// seals, and holds no key it can open.
//
// The name and the type describe the ciphertext, not the content: the server
// has no idea what the attachment is. The real name belongs inside the
// encrypted message, which is why the client sends the name it wants with
// the file and the reader gets the name from the message.
//
// The id is the client's, because the key is sealed to the attachment and the
// client has to know which attachment it is sealing for before it uploads.

import { unb64, randomBytes, concatBytes } from './bytes.js';
import { encrypt, decrypt, GCM_IV_BYTES, GCM_TAG_BYTES, KEY_BYTES } from './primitives.js';
import { seal, open } from './sealing.js';
import { canonical, ATTACHMENT_SEAL_INFO } from './protocol.js';
import { newId } from './device.js';

/**
 * The associated data an attachment key seal is bound to.
 *
 * The client seals and opens with exactly these bytes, so a seal cannot be
 * moved to another attachment or to another conversation and opened there.
 */
export function sealAad(conversationId, attachmentId) {
  return canonical(
    ['context', ATTACHMENT_SEAL_INFO],
    ['conversation', conversationId],
    ['attachment', attachmentId],
  );
}

/**
 * Encrypt a file with a key of its own.
 *
 * The uploaded bytes are the nonce, the tag and the ciphertext, in that order:
 * the server stores opaque bytes, so everything the reader needs to open the
 * file has to be in them.
 *
 * @param {Uint8Array} bytes the file
 * @returns {Promise<{key: Uint8Array, blob: Uint8Array}>}
 */
export async function encryptFile(bytes) {
  const key = randomBytes(KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = await encrypt(key, iv, bytes, null);
  return { key, blob: concatBytes(sealed.iv, sealed.tag, sealed.ciphertext) };
}

/** Decrypt a file with the key that was sealed to the device. */
export async function decryptFile(key, blob) {
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error('the encrypted file is shorter than its own header');
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  return decrypt(key, iv, ciphertext, tag, null);
}

/**
 * Seal an attachment key to one device.
 */
export async function sealForDevice(key, deviceId, identityDhPublic, conversationId, attachmentId) {
  const sealValue = await seal(
    key,
    unb64(identityDhPublic),
    sealAad(conversationId, attachmentId),
    ATTACHMENT_SEAL_INFO,
  );
  return { deviceId, seal: sealValue };
}

/**
 * Open an attachment key seal with the device's own identity key.
 */
export function openForDevice(sealValue, device, conversationId, attachmentId) {
  return open(
    sealValue,
    device.keys.ik.privateKey,
    device.keys.ik.publicKey,
    sealAad(conversationId, attachmentId),
    ATTACHMENT_SEAL_INFO,
  );
}

/**
 * Upload an encrypted attachment.
 *
 * The ciphertext goes up; the key does not. The key is sealed to the member
 * devices and the seals go with it.
 *
 * @param {object} deps { api, device, peerKeys }
 * @param {object} options { conversationId, filename, mime, bytes, memberDevices }
 * @returns {Promise<{id: string, seals: object[]}>}
 */
export async function upload(deps, options) {
  const id = newId();
  const { key, blob } = await encryptFile(options.bytes);
  const seals = [];
  for (const member of options.memberDevices) {
    const keys = await deps.peerKeys(member.deviceId);
    seals.push(await sealForDevice(
      key,
      member.deviceId,
      keys.identityDhKey,
      options.conversationId,
      id,
    ));
  }

  const form = new FormData();
  form.append('file', new Blob([blob], { type: 'application/octet-stream' }), 'attachment.enc');
  form.append('id', id);
  form.append('conversationId', options.conversationId);
  form.append('filename', options.filename || 'attachment');
  form.append('mime', options.mime || 'application/octet-stream');
  form.append('sealedKeys', JSON.stringify(seals));
  await deps.api.uploadAttachment(form);
  return { id, key, seals };
}

/**
 * The key of an attachment, opened with the device's own seal.
 */
export async function keyForDevice(deps, options) {
  const answer = await deps.api.attachment(options.attachmentId);
  const attachment = answer && answer.attachment;
  if (!attachment || !Array.isArray(attachment.sealedKeys)) return null;
  for (const entry of attachment.sealedKeys) {
    if (entry.deviceId !== deps.device.id) continue;
    const key = await openForDevice(
      entry.seal,
      deps.device,
      options.conversationId,
      options.attachmentId,
    );
    return { key, attachment };
  }
  return null;
}

