// Channels. The layout of a community, and the access rules on each one.

const db = require('../db');
const { now, uuid } = require('../util');
const servers = require('./servers');

async function list(serverId, viewerId) {
  if (!(await servers.membership(viewerId, serverId))) {
    throw { code: 'NOT_A_MEMBER', message: 'you are not a member of this community' };
  }
  const rows = await db.all(
    `SELECT c.*, cat.name AS category_name
       FROM channels c LEFT JOIN categories cat ON cat.id = c.category_id
      WHERE c.server_id = ? ORDER BY c.position, c.name`,
    [serverId]
  );
  return rows.map(shape);
}

function shape(c) {
  return {
    id: c.id,
    serverId: c.server_id,
    name: c.name,
    slug: c.slug,
    kind: c.type || 'text',
    topic: c.topic || '',
    position: Number(c.position || 0),
    categoryId: c.category_id || null,
    categoryName: c.category_name || null,
    createdAt: c.created_at,
  };
}

// A channel this user may see, with the permissions that come with it. Null when the
// channel does not exist or the user is not a member: the two are deliberately the same
// answer, so a channel id cannot be probed for existence.
async function visible(userId, channelId) {
  const ch = await db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!ch) return null;
  const member = await db.get(
    'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
    [ch.server_id, userId]
  );
  if (!member) return null;
  const permissions = await servers.permissions(userId, ch.server_id);
  return { ...ch, permissions };
}

// Channel-level overrides narrow what a role may do in one channel, and they can only
// narrow: an override cannot grant a permission the community-level set does not hold.
async function effectivePermissions(userId, channelId) {
  const ch = await visible(userId, channelId);
  if (!ch) return null;

  const base = ch.permissions || [];
  if (base.includes('*')) return base;

  const roles = await db.all(
    `SELECT r.id FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ?`,
    [ch.server_id, userId]
  );
  if (!roles.length) return base;

  const roleIds = roles.map((r) => r.id);
  const marks = roleIds.map((id) => `'${id}'`).join(',');

  const grants = await db.all(
    `SELECT DISTINCT permission FROM role_permissions WHERE role_id IN (${marks})`
  );
  const grant = grants.map((r) => r.permission);

  const denials = await db.all(
    `SELECT DISTINCT permission FROM channel_permission_overrides
      WHERE channel_id = ? AND role_id IN (${marks}) AND allowed = 0`
  );
  const deny = new Set(denials.map((r) => r.permission));

  return grant.filter((p) => !deny.has(p));
}

async function create(serverId, viewerId, { name, topic, kind, categoryId }) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_CHANNELS')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot create channels in this community' };
  }
  if (!name || !String(name).trim()) throw { code: 'VALIDATION_ERROR', message: 'a channel needs a name' };

  const id = uuid();
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'channel';
  let unique = base;
  for (let i = 2; await db.get('SELECT id FROM channels WHERE server_id = ? AND slug = ?', [serverId, unique]); i++) {
    unique = `${base}-${i}`;
  }

  const top = await db.get('SELECT COALESCE(MAX(position), 0) AS m FROM channels WHERE server_id = ?', [serverId]);
  await db.run(
    `INSERT INTO channels (id, server_id, name, slug, topic, type, position, category_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, serverId, String(name).trim(), unique, topic || '', kind || 'text',
      (top.m || 0) + 1, categoryId || null]
  );
  return { id, serverId, name: String(name).trim(), slug: unique, topic: topic || '', kind: kind || 'text' };
}

async function update(serverId, channelId, viewerId, patch) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_CHANNELS')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot edit channels in this community' };
  }
  const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
  if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found' };

  const allowed = ['name', 'topic', 'type', 'position', 'category_id'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return { ok: true };

  params.push(channelId);
  await db.run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, params);
  return { ok: true };
}

async function remove(serverId, channelId, viewerId) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_CHANNELS')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot delete channels in this community' };
  }
  const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
  if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found' };
  // Channels are the parent of messages, so the cascade takes the history with it.
  await db.run('DELETE FROM channels WHERE id = ?', [channelId]);
  return { ok: true };
}

async function overrides(channelId, viewerId) {
  const ch = await visible(viewerId, channelId);
  if (!ch) throw { code: 'NOT_A_MEMBER', message: 'channel not found or not a member' };

  const rows = await db.all(
    `SELECT o.role_id, o.permission, o.effect, r.name AS role_name
       FROM channel_permission_overrides o JOIN roles r ON r.id = o.role_id
      WHERE o.channel_id = ? ORDER BY r.position DESC`,
    [channelId]
  );
  return rows.map((r) => ({
    roleId: r.role_id, roleName: r.name, permission: r.permission, effect: r.effect,
  }));
}

// Overrides can only narrow, and only a role the viewer can already manage may be
// narrowed: an override is a delegation of a permission the viewer holds.
async function setOverrides(serverId, channelId, viewerId, patch) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!permissions.can(perms, 'MANAGE_ROLES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot change channel permissions' };
  }
  const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
  if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found' };

  const rows = Array.isArray(patch.overrides) ? patch.overrides : [];
  await db.run('DELETE FROM channel_permission_overrides WHERE channel_id = ?', [channelId]);

  for (const row of rows) {
    if (!row || !row.roleId || !row.permission) continue;
    const role = await db.get('SELECT id FROM roles WHERE id = ? AND server_id = ?', [row.roleId, serverId]);
    if (!role) continue;
    const effect = row.effect === 'deny' ? 'deny' : 'allow';
    await db.run(
      `INSERT OR IGNORE INTO channel_permission_overrides (channel_id, role_id, permission, effect)
       VALUES (?, ?, ?, ?)`,
      [channelId, row.roleId, String(row.permission).slice(0, 64), effect]
    );
  }
  return overrides(channelId, viewerId);
}

module.exports = {
  list, shape, visible, effectivePermissions, create, update, remove, overrides, setOverrides,
};
