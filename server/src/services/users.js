// Users and profiles.

const db = require('../db');
const { hashColor } = require('../util');

async function me(userId) {
  const row = await db.get(
    `SELECT id, username, display_name, email, email_verified_at, created_at,
       avatar_url, banner_url, bio, status_text, is_bot
     FROM users WHERE id = ?`,
    [userId]
  );
  if (!row) return null;
  return shape(row, await extraFor(userId));
}

// The facts only an account's own view of itself carries. isAdmin is what the console
// checks before it will open, and it is server-computed rather than a client-side flag.
// verificationRequired tells the reader whether this instance can enforce verification at
// all, so a self-hoster with no mail relay is never asked to confirm an address they have
// no way of confirming.
async function extraFor(userId) {
  const admin = await db.get('SELECT 1 FROM admins WHERE user_id = ?', [userId]);
  return {
    isAdmin: !!admin,
    verificationRequired: require('../config').verificationEnforceable(),
  };
}

function shape(row, extra) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email || null,
    emailVerified: !!row.email_verified_at,
    avatarUrl: row.avatar_url || null,
    bannerUrl: row.banner_url || null,
    bio: row.bio || '',
    // statusText is the name the context panel reads, so a profile card shows the status
    // a person set for themselves.
    statusText: row.status_text || '',
    isBot: !!row.is_bot,
    createdAt: row.created_at,
    ...(extra || {}),
  };
}

async function publicProfile(userId) {
  const row = await db.get(
    `SELECT id, username, display_name, created_at, avatar_url, banner_url, bio, status_text
     FROM users WHERE id = ?`,
    [userId]
  );
  return row ? shape(row) : null;
}

async function update(userId, patch) {
  const allowed = ['display_name', 'bio', 'status_text'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    params.push(patch[key] == null ? null : String(patch[key]).slice(0, 2000));
  }
  if (!sets.length) return me(userId);

  params.push(userId);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return me(userId);
}

async function changeEmail(userId, newEmail, currentPassword) {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'user not found' };
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw { code: 'VALIDATION_ERROR', message: 'current password is incorrect' };
  }
  const taken = await db.get(
    'SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?',
    [newEmail, userId]
  );
  if (taken) throw { code: 'ALREADY_EXISTS', message: 'that email is already in use' };

  // The address is stored but not verified: verification is a separate, deliberate step
  // against a token sent to the new address.
  await db.run('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?', [newEmail, userId]);
  return me(userId);
}

async function search(query, limit = 20) {
  const q = `%${String(query || '').slice(0, 64)}%`;
  const rows = await db.all(
    `SELECT id, username, display_name, created_at, avatar_url
     FROM users
      WHERE username LIKE ? OR display_name LIKE ?
      ORDER BY username LIMIT ?`,
    [q, q, Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)]
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url || null,
    createdAt: r.created_at,
  }));
}

async function touch(userId) {
  await db.run(
    `UPDATE user_sessions SET last_seen_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    [require('../util').now(), userId]
  );
}

// A deterministic colour so the same person is always the same tone when they have no
// avatar. The initial behind it is what makes the mark recognisable.
function markFor(name) {
  return { background: hashColor(name) };
}

module.exports = {
  me, publicProfile, update, search, changeEmail, touch, markFor, shape,
};
