// Two-factor authentication: TOTP enrolment, verification, and recovery codes.
//
// The secret is encrypted at rest under a key derived from the instance secret, so a
// database on its own does not contain valid codes for every account in it.

const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { now, uuid } = require('../util');

const STEP_SECONDS = 30;
const DIGITS = 6;

// A secret is stored as v1:<iv-b64>:<tag-b64>:<ciphertext-b64>, so the format can change
// later without a migration that has to guess what an old row means.
function key() {
  return crypto.hkdfSync('sha256', Buffer.from(config.jwtSecret, 'utf8'), Buffer.alloc(0), Buffer.from('trycord:totp'), 32);
}

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(s).toUpperCase().replace(/=+$/, '')) {
    const i = alphabet.indexOf(ch);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out;
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unrecognised TOTP secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

function codeAt(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

// A verifier that accepts one step of skew in each direction, and refuses a step it has
// already seen. Accepting skew alone would make a code replayable for the whole window.
function verifyCode(secretB32, code, usedSteps = []) {
  const entered = String(code || '').replace(/\s/g, '');
  const nowStep = stepAt(Date.now());
  for (const drift of [0, -1, 1]) {
    const step = nowStep + drift;
    if (usedSteps.includes(step)) continue;
    if (codeAt(secretB32, step) === entered) return step;
  }
  return null;
}

function otpauthUri(username, secretB32) {
  const params = new URLSearchParams({
    secret: secretB32, issuer: config.instanceName, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(config.instanceName)}:${encodeURIComponent(username)}?${params}`;
}

async function beginSetup(userId, username) {
  const secret = newSecret();
  await db.run('UPDATE users SET totp_secret = ?, totp_enabled_at = NULL WHERE id = ?', [encryptSecret(secret), userId]);
  return { secret, uri: otpauthUri(username, secret) };
}

async function status(userId) {
  const row = await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', [userId]);
  return { enabled: !!row && !!row.totp_enabled_at };
}

function hashRecovery(raw) {
  return crypto.createHmac('sha256', key()).update(String(raw).toUpperCase()).digest('hex');
}

// One place the set is built, so enabling and re-issuing cannot drift apart in length,
// format, or how the codes are stored.
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

async function enable(userId, code) {
  const row = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userId]);
  if (!row || !row.totp_secret) throw { code: 'VALIDATION_ERROR', message: 'start 2FA setup first' };

  let plain;
  try {
    plain = decryptSecret(row.totp_secret);
  } catch {
    throw { code: 'INTERNAL', message: 'the stored 2FA secret is unreadable' };
  }
  if (verifyCode(plain, code) === null) throw { code: 'VALIDATION_ERROR', message: 'that code is not correct' };

  // Enabling and minting the recovery set in one transaction: a member left enabled with
  // no recovery codes has no way back in if they lose the authenticator.
  const out = await db.transaction(async (t) => {
    await t.run('UPDATE users SET totp_enabled_at = ? WHERE id = ?', [now(), userId]);
    return mintRecoveryCodes(userId, t);
  });

  // Every existing session is dead, so a stolen session cannot turn the factor on and
  // then keep using itself. Bumping the version is what makes a token stale, because
  // tokenStale compares the claim's sv against the column.
  await db.run('UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ?', [userId]);
  await db.run('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now(), userId]);
  return out;
}

async function issueRecoveryCodes(userId) {
  const row = await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', [userId]);
  if (!row || !row.totp_enabled_at) {
    throw { code: 'VALIDATION_ERROR', message: '2FA is not enabled for this account' };
  }
  return mintRecoveryCodes(userId);
}

// Consumes a TOTP code or a recovery code. Recovery codes are single-use.
async function verifySecondFactor(userId, code) {
  const row = await db.get(
    'SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?',
    [userId]
  );
  if (!row || !row.totp_enabled_at) return { ok: false };

  let plain;
  try {
    plain = decryptSecret(row.totp_secret);
  } catch {
    return { ok: false };
  }

  const used = await db.all(
    'SELECT step FROM totp_used_steps WHERE user_id = ? AND step >= ?',
    [userId, stepAt(Date.now()) - 2]
  );
  const usedSteps = used.map((r) => Number(r.step));

  const step = verifyCode(plain, code, usedSteps);
  if (step !== null) {
    await db.run(
      'INSERT OR IGNORE INTO totp_used_steps (user_id, step, used_at) VALUES (?, ?, ?)',
      [userId, step, now()]
    );
    return { ok: true, via: 'totp' };
  }

  const recovery = await db.get(
    'SELECT id FROM totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [userId, hashRecovery(String(code))]
  );
  if (recovery) {
    await db.run('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?', [now(), recovery.id]);
    return { ok: true, via: 'recovery' };
  }

  return { ok: false };
}

async function disable(userId, code) {
  const row = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userId]);
  if (!row || !row.totp_secret) return { ok: true };

  let plain;
  try {
    plain = decryptSecret(row.totp_secret);
  } catch {
    return { ok: true };
  }
  if (verifyCode(plain, code) === null && !(await isValidRecovery(userId, code))) {
    throw { code: 'VALIDATION_ERROR', message: 'that code is not correct' };
  }

  await db.transaction(async (t) => {
    await t.run('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL WHERE id = ?', [userId]);
    await t.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', [userId]);
    await t.run('DELETE FROM totp_used_steps WHERE user_id = ?', [userId]);
  });
  return { ok: true };
}

async function isValidRecovery(userId, code) {
  const row = await db.get(
    'SELECT id FROM totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [userId, hashRecovery(String(code))]
  );
  if (!row) return false;
  await db.run('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?', [now(), row.id]);
  return true;
}

// Every session but the caller's. The caller's jti is not known here, so the caller is
// identified by the request rather than by this module.
async function revokeOtherSessions(userId) {
  await db.run(
    'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [now(), userId]
  );
}

module.exports = {
  beginSetup, status, enable, disable, verifySecondFactor,
  issueRecoveryCodes, mintRecoveryCodes, verifyCode,
  codeAt, base32Decode, base32Encode, newSecret,
};
