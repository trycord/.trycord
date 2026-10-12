// Secret values kept in the database, encrypted at rest.
//
// A mail provider's API key is a credential that can send mail as this instance
// to anyone. Storing it in plaintext would mean a database backup, or read
// access to one table, hands over the ability to send mail impersonating the
// instance. So it is encrypted before it is written, the same way a TOTP secret
// is, under a key derived from JWT_SECRET.
//
// AES-256-GCM rather than a plain cipher because it authenticates as well as
// encrypts: a row edited in the database fails to decrypt instead of yielding
// whatever the editor chose. The version prefix is what lets the scheme change
// later without guessing which rows are readable.
//
// The key is derived per purpose so a value encrypted for one use cannot be
// decrypted in another: reusing a raw JWT_SECRET across purposes would mean a
// single derived key protects every secret in the installation.
const crypto = require('crypto');

// clock, not util: util's module scope reaches the settings store, and this
// module is reached from the settings store, so importing util here closed a
// cycle through module scope.
const { secret } = require('../clock');

// Derived rather than used directly, because JWT_SECRET is written down in
// .env and a container orchestrator will pass it to more than one process.
function keyFor(purpose) {
  return crypto.hkdfSync('sha256', Buffer.from(secret(), 'utf8'), Buffer.alloc(32), Buffer.from('trycord:' + purpose, 'utf8'), 32);
}

function encrypt(purpose, plain) {
  const key = keyFor(purpose);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()]);
  return 'v1.' + iv.toString('base64url') + '.' + cipher.getAuthTag().toString('base64url') + '.' + enc.toString('base64url');
}

function decrypt(purpose, stored) {
  const parts = String(stored || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unrecognised secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

// Whether a stored value can still be read. An installation whose JWT_SECRET was
// rotated cannot decrypt what it wrote under the old one, and that has to be
// reportable rather than showing up as an unexplained delivery failure.
function readable(purpose, stored) {
  if (!stored) return false;
  try { decrypt(purpose, stored); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, readable };
