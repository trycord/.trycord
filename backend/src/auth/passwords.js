// Centralized password policy. One definition, enforced independently by
// every endpoint that sets a password (register, change, reset).
// Deliberately length-based: long passphrases welcome, no arbitrary
// complexity theater, never truncated, never normalized.
const MIN_LENGTH = 8;
const MAX_LENGTH = 256;

function checkPassword(pw) {
  if (typeof pw !== 'string') return 'password must be a string';
  if (pw.length < MIN_LENGTH) return `password must be ${MIN_LENGTH}+ characters`;
  if (pw.length > MAX_LENGTH) return `password must be ${MAX_LENGTH} characters or fewer`;
  if (!pw.trim()) return 'password cannot be blank';
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
