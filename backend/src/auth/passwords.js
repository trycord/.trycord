// Centralized password policy. One definition, enforced independently by
// every endpoint that sets a password (register, change, reset).
// Deliberately length-based: long passphrases welcome, no arbitrary
// complexity theater, never truncated, never normalized.
//
// The messages are written as the sentences a person reads. They name the
// requirement and, where it exists honestly, a next step - the sender of
// these messages is the last hand the copy passes through.
const MIN_LENGTH = 8;
// bcrypt reads only the first 72 bytes of its input. A policy that accepted more
// would tell a member their 200-character passphrase was the password while in fact
// any string sharing its first 72 bytes opened the account, so the ceiling is
// bcrypt's own, not an arbitrary one. Measured in bytes, not characters: a shorter
// run of multibyte characters can still cross 72.
const MAX_LENGTH = 72;

function checkPassword(pw) {
  if (typeof pw !== 'string') return 'The password is malformed. Type it again and try.';
  if (pw.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters for the password. A long passphrase works well.`;
  if (Buffer.byteLength(pw, 'utf8') > MAX_LENGTH) return `That password is longer than passwords here can be - the ceiling is ${MAX_LENGTH} bytes. Trim it a little and try again.`;
  if (!pw.trim()) return 'The password cannot be blank.';
  return null;
}

// bcrypt work factor. The default is the OWASP minimum for bcrypt; operators on
// slow hardware can lower it via BCRYPT_COST. Raising it does not invalidate
// existing hashes, since the cost is stored inside each hash.
const BCRYPT_COST = Math.min(
  Math.max(parseInt(process.env.BCRYPT_COST || '', 10) || 12, 10),
  15
);

module.exports = { MIN_LENGTH, MAX_LENGTH, BCRYPT_COST, checkPassword };
