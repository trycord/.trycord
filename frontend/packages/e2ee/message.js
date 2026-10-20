// Reading a message that may be encrypted.
//
// A row in an encrypted conversation is not text. It is a list of envelopes -
// one per recipient device - and no text at all: the server stores the
// ciphertext and hands it back, and the row says which it is.
//
// So there are two rules, and the second is the one that gets forgotten:
//
//   1. An encrypted row's content is null. It is never rendered. "null" is
//      not a message, and a reader who sees the word "null" has been shown
//      the shape of the failure rather than the failure.
//   2. A message this device cannot open is shown as a message it cannot
//      read, with the reason. It is not an empty bubble and it is not
//      dropped: a reader has to know that something was said.

import { fromUtf8 } from './bytes.js';

/** The reason a message could not be opened. */
export const REASONS = {
  NOT_FOR_THIS_DEVICE: 'This message was not addressed to this device.',
  NO_SESSION: 'There is no session for this message on this device.',
  FAILED: 'This message could not be opened.',
  UNSUPPORTED: 'This message was written in a version of the protocol this client does not implement.',
};

/**
 * The envelope of a row that is addressed to one device.
 */
export function envelopeFor(row, deviceId) {
  const envelopes = Array.isArray(row.envelopes) ? row.envelopes : [];
  return envelopes.find((envelope) => envelope && envelope.to === deviceId) || null;
}

/**
 * Read a message row.
 *
 * @param {object} row the row as the server sends it
 * @param {object} options { deviceId, manager, conversationId }
 * @returns {Promise<{content: string|null, encrypted: boolean,
 *   unreadable: boolean, reason: string|null}>}
 */
export async function readMessage(row, options) {
  if (!row) return { content: null, encrypted: false, unreadable: true, reason: REASONS.FAILED };
  if (!row.encrypted) {
    return {
      content: row.content === null || row.content === undefined ? '' : String(row.content),
      encrypted: false,
      unreadable: false,
      reason: null,
    };
  }

  // An encrypted row carries no text. Whatever the row says in `content`, it
  // is not the message.
  const envelope = envelopeFor(row, options.deviceId);
  if (!envelope) {
    return { content: null, encrypted: true, unreadable: true, reason: REASONS.NOT_FOR_THIS_DEVICE };
  }
  if (!options.manager) {
    return { content: null, encrypted: true, unreadable: true, reason: REASONS.NO_SESSION };
  }
  try {
    const opened = await options.manager.decryptEnvelope(envelope, {
      conversationId: options.conversationId,
    });
    return {
      content: fromUtf8(opened.plaintext),
      encrypted: true,
      unreadable: false,
      reason: null,
    };
  } catch (error) {
    const reason = error && error.code === 'E2EE_UNSUPPORTED_VERSION'
      ? REASONS.UNSUPPORTED
      : REASONS.FAILED;
    return { content: null, encrypted: true, unreadable: true, reason: reason + ' (' + (error && error.message) + ')' };
  }
}
