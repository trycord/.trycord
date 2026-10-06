// TOTP (RFC 6238) and login throttling.
//
// Implemented against node:crypto rather than pulling in an OTP library: the
// algorithm is a fixed, small amount of HMAC arithmetic, and a self-hosted
// instance should not need a dependency tree to let a member protect an
// account with a second factor. The same reasoning as the S3 driver.
//
// The secret is encrypted at rest with AES-256-GCM under a key derived from
// JWT_SECRET. A stolen database backup must not hand over the ability to mint
// valid codes for every account in it, so the secret is not stored the way the
// password hash is: bcrypt would be wrong (it is not reversible and TOTP
// verification needs the original), and plaintext would make the database a
// 2FA bypass.
//
// Verification accepts a small window of adjacent steps. That is not
// convenience for its own sake: authenticator apps show a code once, and a
// user who starts typing near a step boundary would otherwise be rejected for
// a code that was correct seconds earlier. The window is still narrow, and
// codes cannot be replayed because the step consumed is recorded.
const crypto = require('crypto');
const db = require('../db');
const { now, uuid, secret } = require('../util');

const STEP_SECONDS = 30;
const DIGITS = 6;
const SKEW_STEPS = 1;
// One time pad, so a code captured in transit cannot be replayed.
const MAX_USED_DRIFT = 10;

// 5 failures locks the account for 15 minutes. Enough to make guessing
// impractical, short enough that a locked-out member is not waiting on an admin.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function key() {
  return crypto.hkdfSync('sha256', Buffer.from(secret(), 'utf8'), Buffer.alloc(0), Buffer.from('trycord:totp'), 32);
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function decryptSecret(stored) {
  const parts = String(stored || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unrecognised TOTP secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

function codeAt(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

function stepFor(at) {
  return Math.floor((at === undefined ? Date.now() : at) / 1000 / STEP_SECONDS);
}

// Returns the matched step, or null. The caller records the step so the same
// code cannot be used twice.
function verifyCode(secretB32, code, usedSteps) {
  const candidate = String(code || '').replace(/\D/g, '');
  if (candidate.length !== DIGITS) return null;
  const used = usedSteps || new Set();
  const current = stepFor();
  for (let d = -SKEW_STEPS; d <= SKEW_STEPS; d++) {
    const step = current + d;
    if (used.has(step)) continue;
    // Constant-time compare: a timing side channel on the last digits is a
    // real leak, and there is no cost to avoiding it here.
    const expected = Buffer.from(codeAt(secretB32, step));
    const got = Buffer.from(candidate);
    if (expected.length === got.length && crypto.timingSafeEqual(expected, got)) return step;
  }
  return null;
}

function otpauthUri(username, secretB32) {
  const label = encodeURIComponent(`Trycord:${username}`);
  const params = new URLSearchParams({ secret: secretB32, issuer: 'Trycord', algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// --- account state --------------------------------------------------------

async function status(userId) {
  const row = await db.get(
    'SELECT totp_enabled_at, login_fail_count, login_locked_until FROM users WHERE id = ?',
    [userId]
  );
  return {
    enabled: !!(row && row.totp_enabled_at),
    pendingFailures: row ? Number(row.login_fail_count || 0) : 0,
    lockedUntil: row && row.login_locked_until && new Date(row.login_locked_until).getTime() > Date.now()
      ? row.login_locked_until : null,
  };
}

function isLocked(row) {
  return !!(row && row.login_locked_until && new Date(row.login_locked_until).getTime() > Date.now());
}

// Called on every failed password check. Returns true if this failure caused a
// lockout, so the caller can log it.
async function recordFailure(userId) {
  const row = await db.get('SELECT login_fail_count FROM users WHERE id = ?', [userId]);
  const count = Number((row && row.login_fail_count) || 0) + 1;
  const locked = count >= MAX_FAILURES;
  await db.run(
    'UPDATE users SET login_fail_count = ?, login_locked_until = ? WHERE id = ?',
    [count, locked ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null, userId]
  );
  return locked;
}

async function recordSuccess(userId) {
  // Reset on success only. Resetting on every attempt would let an attacker
  // interleave a guess with the real password to keep the counter at zero.
  await db.run(
    'UPDATE users SET login_fail_count = 0, login_locked_until = NULL WHERE id = ?',
    [userId]
  );
}

async function remainingLockMs(userId) {
  const row = await db.get('SELECT login_locked_until FROM users WHERE id = ?', [userId]);
  if (!isLocked(row)) return 0;
  return new Date(row.login_locked_until).getTime() - Date.now();
}

// --- enable / disable -----------------------------------------------------

// Setup does not enable anything: it returns a secret the member scans, and
// nothing is stored until they prove the code works. Storing an unverified
// secret would let a support agent enable 2FA onto an account they cannot use.
async function beginSetup(userId, username) {
  const pending = generateSecret();
  await db.run('UPDATE users SET totp_secret = ?, totp_enabled_at = NULL WHERE id = ?', [encryptSecret(pending), userId]);
  return { secret: pending, uri: otpauthUri(username, pending) };
}

async function enable(userId, code) {
  const row = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userId]);
  if (!row || !row.totp_secret) throw { code: 'VALIDATION_ERROR', message: 'start 2FA setup first' };
  let plain;
  try { plain = decryptSecret(row.totp_secret); } catch { throw { code: 'INTERNAL', message: 'stored 2FA secret is unreadable' }; }
  if (verifyCode(plain, code) === null) {
    throw { code: 'VALIDATION_ERROR', message: 'that code is not correct' };
  }
  // Enable and mint the recovery set in one transaction: a member who ends up
  // enabled with no recovery codes has no way back in if they lose the
  // authenticator.
  const out = await db.transaction(async (t) => {
    await t.run('UPDATE users SET totp_enabled_at = ? WHERE id = ?', [now(), userId]);
    return mintRecoveryCodes(userId, t);
  });
  // Returned once, never again: only the hashes are kept.
  return out;
}

function hashRecovery(raw) {
  return crypto.createHmac('sha256', key()).update(String(raw).toUpperCase()).digest('hex');
}

// Replaces the whole recovery set. Used when a member loses their codes but
// still has their authenticator: a fresh set is minted without touching the
// TOTP secret, because that is the credential they still hold.
async function issueRecoveryCodes(userId) {
  const row = await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', [userId]);
  if (!row || !row.totp_enabled_at) {
    throw { code: 'VALIDATION_ERROR', message: '2FA is not enabled for this account' };
  }
  return mintRecoveryCodes(userId);
}

// Single place the set is built, so enable() and re-issue cannot drift apart in
// length, format, or how the codes are stored.
async function mintRecoveryCodes(userId, conn) {
  const exec = conn || db;
  const codes = Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-');
    return { raw, hash: hashRecovery(raw) };
  });
  await exec.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', [userId]);
  for (const c of codes) {
    await exec.run(
      'INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
      [uuid(), userId, c.hash, now()]
    );
  }
  return { recoveryCodes: codes.map((c) => c.raw) };
}

async function disable(userId, code) {
  const row = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userId]);
  if (!row || !row.totp_secret) return;
  const plain = decryptSecret(row.totp_secret);
  if (verifyCode(plain, code) === null) {
    throw { code: 'VALIDATION_ERROR', message: 'that code is not correct' };
  }
  await db.transaction(async (t) => {
    await t.run('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL WHERE id = ?', [userId]);
    await t.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', [userId]);
  });
}

