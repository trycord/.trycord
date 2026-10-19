/**
 * The end-to-end encryption envelope.
 *
 * The envelope is the server's, from `backend/src/services/e2ee/envelope.js`.
 * These tests hold the client to the same rules the server holds: the
 * version is checked, every field must be there, the counter must be a
 * counter, and the base64url fields must be the right length.
 */

import {
  base64UrlByteLength,
  E2EE_GCM_IV_BYTES,
  E2EE_GCM_TAG_BYTES,
  E2EE_KEY_BYTES,
  E2EE_PROTOCOL_VERSION,
  E2eeUnsupportedError,
  isE2eeEnvelope,
  readE2eeEnvelope,
} from '../envelope';

/** A 32-byte key, base64url, unpadded. */
const key32 = 'A'.repeat(43);
/** A 12-byte nonce, base64url, unpadded. */
const nonce12 = 'B'.repeat(16);
/** A 16-byte tag, base64url, unpadded. */
const tag16 = 'C'.repeat(22);
/** A ciphertext of any length, base64url. */
const ciphertext = 'ZA';

const envelope = {
  v: E2EE_PROTOCOL_VERSION,
  sid: 'session-1',
  cid: 'conversation-1',
  from: 'device-a',
  to: 'device-b',
  ctr: 7,
  dh: key32,
  iv: nonce12,
  ct: ciphertext,
  tag: tag16,
  hiv: nonce12,
  hct: ciphertext,
  htag: tag16,
};

describe('the end-to-end encryption envelope', () => {
  it('recognises an envelope of the version it reads', () => {
    expect(isE2eeEnvelope(envelope)).toBe(true);
    expect(readE2eeEnvelope(envelope)).toEqual(envelope);
  });

  it('refuses an envelope of a version it does not know', () => {
    const older = {...envelope, v: E2EE_PROTOCOL_VERSION + 1};

    expect(isE2eeEnvelope(older)).toBe(true);
    expect(() => readE2eeEnvelope(older)).toThrow(E2eeUnsupportedError);
    expect(() => readE2eeEnvelope(older)).toThrow(/version 2/);
  });

  it('refuses something that is not an envelope', () => {
    expect(isE2eeEnvelope(null)).toBe(false);
    expect(isE2eeEnvelope({content: 'hello'})).toBe(false);
    expect(() => readE2eeEnvelope({content: 'hello'})).toThrow(
      E2eeUnsupportedError,
    );
  });

  it('refuses an envelope with a field missing', () => {
    const partial = {...envelope};
    delete (partial as Record<string, unknown>).htag;

    expect(isE2eeEnvelope(partial)).toBe(false);
    expect(() => readE2eeEnvelope(partial)).toThrow(/htag/);
  });

  it('refuses a counter that is not a counter', () => {
    const bad = {...envelope, ctr: -1};

    expect(isE2eeEnvelope(bad)).toBe(false);
    expect(() => readE2eeEnvelope(bad)).toThrow(/counter/);
  });

  it('refuses a field of the wrong length', () => {
    const short = {...envelope, dh: 'AAAA'};

    expect(() => readE2eeEnvelope(short)).toThrow(/dh/);
  });

  it('refuses a field that is not base64url', () => {
    const bad = {...envelope, ct: 'not base64!'};

    expect(() => readE2eeEnvelope(bad)).toThrow(/ct/);
  });

  it('measures a base64url string', () => {
    expect(base64UrlByteLength('AAAA')).toBe(3);
    expect(base64UrlByteLength('AAA')).toBe(2);
    expect(base64UrlByteLength('AA')).toBe(1);
    expect(base64UrlByteLength('A')).toBeNull();
    expect(base64UrlByteLength('not base64!')).toBeNull();
    expect(base64UrlByteLength('')).toBeNull();
  });

  it('knows the lengths the protocol fixes', () => {
    expect(E2EE_KEY_BYTES).toBe(32);
    expect(E2EE_GCM_IV_BYTES).toBe(12);
    expect(E2EE_GCM_TAG_BYTES).toBe(16);
  });
});
