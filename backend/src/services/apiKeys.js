// Developer API keys: the credential a third-party integration uses instead of
// a human session.
//
// A key is a bearer token with a scope set. The secret is shown exactly once,
// when the key is created or rotated, and is stored as a hash: a database read
// must not be enough to impersonate an integration, which is the same reason
// the webhook secret and the bot token are stored the way they are.
//
// A credential is stored as one row per secret generation. Rotating issues a
// new secret and keeps the credential's identity, so the new secret becomes a
// new generation that names the generation it replaced, and the previous
// generation keeps working until the end of the overlap window. That is what
// makes a rotation something an operator can do while an integration is
// running.
//
// The token carries the row id as its handle, so authenticating a request is
// one primary-key lookup. The credential's public identifier (`key_id`) is
// separate and stable: it is what a caller puts in a URL, and it is what
// groups the generations of one credential together.

const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const { normaliseScopes } = require('./developer/scopes');

const TOKEN_PREFIX = 'tc_';
const SECRET_BYTES = 32;
const KEY_ID_BYTES = 12;

// The ceiling a key may ask for. A key that may make ten thousand requests a
// minute is a key that can take the instance down, and the operator of the
// instance is the one who decides how much traffic the instance can carry -
// not the person who wrote the integration.
const MAX_RATE_LIMIT = 6000;
const DEFAULT_RATE_LIMIT = 120;

// How long the previous secret keeps working after a rotation, and the most a
// caller may ask for. Long enough to redeploy an integration, short enough
// that a leaked secret stops being a problem quickly.
const DEFAULT_OVERLAP_SECONDS = 300;
const MAX_OVERLAP_SECONDS = 900;

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function newSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString('base64url');
}

function newKeyId() {
  return 'k_' + crypto.randomBytes(KEY_ID_BYTES).toString('base64url');
}

// The token a caller sends: "tc_<handle>.<secret>". The handle is the row id
// of the generation, so the lookup is indexed and the secret is never
// searched for.
function formatToken(handle, secret) {
  return TOKEN_PREFIX + handle + '.' + secret;
}

// Split a token into its handle and its secret. Returns null for anything
// that is not one of ours, so the caller can fall through to the session
// authentication rather than failing a valid session.
function parseToken(token) {
  const raw = String(token || '');
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const handle = raw.slice(TOKEN_PREFIX.length, dot);
  const secret = raw.slice(dot + 1);
  if (!handle || !secret) return null;
  return { handle, secret };
}

// Constant-time comparison, because a secret guess is still a secret guess.
// The lengths are compared first: timingSafeEqual throws on a mismatch.
function secretMatches(storedHash, secret) {
  const want = Buffer.from(String(storedHash || ''), 'utf8');
  const got = Buffer.from(hashSecret(secret), 'utf8');
  if (want.length !== got.length) return false;
  return crypto.timingSafeEqual(want, got);
}

function readScopes(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A hand-edited row must not crash the list of keys.
    return [];
  }
}

function expired(row, at) {
  if (!row.expires_at) return false;
  const when = new Date(row.expires_at).getTime();
  return Number.isFinite(when) && when <= (at === undefined ? Date.now() : at);
}

function earlierOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

// The public shape of a credential. The secret is never part of it: it exists
// only in the response that creates or rotates the key.
function shape(row) {
  const revoked = !!row.revoked_at;
  return {
    id: row.key_id,
    name: row.name,
    kind: row.kind || 'user',
    status: revoked ? 'revoked' : (expired(row) ? 'expired' : 'active'),
    ownerUserId: row.owner_user_id,
    scopes: readScopes(row.scopes),
    communityId: row.community_id || null,
    botApplicationId: row.bot_application_id || null,
    rateLimitPerMinute: Number(row.rate_limit_per_minute || DEFAULT_RATE_LIMIT),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    revokedReason: row.revoked_reason || null,
    rotatedAt: row.rotated_at || null,
    rotatedFrom: row.rotated_from || null,
    previousSecretExpiresAt: null,
  };
}

// The credential as a whole: its current generation, and when the previous
// secret stops working. The previous generation is a row of its own, so this
// is the newest row that is not superseded.
function credentialFrom(rows) {
  const current = rows.find((r) => r.status === 'active') || rows[0];
  if (!current) return null;
  const shaped = shape(current);
  const previous = rows.find((r) => r.status === 'superseded');
  shaped.previousSecretExpiresAt = previous ? previous.expires_at || null : null;
  return shaped;
}

