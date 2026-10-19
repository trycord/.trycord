// The wire format of an encrypted message, and the rules that go with it.
//
// An envelope is what travels between two devices. It carries no plaintext:
// the payload is AES-256-GCM ciphertext, the header is a second, separately
// keyed ciphertext, and the only things in the clear are the fields a
// receiver needs in order to find the key: which session, which
// conversation, which device sent it, which ratchet chain it belongs to,
// and its counter.
//
// The version is in the envelope and is checked on every receipt. A client
// that meets a version it does not implement refuses the message. There is
// no fallback to plaintext, and there is no path in this subsystem that
// accepts a message body which is not an envelope.

'use strict';

const primitives = require('./primitives');
const protocol = require('./protocol');

const REQUIRED_FIELDS = ['v', 'sid', 'cid', 'from', 'to', 'ctr', 'dh', 'iv', 'ct', 'tag', 'hiv', 'hct', 'htag'];

/** An error with the code, message and status the API reports. */
function protocolError(code, message, status) {
  const error = new Error(message);
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
 * cannot be swapped for another device's without the message failing to
 * open.
 */
function associatedData(envelope) {
  return protocol.canonical(
    ['context', protocol.ENVELOPE_AAD_CONTEXT],
    ['version', envelope.v],
    ['session', envelope.sid],
    ['conversation', envelope.cid],
    ['from', envelope.from],
    ['to', envelope.to],
    ['counter', counterBytes(envelope.ctr)],
    ['ratchet', primitives.unb64(envelope.dh)],
    ['agreement', envelope.init ? agreementBytes(envelope.init) : Buffer.alloc(0)]
  );
}

/** The key agreement of a session's first message, in canonical bytes. */
function agreementBytes(init) {
  return protocol.canonical(
    ['ephemeral', primitives.unb64(init.ek)],
    ['identityDh', primitives.unb64(init.ik)],
    ['signedPreKey', primitives.unb64(init.spk)],
    ['oneTimePreKeyId', init.oneTimePreKeyId || ''],
    ['signature', primitives.unb64(init.signature)]
  );
}

/** The counter as four big-endian bytes, so it cannot be re-spelled. */
function counterBytes(counter) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(Number(counter) >>> 0, 0);
  return bytes;
}

/**
 * The bytes an initiator signs when it opens a session.
 *
 * The signature binds the ephemeral key, the identity key and the signed
 * prekey to the session and the conversation, so none of them can be
 * swapped for another device's without breaking it. It is verified against
 * the identity key the responder fetched for that device, which is what
 * makes the whole exchange proof against a server that rewrites bundles.
 */
function initSignatureBytes(fields) {
  return protocol.canonical(
    ['context', protocol.SESSION_INIT_SIGNATURE_CONTEXT],
    ['version', protocol.PROTOCOL_VERSION],
    ['session', fields.sid],
    ['conversation', fields.cid],
    ['from', fields.from],
    ['to', fields.to],
    ['ephemeral', primitives.unb64(fields.ek)],
    ['identityDh', primitives.unb64(fields.ik)],
    ['signedPreKey', primitives.unb64(fields.spk)],
    ['oneTimePreKeyId', fields.oneTimePreKeyId || '']
  );
}

/**
 * Check an envelope's shape and version.
 *
 * A version this build does not implement is refused outright. Falling back
 * to something older, or to plaintext, is exactly the downgrade this
 * protocol refuses: an attacker who can rewrite a message can only make the
 * receiver reject it, never make it accept weaker protection.
 */
function validate(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the message is not an envelope', 400);
  }
  if (Number(envelope.v) !== protocol.PROTOCOL_VERSION) {
    throw protocolError(
      'E2EE_UNSUPPORTED_VERSION',
      'this message uses protocol version ' + envelope.v + ', which this client does not implement',
      400
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
  for (const [field, length] of [['dh', primitives.KEY_BYTES], ['iv', primitives.GCM_IV_BYTES],
    ['hiv', primitives.GCM_IV_BYTES], ['tag', primitives.GCM_TAG_BYTES], ['htag', primitives.GCM_TAG_BYTES]]) {
    let bytes;
    try {
      bytes = primitives.unb64(envelope[field]);
    } catch {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope field ' + field + ' is not base64url', 400);
    }
    if (bytes.length !== length) {
      throw protocolError('E2EE_VALIDATION_ERROR', 'the envelope field ' + field + ' has the wrong length', 400);
    }
  }
  for (const field of ['ct', 'hct']) {
    try {
      primitives.unb64(envelope[field]);
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
    for (const [field, length] of [['ek', primitives.KEY_BYTES], ['ik', primitives.KEY_BYTES],
      ['spk', primitives.KEY_BYTES], ['signature', primitives.SIGNATURE_BYTES]]) {
      let bytes;
      try {
        bytes = primitives.unb64(init[field]);
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

module.exports = {
  protocolError,
  associatedData,
  agreementBytes,
  counterBytes,
  initSignatureBytes,
  validate,
};
