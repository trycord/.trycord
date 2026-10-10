// Membership: roles, and the member list.

const db = require('../db');
const { now, uuid } = require('../util');
const servers = require('./servers');

const ALL = '*';

async function list(serverId, viewerId) {
  if (!(await servers.membership(viewerId, serverId))) {
    throw { code: 'NOT_A_MEMBER', message: 'you are not a member of this community' };
  }
  return db.all(
    `SELECT r.id, r.name, r.color, r.position, r.is_hoisted,
       (SELECT COUNT(*) FROM member_roles mr WHERE mr.role_id = r.id) AS member_count
     FROM roles r WHERE r.server_id = ? ORDER BY r.position DESC`,
    [serverId]
  );
}

async function create(serverId, viewerId, { name, color }) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_ROLES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot create roles in this community' };
  }
  const id = uuid();
  const top = await db.get('SELECT COALESCE(MAX(position), 0) AS m FROM roles WHERE server_id = ?', [serverId]);
  await db.run(
    'INSERT INTO roles (id, server_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, serverId, String(name || 'role').slice(0, 64), color || null, (top.m || 0) + 1, now()]
  );
  return { id, name: name || 'role', color: color || null, position: (top.m || 0) + 1 };
}

async function update(serverId, roleId, viewerId, patch) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_ROLES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot edit roles in this community' };
  }
  const role = await db.get('SELECT * FROM roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
  if (!role) throw { code: 'NOT_FOUND', message: 'role not found' };

  const allowed = ['name', 'color', 'position', 'is_hoisted'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    params.push(patch[key]);
  }
  if (sets.length) {
    params.push(roleId);
    await db.run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  if (Array.isArray(patch.permissions)) {
    const clean = patch.permissions.filter((p) => typeof p === 'string' && p).map((p) => p.slice(0, 64));
    await db.run('UPDATE roles SET permissions = ? WHERE id = ?', [JSON.stringify(clean), roleId]);
  }
  return { ok: true };
}

async function remove(serverId, roleId, viewerId) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_ROLES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot delete roles in this community' };
  }
  await db.run('DELETE FROM roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
  return { ok: true };
}

// A role can only be assigned by someone whose own top role sits above it, so a member
// with MANAGE_ROLES cannot mint themselves the owner's powers.
async function assignable(serverId, viewerId, roleId) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_ROLES')) return false;
  if (perms.includes(ALL)) return true;

  const role = await db.get('SELECT position FROM roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
  if (!role) return false;

  const mine = await db.get(
    `SELECT COALESCE(MAX(r.position), -1) AS top
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ?`,
    [serverId, viewerId]
  );
  return Number(mine.top) > Number(role.position);
}

async function assign(serverId, roleId, userId, viewerId) {
  if (!(await assignable(serverId, viewerId, roleId))) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot assign that role' };
  }
  const member = await db.get('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  if (!member) throw { code: 'NOT_FOUND', message: 'that person is not a member of this community' };

  await db.run(
    'INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)',
    [serverId, userId, roleId]
  );
  return { ok: true };
}

async function unassign(serverId, roleId, userId, viewerId) {
  if (!(await assignable(serverId, viewerId, roleId))) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot remove that role' };
  }
  await db.run(
    'DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?',
    [serverId, userId, roleId]
  );
  return { ok: true };
}

async function rolesOf(serverId, userId) {
  const rows = await db.all(
    `SELECT r.id, r.name, r.color, r.position
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ? ORDER BY r.position DESC`,
    [serverId, userId]
  );
  return rows;
}

async function permissionsOf(serverId, userId) {
  const member = await servers.membership(userId, serverId);
  if (!member) return null;
  if (member.isOwner) return [ALL];
  return permissionsOf(serverId, userId);
}

module.exports = {
  list, create, update, remove, assign, unassign, assignable, rolesOf, permissionsOf, ALL,
};