function clampRateLimit(value) {
  if (value === undefined || value === null) return DEFAULT_RATE_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) bad('rateLimitPerMinute must be a positive number');
  return Math.min(Math.floor(n), MAX_RATE_LIMIT);
}

function clampOverlap(value) {
  if (value === undefined || value === null) return DEFAULT_OVERLAP_SECONDS;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) bad('overlapSeconds must be zero or more');
  return Math.min(Math.floor(n), MAX_OVERLAP_SECONDS);
}

/**
 * Create a credential.
 *
 * The returned secret is the only time it exists in plaintext. It is not
 * stored and cannot be recovered afterwards, which is what makes it rotatable.
 *
 * @param {object} options
 * @param {string} options.ownerUserId
 * @param {string} options.name
 * @param {string[]} [options.scopes]
 * @param {string} [options.expiresAt]  ISO timestamp
 * @param {number} [options.rateLimitPerMinute]
 * @param {string} [options.communityId]
 * @param {string} [options.kind]
 * @param {string} [options.botApplicationId]
 * @param {boolean} [options.withoutSecret] create the credential without a
 *   secret of its own. Used by an application's credential, whose secret is
 *   the application token and lives in the application row.
 * @returns {Promise<{key: object, secret: string|null}>}
 */
async function create({
  ownerUserId, name, scopes, expiresAt, rateLimitPerMinute, communityId, kind, botApplicationId,
  withoutSecret, conn = db,
}) {
  const label = String(name || '').trim();
  if (!label || label.length > 64) bad('name must be 1-64 characters');
  const granted = normaliseScopes(scopes);
  const limit = clampRateLimit(rateLimitPerMinute);
  let expiry = null;
  if (expiresAt) {
    const when = new Date(expiresAt);
    if (Number.isNaN(when.getTime())) bad('expiresAt must be an ISO timestamp');
    expiry = when.toISOString();
  }
  const id = uuid();
  const keyId = newKeyId();
  const secret = withoutSecret ? null : newSecret();
  const ts = now();
  await conn.run(
    'INSERT INTO developer_api_keys'
    + ' (id, key_id, owner_user_id, name, kind, bot_application_id, community_id, scopes,'
    + ' secret_hash, status, rate_limit_per_minute, created_at, expires_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, keyId, ownerUserId, label, kind || 'user', botApplicationId || null, communityId || null,
      JSON.stringify(granted), secret ? hashSecret(secret) : null, 'active', limit, ts, expiry,
    ]
  );
  const row = await conn.get('SELECT * FROM developer_api_keys WHERE id = ?', [id]);
  return { key: shape(row), secret: secret ? formatToken(id, secret) : null };
}

/**
 * The generations of one credential, newest first.
 *
 * @param {string} keyId
 * @returns {Promise<object[]>}
 */
async function generations(keyId) {
  return db.all(
    'SELECT * FROM developer_api_keys WHERE key_id = ? ORDER BY created_at DESC, id DESC',
    [keyId]
  );
}

/**
 * The credentials an owner holds, one entry per credential.
 *
 * @param {string} ownerUserId
 * @returns {Promise<object[]>}
 */
async function list(ownerUserId) {
  const rows = await db.all(
    'SELECT * FROM developer_api_keys WHERE owner_user_id = ? ORDER BY created_at DESC',
    [ownerUserId]
  );
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.key_id)) groups.set(row.key_id, []);
    groups.get(row.key_id).push(row);
  }
  return [...groups.values()].map(credentialFrom);
}

/**
 * One credential, if the owner holds it.
 *
 * @param {string} keyId
 * @param {string} ownerUserId
 * @returns {Promise<object|null>}
 */
async function get(keyId, ownerUserId) {
  const rows = await generations(keyId);
  if (!rows.some((r) => r.owner_user_id === ownerUserId)) return null;
  return credentialFrom(rows.filter((r) => r.owner_user_id === ownerUserId));
}

/**
 * Rotate a credential.
 *
 * The credential keeps its identity: the same key id, the same name, the same
 * scopes, the same limit. The secret changes, and the previous secret keeps
 * working until the end of the overlap window.
 *
 * @param {string} keyId
 * @param {string} ownerUserId
 * @param {object} [options]
 * @param {number} [options.overlapSeconds] 0 ends the previous secret at once
 * @returns {Promise<{key: object, secret: string, previousSecretExpiresAt: string}|null>}
 */
