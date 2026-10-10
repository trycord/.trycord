// Webhooks: an external service posting into a channel.
//
// A webhook is a URL plus a shared secret. The secret is stored hashed so a database on
// its own cannot replay into a channel, shown exactly once at creation, and rotatable -
// the same three rules a recovery code follows.

const db = require('../db');
const { now, uuid, opaqueToken } = require('../util');
const permissions = require('./permissions');

// The webhooks table has no events column: a webhook delivers what happens in the
// channel it is bound to, and filtering by event type is a caller-side concern.
async function list(serverId, viewerId) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!permissions.can(perms, 'MANAGE_SERVER')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot see this community\'s webhooks' };
  }
  const rows = await db.all(
    `SELECT id, channel_id, name, url, active, use_count, last_used_at, created_at
       FROM webhooks WHERE server_id = ? ORDER BY created_at DESC`,
    [serverId]
  );
  return { webhooks: rows.map(shape) };
}

function shape(r) {
  return {
    id: r.id,
    channelId: r.channel_id || null,
    name: r.name,
    url: r.url,
    active: !!r.active,
    useCount: Number(r.use_count || 0),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    // Deliberately absent: the secret is never returned after creation.
  };
}

async function create(serverId, viewerId, { channelId, name, url }) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!permissions.can(perms, 'MANAGE_SERVER')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot create webhooks for this community' };
  }

  // A webhook posts into a channel of this community and nowhere else.
  let boundChannel = null;
  if (channelId) {
    const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
    if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found in this community' };
    boundChannel = ch.id;
  }

  if (!url || !/^https?:\/\//i.test(String(url))) {
    throw { code: 'VALIDATION_ERROR', message: 'a webhook needs an http(s) url' };
  }
  if (!name || !String(name).trim()) {
    throw { code: 'VALIDATION_ERROR', message: 'a webhook needs a name' };
  }

  const id = uuid();
  const secret = opaqueToken();
  await db.run(
    `INSERT INTO webhooks (id, server_id, channel_id, direction, name, url, secret_hash, created_by, active, use_count, created_at)
     VALUES (?, ?, ?, 'outgoing', ?, ?, ?, ?, 1, 0, ?)`,
    [id, serverId, boundChannel, String(name).slice(0, 64), String(url).slice(0, 512),
      hashSecret(secret), viewerId, now()]
  );

  const row = await db.get('SELECT * FROM webhooks WHERE id = ?', [id]);
  // The only time the secret is ever returned.
  return { webhook: { ...shape(row), secret } };
}

function hashSecret(secret) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', require('../config').jwtSecret).update(String(secret)).digest('hex');
}

async function update(serverId, webhookId, viewerId, patch) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!permissions.can(perms, 'MANAGE_SERVER')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot edit this community\'s webhooks' };
  }
  const hook = await db.get('SELECT id FROM webhooks WHERE id = ? AND server_id = ?', [webhookId, serverId]);
  if (!hook) throw { code: 'NOT_FOUND', message: 'webhook not found' };

  const allowed = ['name', 'url', 'active', 'channel_id'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    params.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : String(patch[key]).slice(0, 512));
  }
  if (!sets.length) return { ok: true };

  params.push(webhookId);
  await db.run(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`, params);
  return { ok: true };
}

// A rotated secret is a new secret: the old one stops verifying, and the caller is shown
// the new one once.
async function rotateSecret(serverId, webhookId, viewerId) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!permissions.can(perms, 'MANAGE_SERVER')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot rotate this community\'s webhook secrets' };
  }
  const hook = await db.get('SELECT id FROM webhooks WHERE id = ? AND server_id = ?', [webhookId, serverId]);
  if (!hook) throw { code: 'NOT_FOUND', message: 'webhook not found' };

  const secret = opaqueToken();
  await db.run('UPDATE webhooks SET secret_hash = ? WHERE id = ?', [hashSecret(secret), webhookId]);
  return { webhook: { id: webhookId, secret } };
}

async function remove(serverId, webhookId, viewerId) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!permissions.can(perms, 'MANAGE_SERVER')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot remove this community\'s webhooks' };
  }
  await db.run('DELETE FROM webhooks WHERE id = ? AND server_id = ?', [webhookId, serverId]);
  return { ok: true };
}

// The delivery log. Status and status code are what an operator needs when a webhook
// silently stops working, so both are recorded rather than inferred.
async function deliveries(serverId, webhookId, viewerId, { limit = 50 } = {}) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!permissions.can(perms, 'MANAGE_SERVER')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot see this community\'s delivery logs' };
  }
  const rows = await db.all(
    `SELECT d.id, d.event_type, d.status, d.status_code, d.error, d.created_at
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE w.server_id = ? AND d.webhook_id = ?
      ORDER BY d.created_at DESC LIMIT ?`,
    [serverId, webhookId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
  );
  return { deliveries: rows.map((r) => ({
    id: r.id,
    event: r.event_type,
    status: r.status,
    statusCode: r.status_code,
    error: r.error || '',
    createdAt: r.created_at,
  })) };
}

module.exports = { list, create, update, rotateSecret, remove, deliveries, shape, hashSecret };
