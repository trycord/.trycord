// Authentication and session management.
//
// A session is a signed JWT carrying the user id and a per-session jti. The jti is what
// makes revocation possible: "sign out everywhere" bumps a version on the user row, and
// a token minted before the bump is stale by comparison rather than by a lookup.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const config = require('../config');
const db = require('../db');
const { now, uuid, opaqueToken } = require('../util');

const BCRYPT_ROUNDS = 12;

const hashPassword = (plain) => bcrypt.hash(String(plain), BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(String(plain), String(hash || ''));

function sign(user, { jti } = {}) {
  const id = jti || uuid();
  const ttlSeconds = config.sessionTtlDays * 24 * 60 * 60;
  const token = jwt.sign(
    { id: user.id, username: user.username, jti: id, sv: Number(user.session_version || 0) },
    config.jwtSecret,
    { expiresIn: ttlSeconds }
  );
  return { token, jti: id, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
}

// The claims off a bearer token, without checking them against the database. Used only
// to copy a live session's identity onto a socket ticket.
function decode(token) {
  return verify(token);
}

function verify(token) {
  try {
    return jwt.verify(String(token), config.jwtSecret);
  } catch {
    return null;
  }
}

// The short-lived, single-use ticket a WebSocket handshake spends. A bearer token never
// belongs in a URL: URLs end up in access logs, proxy logs and Referer headers.
const tickets = new Map();
const TICKET_TTL_MS = 60 * 1000;

function issueTicket(claims) {
  const t = opaqueToken();
  tickets.set(t, { claims, exp: Date.now() + TICKET_TTL_MS });
  if (tickets.size > 2048) {
    const at = Date.now();
    for (const [k, v] of tickets) if (at >= v.exp) tickets.delete(k);
  }
  return t;
}

// Delete before checking, so a spent ticket is gone whether it was valid or not. Anything
// else lets an attacker burn a victim's ticket by guessing it.
function consumeTicket(t) {
  const rec = tickets.get(t);
  if (!rec) return null;
  tickets.delete(t);
  if (Date.now() > rec.exp) return null;
  return rec.claims;
}

function signChallenge(userId, ttlSeconds = 300) {
  return jwt.sign({ sub: userId, purpose: 'mfa' }, config.jwtSecret, { expiresIn: ttlSeconds });
}

function readChallenge(token) {
  const claims = verify(token);
  if (!claims || claims.purpose !== 'mfa' || !claims.sub) return null;
  return claims.sub;
}

// Is this token still good? A token with no sv predates the version column and is judged
// by the timestamps alone, which is the old behaviour.
function tokenStale(claims, row) {
  if (claims && claims.sv !== undefined) {
    return Number(claims.sv) !== Number(row.session_version || 0);
  }
  if (row.password_changed_at && claims && claims.iat) {
    if (new Date(row.password_changed_at).getTime() / 1000 > claims.iat) return true;
  }
  if (row.sessions_invalidated_at && claims && claims.iat) {
    if (new Date(row.sessions_invalidated_at).getTime() / 1000 > claims.iat) return true;
  }
  return false;
}

function enforced(claims, row) {
  if (row.enforcement_state !== 'suspended') return null;
  if (row.enforcement_expires_at && new Date(row.enforcement_expires_at).getTime() < Date.now()) {
    return null;
  }
  return { type: 'SUSPENSION', until: row.enforcement_expires_at || null };
}

async function loadSessionRow(userId, jti) {
  return db.get(
    `SELECT u.id, u.username, u.display_name, u.email, u.email_verified_at,
       u.password_changed_at, u.sessions_invalidated_at, u.enforcement_state,
       u.enforcement_expires_at, u.session_version,
       (SELECT 1 FROM revoked_tokens r WHERE r.jti = ?) AS revoked
     FROM users u WHERE u.id = ?`,
    [jti || '', userId]
  );
}

// Resolve a bearer token to a live session, or null with the reason. The one place the
// HTTP layer and the socket handshake both go through, so they cannot disagree about
// what a valid session is.
async function resolveSession(token) {
  const claims = verify(token);
  if (!claims) return { error: 'AUTH_REQUIRED', message: 'invalid or expired session' };

  const row = await loadSessionRow(claims.id, claims.jti);
  if (!row) return { error: 'NOT_FOUND', message: 'user not found' };
  if (claims.jti && row.revoked) return { error: 'SESSION_REVOKED', message: 'session revoked' };
  if (tokenStale(claims, row)) return { error: 'SESSION_REVOKED', message: 'session revoked' };

  const ef = enforced(claims, row);
  if (ef) {
    return { error: 'ACCOUNT_ENFORCED', message: 'account is subject to a moderation action', status: 403, until: ef.until };
  }

  return {
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email || null,
      emailVerified: !!row.email_verified_at,
      createdAt: row.created_at,
    },
    verified: !!row.email_verified_at,
  };
}

async function register({ username, email, password, displayName, termsVersion, privacyVersion }) {
  const existing = await db.get('SELECT id FROM users WHERE lower(username) = lower(?)', [username]);
  if (existing) throw { code: 'ALREADY_EXISTS', message: 'that username is taken' };

  // The email column carries a unique index, and an address already in use is a refusal
  // the reader can act on rather than a database error they cannot.
  if (email) {
    const taken = await db.get('SELECT id FROM users WHERE lower(email) = lower(?)', [email]);
    if (taken) throw { code: 'ALREADY_EXISTS', message: 'that email is already registered' };
  }

  const id = uuid();
  const at = now();
  await db.run(
    `INSERT INTO users (id, username, display_name, password_hash, email, created_at,
       terms_version, privacy_version, terms_accepted_at, session_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, username, displayName || username, await hashPassword(password), email || null,
      at, termsVersion || null, privacyVersion || null, termsVersion ? at : null]
  );

  const user = { id, username, displayName: displayName || username, email: email || null, createdAt: at };
  return { ...sign(user), user };
}

async function login({ username, password }) {
  const row = await db.get('SELECT * FROM users WHERE lower(username) = lower(?)', [username]);
  // The same error either way, so a wrong username and a wrong password are
  // indistinguishable from the outside.
  const generic = { code: 'INVALID_CREDENTIALS', message: 'username or password is incorrect' };
  if (!row) throw generic;
  if (!(await verifyPassword(password, row.password_hash))) throw generic;

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email || null,
    emailVerified: !!row.email_verified_at,
    totpEnabled: !!row.totp_enabled_at,
    sessionVersion: row.session_version || 0,
  };
}

async function revokeSession(jti) {
  await db.run('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)',
    [jti, new Date(Date.now() + config.sessionTtlDays * 86400000).toISOString()]);
}

async function revokeAllSessions(userId) {
  const at = now();
  await db.run('UPDATE users SET sessions_invalidated_at = ? WHERE id = ?', [at, userId]);
}

async function changePassword(userId, currentPassword, newPassword) {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'user not found' };
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw { code: 'VALIDATION_ERROR', message: 'current password is incorrect' };
  }
  await db.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
    [await hashPassword(newPassword), now(), userId]);
}

async function logout(token) {
  const claims = verify(token);
  if (claims && claims.jti) await revokeSession(claims.jti);
}

// Housekeeping: revocations and reset tokens that can never be used again.
async function purgeExpired() {
  const at = now();
  await db.run('DELETE FROM revoked_tokens WHERE expires_at < ?', [at]);
  await db.run('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL', [at]);
  await db.run('DELETE FROM email_verifications WHERE expires_at < ? OR used_at IS NOT NULL', [at]);
}

module.exports = {
  hashPassword, verifyPassword,
  sign, verify, decode,
  issueTicket, consumeTicket,
  signChallenge, readChallenge,
  tokenStale, enforced,
  resolveSession, loadSessionRow,
  register, login, logout,
  revokeSession, revokeAllSessions, changePassword,
  purgeExpired,
};
