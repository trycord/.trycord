// The message body of a conversation, when the conversation is encrypted.
//
// A message in an encrypted conversation is not text. It is an envelope: the
// ratchet's ciphertext, its header, and the few fields a receiver needs in
// order to find the key. The server stores that envelope, hands it to the
// member devices, and never opens it.
//
// This module owns the contract between the three shapes a body takes:
//
//   the wire    the client posts { envelopes: [...] } and nothing else
//   the store   the row's content column holds the stored form
//   the read    a row is either an envelope or text, and the row says which
//
// The stored form is a small JSON object with a marker in it, so a text body
// and an envelope body cannot be confused with one another. The marker is
// checked strictly - the object has to have exactly the two keys it is
// supposed to have - so a message that merely looks like JSON stays text.
//
// A conversation that is not encrypted keeps today's behaviour exactly: the
// body is text, and the text is stored as it was typed. The one exception is
// a text body that would be read back as an envelope, which is escaped (see
// TEXT_ESCAPE) so that it is still read back as the text it is.

'use strict';

const { protocolError, validate } = require('./envelope');
const status = require('./status');
const devices = require('./devices');
const sessions = require('./sessions');
const membership = require('./membership');

// The marker and the version of the stored form.
const STORED_KEY = 'e2ee';
const STORED_VERSION = 1;

// How many envelopes one message may carry.
//
// One envelope is per recipient device, so this is a bound on the size of a
// group message rather than on the size of a conversation. It is here so
// that a body cannot make the server do an unbounded amount of work for one
// message.
const MAX_ENVELOPES = 100;

// The escape for a text body that would otherwise be read back as an
// envelope.
//
// A NUL byte cannot begin a JSON object, so a body that starts with one is
// unambiguously text. It is only ever written when the text would otherwise
// be ambiguous - a message whose whole content is a JSON object carrying
// this module's marker - which is rare enough that ordinary messages are
// stored byte for byte as they were typed.
const TEXT_ESCAPE = '\u0000';

/**
 * The stored form of an encrypted message.
 *
 * @param {object[]} envelopes
 * @returns {string}
 */
function encode(envelopes) {
  return JSON.stringify({ [STORED_KEY]: STORED_VERSION, envelopes });
}

/**
 * The envelopes a stored body carries, or null when it is text.
 *
 * @param {string} text
 * @returns {object[]|null}
 */
function decode(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes(STORED_KEY) || !keys.includes('envelopes')) return null;
  if (parsed[STORED_KEY] !== STORED_VERSION) return null;
  if (!Array.isArray(parsed.envelopes) || !parsed.envelopes.length) return null;
  return parsed.envelopes;
}

/**
 * The stored form of a text body.
 *
 * The text is stored as it was typed, unless it would be read back as an
 * envelope - in which case it is escaped so that it is not.
 *
 * @param {string} text
 * @returns {string}
 */
function encodeText(text) {
  const value = String(text === null || text === undefined ? '' : text);
  return decode(value) ? TEXT_ESCAPE + value : value;
}

/**
 * The text a stored body holds, with the escape removed.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeText(text) {
  const value = String(text === null || text === undefined ? '' : text);
  return value.startsWith(TEXT_ESCAPE) ? value.slice(TEXT_ESCAPE.length) : value;
}

/**
 * What a stored body holds.
 *
 * @param {string} text
 * @returns {{encrypted: boolean, envelopes: object[]|null, content: string|null}}
 */
function readStored(text) {
  const value = typeof text === 'string' ? text : '';
  const envelopes = decode(value);
  if (envelopes) return { encrypted: true, envelopes, content: null };
  return { encrypted: false, envelopes: null, content: decodeText(value) };
}

/**
 * Mark a stored row: an envelope row says so, and carries no text.
 *
 * The row is the client's answer to "is this message encrypted?", so the
 * flag is on the row rather than in a lookup the client has to make.
 *
 * @param {object} row
 * @returns {object} the same row
 */
function applyToRow(row) {
  if (!row || typeof row !== 'object') return row;
  const stored = readStored(row.content);
  row.encrypted = stored.encrypted;
  row.envelopes = stored.envelopes;
  row.content = stored.content;
  return row;
}

/**
 * The envelopes a request body carries.
 *
 * Null when the body carries none. A refusal when the body carries
 * something that is not a list of envelopes: a body the server cannot
 * understand is refused, never treated as an ordinary text message.
 *
 * @param {object} body
 * @returns {object[]|null}
 */
function readEnvelopes(body) {
  const raw = body ? body.envelopes : undefined;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw protocolError(
      'E2EE_VALIDATION_ERROR',
      'the message body is malformed: envelopes must be a list',
      400
    );
  }
  if (!raw.length) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a message needs at least one envelope', 400);
  }
  return raw;
}

