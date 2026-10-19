/**
 * The end-to-end encryption envelope.
 *
 * The server's protocol is in `backend/src/services/e2ee/`. This file is the
 * client half of it: the shape of an envelope, and the rules for refusing
 * one.
 *
 * Trycord E2EE, version 1 ("TCE2E-v1"). It follows X3DH and the Double
 * Ratchet over X25519, Ed25519, HKDF-SHA256 and AES-256-GCM.
 *
 * An envelope carries no plaintext. The payload is AES-256-GCM ciphertext
 * and the header is a second, separately keyed ciphertext. The only things
 * in the clear are the fields a receiver needs in order to find the key:
 * which session, which conversation, which device sent it, which device it
 * is for, the ratchet chain it belongs to, and its counter.
 *
 * The version is in the envelope and is checked on every receipt. A client
 * that meets a version it does not implement refuses the message. There is
 * no fallback to plaintext, and this client will not produce one either.
 */

/** The protocol version this client reads. */
export const E2EE_PROTOCOL_VERSION = 1;

/** X25519 and Ed25519 keys are 32 bytes. */
export const E2EE_KEY_BYTES = 32;

/** The AES-GCM nonce length. */
export const E2EE_GCM_IV_BYTES = 12;

/** The AES-GCM authentication tag length. */
export const E2EE_GCM_TAG_BYTES = 16;

/** The fields the server requires, in its own order. */
export const E2EE_REQUIRED_FIELDS = [
  'v',
  'sid',
  'cid',
  'from',
  'to',
  'ctr',
  'dh',
  'iv',
  'ct',
  'tag',
  'hiv',
  'hct',
  'htag',
] as const;

/**
 * The envelope.
 *
 * The field names are the server's, shortened: the server's `dh` is the
 * ratchet key, `iv`/`ct`/`tag` are the payload and `hiv`/`hct`/`htag` are
 * the header. The names here are the same, so an envelope that arrived on
 * the wire is read without a translation.
 */
export interface E2eeEnvelope {
  /** The protocol version. */
  v: number;
  /** The session the message belongs to. */
  sid: string;
  /** The conversation the message belongs to. */
  cid: string;
  /** The device that sent it. */
  from: string;
  /** The device it is for. */
  to: string;
  /** The counter in the sending chain. */
  ctr: number;
  /** The ratchet key, base64url, 32 bytes. */
  dh: string;
  /** The payload nonce, base64url, 12 bytes. */
  iv: string;
  /** The payload ciphertext, base64url. */
  ct: string;
  /** The payload authentication tag, base64url, 16 bytes. */
  tag: string;
  /** The header nonce, base64url, 12 bytes. */
  hiv: string;
  /** The header ciphertext, base64url. */
  hct: string;
  /** The header authentication tag, base64url, 16 bytes. */
  htag: string;
}

/** What kind of conversation an envelope belongs to. */
export type E2eeScopeKind = 'channel' | 'dm';

/**
 * The conversation an envelope belongs to.
 *
 * The server names a conversation by one identifier, in the envelope's `cid`.
 * A community and a direct conversation are different conversations, and the
 * kind is kept here so the client can tell them apart.
 */
export interface E2eeScope {
  kind: E2eeScopeKind;
  /** The conversation id, which is the envelope's `cid`. */
  id: string;
  /** The community the conversation belongs to, when it has one. */
  communityId: string | null;
}

/** The error the client raises when it meets an envelope it cannot open. */
export class E2eeUnsupportedError extends Error {
  readonly envelopeVersion: number | null;

  constructor(message: string, envelopeVersion: number | null = null) {
    super(message);
    this.name = 'E2eeUnsupportedError';
    this.envelopeVersion = envelopeVersion;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The number of bytes a base64url string holds.
 *
 * The encoding is unpadded base64url, so the length is arithmetic rather
 * than a decode. A string that is not base64url has no length, and answers
 * null.
 */
export function base64UrlByteLength(text: unknown): number | null {
  if (typeof text !== 'string' || !text.length) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  if (text.length % 4 === 1) return null;
  return Math.floor((text.length * 3) / 4);
}

/**
 * Whether a value looks like an envelope.
 *
 * This checks the shape only. It says whether the value could be attempted,
 * not whether it is good: the cryptography decides that, and the tag failing
 * is the answer.
 */
export function isE2eeEnvelope(value: unknown): value is E2eeEnvelope {
  if (!isRecord(value)) return false;
  for (const field of E2EE_REQUIRED_FIELDS) {
    const found = value[field];
    if (found === undefined || found === null || found === '') return false;
  }
  if (typeof value.ctr !== 'number' || !Number.isInteger(value.ctr)) return false;
  if (value.ctr < 0) return false;
  return true;
}

/**
 * Reads a value as an envelope this build can open.
 *
 * A version this build does not know is refused, with the version named, so
 * the person reading the error can tell an old client from a broken one.
 * The field lengths are checked too, because a field of the wrong length is
 * a message that cannot be opened and there is no point carrying it further.
 */
export function readE2eeEnvelope(value: unknown): E2eeEnvelope {
  if (!isRecord(value)) {
    throw new E2eeUnsupportedError('This is not an end-to-end encrypted envelope.');
  }

  const version = Number(value.v);
  if (!Number.isFinite(version)) {
    throw new E2eeUnsupportedError('The envelope has no protocol version.');
  }
  if (version !== E2EE_PROTOCOL_VERSION) {
    throw new E2eeUnsupportedError(
      `This envelope uses protocol version ${version}; this client reads version ${E2EE_PROTOCOL_VERSION}.`,
      version,
    );
  }

  for (const field of E2EE_REQUIRED_FIELDS) {
    const found = value[field];
    if (found === undefined || found === null || found === '') {
      throw new E2eeUnsupportedError(`The envelope is missing "${field}".`);
    }
  }

  const counter = Number(value.ctr);
  if (!Number.isInteger(counter) || counter < 0) {
    throw new E2eeUnsupportedError('The envelope counter is not a counter.');
  }

  const lengths: [string, number][] = [
    ['dh', E2EE_KEY_BYTES],
    ['iv', E2EE_GCM_IV_BYTES],
    ['hiv', E2EE_GCM_IV_BYTES],
    ['tag', E2EE_GCM_TAG_BYTES],
    ['htag', E2EE_GCM_TAG_BYTES],
  ];
  for (const [field, expected] of lengths) {
    const size = base64UrlByteLength(value[field]);
    if (size === null) {
      throw new E2eeUnsupportedError(
        `The envelope field "${field}" is not base64url.`,
      );
    }
    if (size !== expected) {
      throw new E2eeUnsupportedError(
        `The envelope field "${field}" has the wrong length.`,
      );
    }
  }

  for (const field of ['ct', 'hct']) {
    if (base64UrlByteLength(value[field]) === null) {
      throw new E2eeUnsupportedError(
        `The envelope field "${field}" is not base64url.`,
      );
    }
  }

  return value as unknown as E2eeEnvelope;
}
