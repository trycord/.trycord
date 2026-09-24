// Account recovery + email verification, backed by single-use hashed
// tokens. Raw tokens never touch the database (SHA-256 hashes only) and
// never appear in logs. Every response to anonymous callers is generic so
// neither flow reveals whether an account or email exists.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { now, uuid, sign } = require('../util');
const { checkPassword } = require('./passwords');
const mail = require('./mail');

function ttlMinutes() {
  const n = parseInt(process.env.RESET_TOKEN_TTL_MIN || '60', 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

async function purgeUser(table, userId) {
  await db.run(`DELETE FROM ${table} WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at < ?)`, [userId, now()]);
}

// --- password reset ---

async function requestPasswordReset(email) {
  const normalized = normalizeEmail(email);
  // Generic outcome either way: never reveal account existence.
  const generic = { ok: true };
  if (!normalized) return generic;
  const user = await db.get('SELECT id FROM users WHERE email = ? AND email_verified_at IS NOT NULL', [normalized]);
  if (!user) return generic;
  // One live token at a time: new requests invalidate older ones.
  await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);
  await purgeUser('password_resets', user.id);
  const token = newToken();
  const expires = new Date(Date.now() + ttlMinutes() * 60000).toISOString();
  await db.run(
    'INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [uuid(), user.id, tokenHash(token), expires, null, now()]
  );
  console.log(`[security] password_reset_requested user=${user.id}`);
  try {
    await mail.sendMail({
      to: normalized,
      subject: 'Reset your Trycord password',
      text:
        `Someone requested a password reset for this Trycord account.\n\n` +
        `Reset it here (valid ${ttlMinutes()} minutes, single use):\n` +
        `${mail.publicUrl()}/#/reset-password/${token}\n\n` +
        `If that wasn't you, ignore this email — your password is unchanged.`,
    });
  } catch (e) {
    console.log(`[security] password_reset_email_failed user=${user.id}: ${(e && e.message) || e}`);
  }
  return generic;
}

async function resetPassword(token, newPassword) {
  const pwErr = checkPassword(newPassword);
  if (pwErr) throw { code: 'VALIDATION_ERROR', message: pwErr };
  if (!token) throw { code: 'VALIDATION_ERROR', message: 'reset token required' };
  const row = await db.get('SELECT * FROM password_resets WHERE token_hash = ?', [tokenHash(token)]);
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    throw { code: 'AUTH_REQUIRED', message: 'This reset link is no longer valid. Request a new one.' };
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user) throw { code: 'AUTH_REQUIRED', message: 'This reset link is no longer valid. Request a new one.' };
  const reuse = await bcrypt.compare(String(newPassword), user.password_hash);
  if (reuse) throw { code: 'VALIDATION_ERROR', message: 'new password must be different from the current one' };
  const hash = await bcrypt.hash(String(newPassword), 10);
  const ts = now();
  await db.transaction(async (t) => {
    await t.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [hash, ts, user.id]);
    await t.run('UPDATE password_resets SET used_at = ? WHERE id = ?', [ts, row.id]);
    await t.run('DELETE FROM password_resets WHERE user_id = ? AND id != ?', [user.id, row.id]);
  });
  console.log(`[security] password_reset_completed user=${user.id}`);
  return {
    token: sign({ id: user.id, username: user.username }),
    user: { id: user.id, username: user.username, displayName: user.display_name, createdAt: user.created_at },
  };
}

// --- email verification ---

async function requestVerification(userId, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw { code: 'VALIDATION_ERROR', message: 'enter a valid email address' };
  const taken = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [normalized, userId]);
  if (taken) throw { code: 'CONFLICT', message: 'that email is already in use' };
  await db.run('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [userId]);
  await purgeUser('email_verifications', userId);
  const token = newToken();
  const expires = new Date(Date.now() + 24 * 3600000).toISOString();
  await db.run(
    'INSERT INTO email_verifications (id, user_id, email, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuid(), userId, normalized, tokenHash(token), expires, null, now()]
  );
  try {
    await mail.sendMail({
      to: normalized,
      subject: 'Verify your Trycord email',
      text:
        `Confirm this address for your Trycord account:\n\n` +
        `${mail.publicUrl()}/#/verify-email/${token}\n\n` +
        `The link is valid 24 hours and single use. If that wasn't you, ignore this email.`,
    });
  } catch (e) {
    console.log(`[security] verification_email_failed user=${userId}: ${(e && e.message) || e}`);
  }
  return { ok: true };
}

async function verifyEmail(token) {
  if (!token) throw { code: 'VALIDATION_ERROR', message: 'verification token required' };
  const row = await db.get('SELECT * FROM email_verifications WHERE token_hash = ?', [tokenHash(token)]);
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    throw { code: 'AUTH_REQUIRED', message: 'This verification link is no longer valid. Request a new one.' };
  }
  const ts = now();
  const taken = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [row.email, row.user_id]);
  if (taken) throw { code: 'CONFLICT', message: 'that email is already in use by another account' };
  await db.transaction(async (t) => {
    await t.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [row.email, ts, row.user_id]);
    await t.run('UPDATE email_verifications SET used_at = ? WHERE id = ?', [ts, row.id]);
    await t.run('DELETE FROM email_verifications WHERE user_id = ? AND id != ?', [row.user_id, row.id]);
  });
  console.log(`[security] email_verified user=${row.user_id}`);
  return { ok: true };
}

// Change recovery email: password-confirmed, new address verified first.
// The old address (if any) is only replaced on confirmation.
async function requestEmailChange(userId, currentPassword, newEmail) {
  const normalized = normalizeEmail(newEmail);
  if (!normalized) throw { code: 'VALIDATION_ERROR', message: 'enter a valid email address' };
  if (!currentPassword) throw { code: 'VALIDATION_ERROR', message: 'current password required' };
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw { code: 'NOT_FOUND', message: 'user not found' };
  const ok = await bcrypt.compare(String(currentPassword), user.password_hash);
  if (!ok) throw { code: 'BAD_PASSWORD', message: 'current password is incorrect' };
  if (user.email === normalized) throw { code: 'VALIDATION_ERROR', message: 'that is already your recovery email' };
  return requestVerification(userId, normalized);
}

module.exports = {
  ttlMinutes,
  normalizeEmail,
  requestPasswordReset,
  resetPassword,
  requestVerification,
  verifyEmail,
  requestEmailChange,
};