/**
 * Check every envelope of a message against the conversation it is for.
 *
 * The server cannot read an envelope, but it can say whether it is
 * addressed to this conversation, whether it claims to come from one of the
 * sender's own devices, and whether it is addressed to a device that is in
 * the conversation at all. An envelope that fails any of those is refused:
 * it would be a message nobody in the conversation can read, or one that
 * pretends to come from somebody else.
 *
 * @param {string} conversationId
 * @param {string} userId the sender
 * @param {object[]} envelopes
 */
async function validateEnvelopes(conversationId, userId, envelopes) {
  if (envelopes.length > MAX_ENVELOPES) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a message carries too many envelopes', 400);
  }
  const found = await membership.members(conversationId);
  if (!found) throw protocolError('E2EE_NOT_FOUND', 'no such conversation', 404);
  const memberUsers = new Set(found.userIds);
  const recipients = new Set();

  for (const env of envelopes) {
    // The shape and the version. A version this build does not implement is
    // refused here rather than downgraded anywhere else.
    validate(env);

    if (env.cid !== conversationId) {
      throw protocolError(
        'E2EE_VALIDATION_ERROR',
        'the envelope belongs to another conversation',
        400
      );
    }
    if (recipients.has(env.to)) {
      throw protocolError(
        'E2EE_VALIDATION_ERROR',
        'the same device is addressed twice',
        400
      );
    }
    recipients.add(env.to);

    const from = await devices.get(env.from);
    if (!from || from.user_id !== userId || from.revoked_at) {
      throw protocolError(
        'E2EE_FORBIDDEN',
        'the envelope does not come from one of your own devices',
        403
      );
    }

    const to = await devices.get(env.to);
    if (!to || to.revoked_at || !memberUsers.has(to.user_id)) {
      throw protocolError(
        'E2EE_FORBIDDEN',
        'the envelope is addressed to a device outside the conversation',
        403
      );
    }

    // The session, when the server has seen it, has to be the sender's. A
    // client that has not registered its session yet is allowed through: the
    // session is the client's own bookkeeping and the server has no reason
    // to insist on seeing it before the first message.
    const session = await sessions.byId(env.sid);
    if (session && (session.user_id !== userId || session.device_id !== env.from)) {
      throw protocolError(
        'E2EE_FORBIDDEN',
        'the envelope claims a session that is not yours',
        403
      );
    }
  }
}

/**
 * Check a message body against the conversation it is going into.
 *
 * The answer comes from the status service: whether a conversation is
 * encrypted is a fact about the keys its members hold, not something a
 * client asserts in the body of a message.
 *
 * In an encrypted conversation a body has to be an envelope. There is no
 * plaintext path into one, and there is no "store it as a link" path out of
 * one: a message the server cannot validate is refused, and nothing is
 * stored.
 *
 * In a conversation that is not encrypted - because no key has been
 * published, because some member device is missing it, or because the
 * caller's own device is behind - a body has to be text, and it is stored
 * exactly as it would have been before encryption existed. The state is
 * returned with it so that the client can say what is true.
 *
 * @param {string} conversationId
 * @param {string} userId the sender
 * @param {object} body { content, envelopes }
 * @returns {Promise<{encrypted: boolean, stored: string, content: string|null,
 *   envelopes: object[]|null, encryption: object}>}
 */
async function accept(conversationId, userId, body) {
  const encryption = await status.encryptionSummary(conversationId, userId);
  const envelopes = readEnvelopes(body);

  if (encryption.encrypted) {
    if (!envelopes) {
      throw protocolError(
        'E2EE_VALIDATION_ERROR',
        'this conversation is encrypted: the message has to be sent as an envelope',
        400
      );
    }
    await validateEnvelopes(conversationId, userId, envelopes);
    return {
      encrypted: true,
      stored: encode(envelopes),
      content: null,
      envelopes,
      encryption,
    };
  }

  if (envelopes) {
    throw protocolError(
      'E2EE_VALIDATION_ERROR',
      'this conversation is not encrypted (' + encryption.state + '): a message to it is stored as text',
      400
    );
  }

  const text = String(body && body.content !== undefined && body.content !== null ? body.content : '');
  return {
    encrypted: false,
    stored: encodeText(text),
    content: text,
    envelopes: null,
    encryption,
  };
}

module.exports = {
  STORED_KEY,
  STORED_VERSION,
  MAX_ENVELOPES,
  TEXT_ESCAPE,
  encode,
  decode,
  encodeText,
  decodeText,
  readStored,
  applyToRow,
  readEnvelopes,
  validateEnvelopes,
  accept,
};
