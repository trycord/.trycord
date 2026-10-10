// Permissions, against the schema the instance actually has.
//
// A role carries its permissions as a JSON array in roles.permissions, an owner holds '*'
// through servers.owner_id rather than through a role, and a channel override narrows
// what a role may do in one channel. Channel overrides can only narrow.

const db = require('../db');

const ALL = '*';

// The permission set a user holds in a community, before any channel override.
async function serverPermissions(userId, serverId) {
  const srv = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (!srv) return null;
  if (srv.owner_id === userId) return [ALL];

  const rows = await db.all(
    `SELECT r.permissions FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ?`,
    [serverId, userId]
  );

  const set = new Set();
  for (const row of rows) {
    let list = [];
    try { list = JSON.parse(row.permissions || '[]'); } catch { list = []; }
    if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') set.add(p);
  }
  return [...set];
}

// The set in one channel: narrowing only, so an override cannot grant what the community
// does not already hold.
async function channelPermissions(userId, channelId) {
  const ch = await db.get('SELECT server_id FROM channels WHERE id = ?', [channelId]);
  if (!ch) return null;

  const base = await serverPermissions(userId, ch.server_id);
  if (base === null) return null;
  if (base.includes(ALL)) return base;

  const roles = await db.all(
    `SELECT r.id, r.permissions, r.position FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ?`,
    [ch.server_id, userId]
  );

  const granted = new Set();
  for (const r of roles) {
    let list = [];
    try { list = JSON.parse(r.permissions || '[]'); } catch { list = []; }
    if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') granted.add(p);
  }

  const roleIds = roles.map((r) => r.id);
  if (!roleIds.length) return [];

  const marks = roleIds.map((id) => `'${id}'`).join(',');
  const denied = await db.all(
    `SELECT DISTINCT permission FROM channel_permission_overrides
      WHERE channel_id = ? AND role_id IN (${marks}) AND effect = 'deny'`,
    [channelId]
  );
  const deny = new Set(denied.map((r) => r.permission));

  return [...granted].filter((p) => !deny.has(p));
}

function can(permissions, permission) {
  if (!permissions) return false;
  return permissions.includes(ALL) || permissions.includes(permission);
}

module.exports = { serverPermissions, channelPermissions, can, ALL };
