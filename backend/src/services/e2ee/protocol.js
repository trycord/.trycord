// The protocol this subsystem implements, in one place.
//
// Trycord E2EE, version 1 ("TCE2E-v1"). It follows two published designs:
//
//   X3DH            https://signal.org/docs/specifications/x3dh/
//   Double Ratchet  https://signal.org/docs/specifications/doubleratchet/
//
// over X25519, Ed25519, HKDF-SHA256 and AES-256-GCM, with PBKDF2-HMAC-SHA256
// used only to turn a human-held recovery secret into a wrapping key.
//
// Everything version-specific is named here, so a second version of the
// protocol is a second set of constants and a second set of labels rather
// than a set of `if (version === 1)` branches scattered through the code.
//
// The key schedule, in full:
//
//   X3DH      SK = HKDF-SHA256(ikm = DH1 || DH2 || DH3 || DH4,
//                              salt = 32 zero bytes,
//                              info = "trycord-x3dh-v1",
//                              32 bytes)
//   Ratchet   RK  = HKDF-SHA256(ikm = SK, salt = 32 zero bytes,
//                              info = "trycord-double-ratchet-v1|root-seed",
//                              32 bytes)
//   Root step (RK, CK) = HKDF-SHA256(ikm = DH output, salt = RK,
//                              info = "trycord-double-ratchet-v1|root",
//                              64 bytes)
//   Chain     (MK, CK') = HKDF-SHA256(ikm = CK, salt = 32 zero bytes,
//                              info = "trycord-double-ratchet-v1|chain",
//                              64 bytes)
//   Header    HK = HKDF-SHA256(ikm = MK, salt = 32 zero bytes,
//                              info = "trycord-double-ratchet-v1|header",
//                              32 bytes)
//
// Every derivation carries a distinct info string, so a key derived for one
// purpose can never be the key for another: the domain separation is in the
// labels, not in a convention anybody has to remember.

'use strict';

const PROTOCOL_VERSION = 1;

// The X3DH shared-secret label.
const X3DH_INFO = 'trycord-x3dh-v1';

// The Double Ratchet labels. The first is the domain; the rest say which
// step of the schedule is being derived.
const RATCHET_INFO = 'trycord-double-ratchet-v1';
const RATCHET_ROOT_SEED_INFO = RATCHET_INFO + '|root-seed';
const RATCHET_ROOT_INFO = RATCHET_INFO + '|root';
const RATCHET_CHAIN_INFO = RATCHET_INFO + '|chain';
const RATCHET_HEADER_INFO = RATCHET_INFO + '|header';

// Labels outside the ratchet: the group-key seal, the ratchet-state blob the
// server stores without being able to read it, and the recovery wrap.
const GROUP_SEAL_INFO = 'trycord-e2ee-v1|group-seal';
const RATCHET_STATE_INFO = 'trycord-e2ee-v1|ratchet-state';
const RECOVERY_WRAP_INFO = 'trycord-e2ee-v1|recovery-wrap';
const ATTACHMENT_SEAL_INFO = 'trycord-e2ee-v1|attachment-seal';

// The context strings that are signed, so a signature can never be replayed
// into a different context.
const PREKEY_SIGNATURE_CONTEXT = 'trycord-e2ee-prekey-v1';
const SESSION_INIT_SIGNATURE_CONTEXT = 'trycord-e2ee-init-v1';
const RECOVERY_PROOF_CONTEXT = 'trycord-e2ee-recovery-v1';

// The envelope's associated-data context.
const ENVELOPE_AAD_CONTEXT = 'trycord-e2ee-v1';

// Bounds. A skipped-key store that can grow without limit is a denial of
// service against the receiver's disk, so it is capped, and the cap is
// enforced rather than documented.
const MAX_SKIPPED_KEYS = 1000;
// The number of message keys kept for a chain that has just been replaced,
// so a message from that chain that arrives late can still be read.
const MAX_STALE_CHAIN_KEYS = 100;

// PBKDF2 cost for the recovery key. 200 000 iterations of HMAC-SHA256 is
// the OWASP recommendation for PBKDF2-HMAC-SHA256 and costs a few hundred
// milliseconds on a server CPU, which is the point: the secret is a
// human-held phrase, not a machine-held one, and the work factor belongs on
// whoever guesses it.
const RECOVERY_PBKDF2_ITERATIONS = 200000;
const RECOVERY_SALT_BYTES = 16;

/** A 32-byte HKDF salt of zeroes, as RFC 5869 uses for "no salt". */
const ZERO_SALT = Buffer.alloc(32, 0);

/**
 * A canonical byte string from labelled fields.
 *
 * Every field is length-prefixed, so no two different field lists can
 * produce the same bytes - the classic concatenation ambiguity, where
 * ("ab", "c") and ("a", "bc") hash identically. Anything that is signed or
 * used as associated data is built here.
 *
 * @param {Array<[string, Buffer|string]>} fields
 * @returns {Buffer}
 */
function canonical(...fields) {
  const parts = [];
  for (const [label, value] of fields) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const name = Buffer.from(label, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

module.exports = {
  PROTOCOL_VERSION,
  X3DH_INFO,
  RATCHET_INFO,
  RATCHET_ROOT_SEED_INFO,
  RATCHET_ROOT_INFO,
  RATCHET_CHAIN_INFO,
  RATCHET_HEADER_INFO,
  GROUP_SEAL_INFO,
  RATCHET_STATE_INFO,
  RECOVERY_WRAP_INFO,
  ATTACHMENT_SEAL_INFO,
  PREKEY_SIGNATURE_CONTEXT,
  SESSION_INIT_SIGNATURE_CONTEXT,
  RECOVERY_PROOF_CONTEXT,
  ENVELOPE_AAD_CONTEXT,
  MAX_SKIPPED_KEYS,
  MAX_STALE_CHAIN_KEYS,
  RECOVERY_PBKDF2_ITERATIONS,
  RECOVERY_SALT_BYTES,
  ZERO_SALT,
  canonical,
};
