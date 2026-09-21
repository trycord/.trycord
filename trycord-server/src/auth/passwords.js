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

module.exports = { MIN_LENGTH, MAX_LENGTH, checkPassword };
