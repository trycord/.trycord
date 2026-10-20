// The protocol this client implements, in one place.
//
// Trycord E2EE, version 1 ("TCE2E-v1"). It follows two published designs:
//
//   X3DH            https://signal.org/docs/specifications/x3dh/
//   Double Ratchet  https://signal.org/docs/specifications/doubleratchet/
//
// over X25519, Ed25519, HKDF-SHA256 and AES-256-GCM, with PBKDF2-HMAC-SHA256
// used only to turn a human-held recovery secret into a wrapping key.
//
// Every name below is the server's name and every value is the server's value.
// The labels are what separate one derivation from another: a key derived for
// one purpose can never be the key for another, because the difference is in
// the label and not in a convention anybody has to remember. A label that
// differs by a character produces keys that do not open, and the failure looks
// like a broken protocol rather than a typo, so they are copied rather than
// retyped.
//
//   X3DH      SK = HKDF-SHA256(ikm = DH1 || DH2 || DH3 || DH4,
//                             salt = 32 zero bytes,
//                             info = "trycord-x3dh-v1",
//                             32 bytes)
//   Ratchet   RK  = HKDF-SHA256(ikm = SK, salt = 32 zero bytes,
//                             info = "trycord-double-ratchet-v1|root-seed",
//                             32 bytes)
//   Root step (RK, CK) = HKDF-SHA256(ikm = DH output, salt = RK,
//                             info = "trycord-double-ratchet-v1|root",
//                             64 bytes)
//   Chain     (MK, CK') = HKDF-SHA256(ikm = CK, salt = 32 zero bytes,
//                             info = "trycord-double-ratchet-v1|chain",
//                             64 bytes)
//   Header    HK = HKDF-SHA256(ikm = MK, salt = 32 zero bytes,
//                             info = "trycord-double-ratchet-v1|header",
//                             32 bytes)

import { concatBytes, isBytes, u32be, utf8 } from './bytes.js';

/** The protocol version this client speaks. */
export const PROTOCOL_VERSION = 1;

// The X3DH shared-secret label.
export const X3DH_INFO = 'trycord-x3dh-v1';

// The Double Ratchet labels: the domain, and then the step of the schedule.
export const RATCHET_INFO = 'trycord-double-ratchet-v1';
export const RATCHET_ROOT_SEED_INFO = RATCHET_INFO + '|root-seed';
export const RATCHET_ROOT_INFO = RATCHET_INFO + '|root';
export const RATCHET_CHAIN_INFO = RATCHET_INFO + '|chain';
export const RATCHET_HEADER_INFO = RATCHET_INFO + '|header';

// The labels outside the ratchet: the group-key seal, the ratchet-state blob
// the server stores without being able to read it, the recovery wrap, and the
// attachment seal.
export const GROUP_SEAL_INFO = 'trycord-e2ee-v1|group-seal';
export const RATCHET_STATE_INFO = 'trycord-e2ee-v1|ratchet-state';
export const RECOVERY_WRAP_INFO = 'trycord-e2ee-v1|recovery-wrap';
export const ATTACHMENT_SEAL_INFO = 'trycord-e2ee-v1|attachment-seal';

// The contexts that are signed, so a signature cannot be replayed into a
// different one.
export const PREKEY_SIGNATURE_CONTEXT = 'trycord-e2ee-prekey-v1';
export const SESSION_INIT_SIGNATURE_CONTEXT = 'trycord-e2ee-init-v1';
export const RECOVERY_PROOF_CONTEXT = 'trycord-e2ee-recovery-v1';

// The envelope's associated-data context.
export const ENVELOPE_AAD_CONTEXT = 'trycord-e2ee-v1';

// The bounds. A skipped-key store that can grow without limit is a denial of
// service against the receiver's storage, so it is capped, and the cap is
// enforced rather than documented.
export const MAX_SKIPPED_KEYS = 1000;

// The number of message keys kept for a chain that has just been replaced, so
// a message from that chain that arrives late can still be read.
export const MAX_STALE_CHAIN_KEYS = 100;

// The cost of the recovery key: 200 000 iterations of HMAC-SHA256, which is
// the OWASP recommendation for PBKDF2-HMAC-SHA256. The secret is a
// human-held phrase, so the work factor belongs on whoever guesses it.
export const RECOVERY_PBKDF2_ITERATIONS = 200000;
export const RECOVERY_SALT_BYTES = 16;

/** A 32-byte HKDF salt of zeroes, as RFC 5869 uses for "no salt". */
export const ZERO_SALT = new Uint8Array(32);

/**
 * A canonical byte string from labelled fields.
 *
 * Every field is length-prefixed, so no two different field lists can produce
 * the same bytes - the classic concatenation ambiguity, where ("ab", "c") and
 * ("a", "bc") hash identically. Anything that is signed or used as associated
 * data is built here.
 *
 * The label names the field for the reader; it is not part of the bytes, and
 * the server's own builder does the same.
 *
 * @param {Array<[string, Uint8Array|string|number]>} fields
 * @returns {Uint8Array}
 */
export function canonical(...fields) {
  const parts = [];
  for (const [label, value] of fields) {
    if (label === undefined || label === null) throw new Error('a canonical field needs a label');
    const bytes = isBytes(value) ? value : utf8(String(value));
    parts.push(u32be(bytes.length), bytes);
  }
  return concatBytes(...parts);
}
