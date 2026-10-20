// The wire format of an encrypted message, and the rules that go with it.
//
// An envelope is what travels between two devices. It carries no plaintext:
// the payload is AES-256-GCM ciphertext, the header is a second, separately
// keyed ciphertext, and the only things in the clear are the fields a
// receiver needs in order to find the key: which session, which conversation,
// which device sent it, which ratchet chain it belongs to, and its counter.
//
// The version is in the envelope and is checked on every receipt. A client
// that meets a version it does not implement refuses the message. There is no
// fallback to plaintext, and there is no path in this client that accepts a
// message body which is not an envelope.
//
// The rules here are the server's, field for field. The server validates what
// the client sends, so a difference is a message the server refuses.

import { unb64, utf8 } from './bytes.js';
import {
  ENVELOPE_AAD_CONTEXT,
  PROTOCOL_VERSION,
  SESSION_INIT_SIGNATURE_CONTEXT,
  canonical,
} from './protocol.js';
import { KEY_BYTES, SIGNATURE_BYTES, GCM_IV_BYTES, GCM_TAG_BYTES } from './primitives.js';

const REQUIRED_FIELDS = ['v', 'sid', 'cid', 'from', 'to', 'ctr', 'dh', 'iv', 'ct', 'tag', 'hiv', 'hct', 'htag'];

/** An error with the code, message and status the server reports. */
export function protocolError(code, message, status) {
  const error = new Error(message);
  error.name = 'E2eeProtocolError';
  error.code = code;
  error.status = status || 400;
  return error;
}

/**
 * The associated data of an envelope.
 *
 * The AEAD tag covers this, so a message cannot be moved to another
 * conversation, another session, another sender, or replayed under a
 * different counter without the tag failing. The counter and the ratchet key
 * are in the clear but are covered, so they cannot be edited either.
 *
 * The key agreement of a session's first message is covered as well: the
 * fields the responder needs to agree the secret are in the tag, so they
 * cannot be swapped for another device's without the message failing to open.
 */
export function associatedData(envelope) {
  return canonical(
    ['context', ENVELOPE_AAD_CONTEXT],
    ['version', envelope.v],
    ['session', envelope.sid],
    ['conversation', envelope.cid],
    ['from', envelope.from],
    ['to', envelope.to],
    ['counter', counterBytes(envelope.ctr)],
    ['ratchet', unb64(envelope.dh)],
    ['agreement', envelope.init ? agreementBytes(envelope.init) : new Uint8Array(0)],
  );
}

/** The key agreement of a session's first message, in canonical bytes. */
export function agreementBytes(init) {
  return canonical(
    ['ephemeral', unb64(init.ek)],
    ['identityDh', unb64(init.ik)],
    ['signedPreKey', unb64(init.spk)],
    ['oneTimePreKeyId', init.oneTimePreKeyId || ''],
    ['signature', unb64(init.signature)],
  );
}

/** The counter as four big-endian bytes, so it cannot be re-spelled. */
export function counterBytes(counter) {
  const out = new Uint8Array(4);
  out[0] = (Number(counter) >>> 24) & 0xff;
  out[1] = (Number(counter) >>> 16) & 0xff;
  out[2] = (Number(counter) >>> 8) & 0xff;
  out[3] = Number(counter) & 0xff;
  return out;
}

/**
 * The bytes an initiator signs when it opens a session.
 *
 * The signature binds the ephemeral key, the identity key and the signed
 * prekey to the session and the conversation, so none of them can be swapped
 * for another device's without breaking it. It is verified against the
 * identity key the responder fetched for that device, which is what makes the
 * whole exchange proof against a server that rewrites bundles.
 */
export function initSignatureBytes(fields) {
  return canonical(
    ['context', SESSION_INIT_SIGNATURE_CONTEXT],
    ['version', PROTOCOL_VERSION],
    ['session', fields.sid],
    ['conversation', fields.cid],
    ['from', fields.from],
    ['to', fields.to],
    ['ephemeral', unb64(fields.ek)],
    ['identityDh', unb64(fields.ik)],
    ['signedPreKey', unb64(fields.spk)],
    ['oneTimePreKeyId', fields.oneTimePreKeyId || ''],
  );
}

/**
 * Check an envelope's shape and version.
 *
 * A version this build does not implement is refused outright. Falling back
 * to something older, or to plaintext, is exactly the downgrade this protocol
 * refuses: an attacker who can rewrite a message can only make the receiver
 * reject it, never make it accept weaker protection.
 */
export function validate(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the message is not an envelope', 400);
  }
  if (Number(envelope.v) !== PROTOCOL_VERSION) {
    throw protocolError(
      'E2EE_UNSUPPORTED_VERSION',
      'this message uses protocol version ' + envelope.v + ', which this client does not implement',
      400,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (envelope[field] === undefined || envelope[field] === null || envelope[field] === '') {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope is missing ' + field, 400);
    }
  }
  const counter = Number(envelope.ctr);
  if (!Number.isInteger(counter) || counter < 0) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope counter is not a counter', 400);
  }
  const lengths = [['dh', KEY_BYTES], ['iv', GCM_IV_BYTES], ['hiv', GCM_IV_BYTES],
    ['tag', GCM_TAG_BYTES], ['htag', GCM_TAG_BYTES]];
  for (const [field, length] of lengths) {
    let bytes;
    try {
      bytes = unb64(envelope[field]);
    } catch {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope field ' + field + ' is not base64url', 400);
    }
    if (bytes.length !== length) {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope field ' + field + ' has the wrong length', 400);
    }
  }
  for (const field of ['ct', 'hct']) {
    try {
      unb64(envelope[field]);
    } catch {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope field ' + field + ' is not base64url', 400);
    }
  }
  // The key agreement of a session's first message, when it is there.
  if (envelope.init !== undefined && envelope.init !== null) {
    const init = envelope.init;
    if (!init || typeof init !== 'object') {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope agreement is not an agreement', 400);
    }
    const agreementLengths = [['ek', KEY_BYTES], ['ik', KEY_BYTES], ['spk', KEY_BYTES],
      ['signature', SIGNATURE_BYTES]];
    for (const [field, length] of agreementLengths) {
      let bytes;
      try {
        bytes = unb64(init[field]);
      } catch {
        throw protocolError('E2EE_VALIDATION_ERROR', 'the agreement field ' + field + ' is not base64url', 400);
      }
      if (bytes.length !== length) {
        throw protocolError('E2EE_VALIDATION_ERROR', 'the agreement field ' + field + ' has the wrong length', 400);
      }
    }
  }
  return envelope;
}

export { REQUIRED_FIELDS, utf8 };