async function rotate(keyId, ownerUserId, { overlapSeconds } = {}) {
  const rows = await generations(keyId);
  const previous = rows.find((r) => r.owner_user_id === ownerUserId && r.status === 'active');
  if (!previous) return null;
  const overlap = clampOverlap(overlapSeconds);
  const ts = now();
  const secret = newSecret();
  const id = uuid();
  const overlapEnd = overlap > 0
    ? new Date(Date.now() + overlap * 1000).toISOString()
    : ts;
  // The previous generation may not outlive the credential itself.
  const previousExpiresAt = earlierOf(overlapEnd, previous.expires_at);

  await db.run(
    'UPDATE developer_api_keys SET status = ?, expires_at = ? WHERE id = ?',
    ['superseded', previousExpiresAt, previous.id]
  );
  await db.run(
    'INSERT INTO developer_api_keys'
    + ' (id, key_id, owner_user_id, name, kind, bot_application_id, community_id, scopes,'
    + ' secret_hash, status, rate_limit_per_minute, created_at, expires_at, rotated_at, rotated_from)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, keyId, previous.owner_user_id, previous.name, previous.kind || 'user',
      previous.bot_application_id || null, previous.community_id || null, previous.scopes,
      hashSecret(secret), 'active', previous.rate_limit_per_minute, ts, previous.expires_at,
      ts, previous.id,
    ]
  );
  const row = await db.get('SELECT * FROM developer_api_keys WHERE id = ?', [id]);
  const shaped = shape(row);
  shaped.previousSecretExpiresAt = previousExpiresAt;
  return {
    key: shaped,
    secret: formatToken(id, secret),
    previousSecretExpiresAt: previousExpiresAt,
  };
}

/**
 * Revoke a credential. Every generation of it stops working at once.
 *
 * @param {string} keyId
 * @param {string} ownerUserId
 * @param {string} [reason]
 * @returns {Promise<object|null>}
 */
async function revoke(keyId, ownerUserId, reason) {
  const rows = await generations(keyId);
  const owned = rows.filter((r) => r.owner_user_id === ownerUserId);
  if (!owned.length) return null;
  const ts = now();
  const note = String(reason || '').trim().slice(0, 255) || null;
  await db.run(
    'UPDATE developer_api_keys SET status = ?, revoked_at = ?, revoked_reason = ? WHERE key_id = ?',
    ['revoked', ts, note, keyId]
  );
  // Read back: the answer describes the key as it is now, not as it was.
  const updated = await generations(keyId);
  return credentialFrom(updated.filter((r) => r.owner_user_id === ownerUserId));
}

/**
 * Resolve a token to the credential generation it belongs to.
 *
 * The states are told apart, because "this key was revoked" and "this key does
 * not exist" are different answers to an integrator and lead to different
 * repairs.
 *
 * @param {string} token
 * @returns {Promise<{row: object}|{error: 'revoked'|'expired'|'unknown'}>}
 */
async function authenticate(token) {
  const parsed = parseToken(token);
  if (!parsed) return { error: 'unknown' };
  const row = await db.get('SELECT * FROM developer_api_keys WHERE id = ?', [parsed.handle]);
  if (!row || !row.secret_hash) return { error: 'unknown' };
  if (!secretMatches(row.secret_hash, parsed.secret)) return { error: 'unknown' };
  if (row.status === 'revoked') return { error: 'revoked' };
  if (row.status === 'superseded') {
    // A previous generation: its secret works until the end of the overlap
    // window and not one moment longer. The credential itself has not
    // expired, so the answer is that the secret is no longer valid.
    if (expired(row)) return { error: 'unknown' };
    return { row };
  }
  if (expired(row)) return { error: 'expired' };
  return { row };
}

/**
 * Record that a credential was used.
 *
 * @param {string} id the row id of the generation that was used
 */
async function touch(id) {
  await db.run('UPDATE developer_api_keys SET last_used_at = ? WHERE id = ?', [now(), id]);
}

module.exports = {
  TOKEN_PREFIX,
  DEFAULT_RATE_LIMIT,
  MAX_RATE_LIMIT,
  DEFAULT_OVERLAP_SECONDS,
  MAX_OVERLAP_SECONDS,
  create, list, get, rotate, revoke, authenticate, touch,
  shape, readScopes, clampRateLimit,
};