// --- challenge verification ----------------------------------------------

// Consumes a code or a recovery code. Returns true if the second factor was
// satisfied, and always consumes whatever it accepted.
async function verifySecondFactor(userId, code) {
  const row = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userId]);
  if (!row || !row.totp_secret) return { ok: false, reason: 'not configured' };

  const raw = String(code || '').trim();
  const recovery = await db.get(
    'SELECT id FROM totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [userId, hashRecovery(raw)]
  );
  if (recovery) {
    await db.run('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?', [now(), recovery.id]);
    return { ok: true, via: 'recovery' };
  }

  const plain = decryptSecret(row.totp_secret);
  const recent = await db.all(
    'SELECT step FROM totp_used_steps WHERE user_id = ? AND used_at > ?',
    [userId, new Date(Date.now() - MAX_USED_DRIFT * STEP_SECONDS * 1000).toISOString()]
  );
  const used = new Set(recent.map((r) => Number(r.step)));
  const step = verifyCode(plain, raw, used);
  if (step === null) return { ok: false, reason: 'invalid' };
  await db.run(
    'INSERT INTO totp_used_steps (id, user_id, step, used_at) VALUES (?, ?, ?, ?)',
    [uuid(), userId, step, now()]
  );
  return { ok: true, via: 'totp' };
}

module.exports = {
  DIGITS, STEP_SECONDS, MAX_FAILURES, LOCKOUT_MS,
  beginSetup, enable, disable, verifySecondFactor, status, issueRecoveryCodes,
  recordFailure, recordSuccess, remainingLockMs, isLocked,
  // exported for tests
  base32Encode, base32Decode, codeAt, stepFor, verifyCode, encryptSecret, decryptSecret, otpauthUri,
};
