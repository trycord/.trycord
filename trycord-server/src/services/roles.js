// Role lifecycle: defaults, CRUD, assignment. All permission changes flow through here.
const db = require('../db');
const { uuid } = require('../util');
const { PERMISSIONS, isKnown } = require('./permissions');

const ALL = Object.keys(PERMISSIONS);

const DEFAULT_ROLES = [
  { name: 'Admin', position: 3, permissions: ALL, is_default: 0 },
  { name: 'Moderator', position: 2, permissions: ['KICK_MEMBERS', 'MANAGE_MESSAGES', 'MANAGE_INVITES', 'SEND_MESSAGES'], is_default: 0 },
  { name: 'Member', position: 1, permissions: ['SEND_MESSAGES'], is_default: 1 },
];

function parseRow(r) {
  if (!r) return null;
  let permissions = [];
  try { permissions = JSON.parse(r.permissions); } catch { /* keep empty */ }
  return { ...r, permissions, is_default: !!r.is_default };
}

async function createDefaults(serverId, conn = db) {
  for (const d of DEFAULT_ROLES) {
    await conn.run(
      'INSERT INTO roles (id, server_id, name, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), serverId, d.name, d.position, JSON.stringify(d.permissions), d.is_default]
    );
  }
}

async function list(serverId) {
  const rows = await db.all('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, name ASC', [serverId]);
  return rows.map(parseRow);
}

async function get(roleId) {
  return parseRow(await db.get('SELECT * FROM roles WHERE id = ?', [roleId]));
}

async function defaultRole(serverId) {
  return parseRow(await db.get('SELECT * FROM roles WHERE server_id = ? AND is_default = 1', [serverId]));
}

async function byName(serverId, name) {
  return parseRow(await db.get('SELECT * FROM roles WHERE server_id = ? AND name = ?', [serverId, name]));
}

function isUniqueViolation(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

async function create(serverId, { name, permissions }) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'role name required' };
  const perms = Array.isArray(permissions) ? permissions.filter(isKnown) : [];
  // New custom roles start at the bottom of the hierarchy.
  const posRow = await db.get('SELECT COALESCE(MIN(position), 1) - 1 AS p FROM roles WHERE server_id = ?', [serverId]);
  try {
    const id = uuid();
    await db.run(
      'INSERT INTO roles (id, server_id, name, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, 0)',
      [id, serverId, clean, posRow.p, JSON.stringify(perms)]
    );
    return get(id);
  } catch (e) {
    if (isUniqueViolation(e)) throw { code: 'CONFLICT', message: 'a role with that name exists' };
    throw e;
  }
}

async function update(role, { name, permissions }) {
  const sets = [];
  const vals = [];
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, 32);
    if (!clean) throw { code: 'VALIDATION_ERROR', message: 'role name cannot be empty' };
    sets.push('name = ?');
    vals.push(clean);
  }
  if (permissions !== undefined) {
    if (!Array.isArray(permissions)) throw { code: 'VALIDATION_ERROR', message: 'permissions must be an array' };
    sets.push('permissions = ?');
    vals.push(JSON.stringify(permissions.filter(isKnown)));
  }
  if (!sets.length) throw { code: 'VALIDATION_ERROR', message: 'nothing to update' };
  vals.push(role.id);
  try {
    await db.run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, vals);
  } catch (e) {
    if (isUniqueViolation(e)) throw { code: 'CONFLICT', message: 'a role with that name exists' };
    throw e;
  }
  return get(role.id);
}

async function remove(role) {
  if (role.is_default) throw { code: 'VALIDATION_ERROR', message: 'the default role cannot be deleted' };
  const n = await db.get('SELECT COUNT(*) AS n FROM member_roles WHERE role_id = ?', [role.id]);
  if (n.n > 0) throw { code: 'ROLE_IN_USE', message: `role is assigned to ${n.n} member(s)` };
  await db.run('DELETE FROM roles WHERE id = ?', [role.id]);
  return { ok: true };
}

async function userRoles(userId, serverId, conn = db) {
  const rows = await conn.all(
    `SELECT r.* FROM member_roles mr JOIN roles r ON r.id = mr.role_id
     WHERE mr.server_id = ? AND mr.user_id = ? ORDER BY r.position DESC`,
    [serverId, userId]
  );
  return rows.map(parseRow);
}

async function assign(serverId, userId, roleId, conn = db) {
  const ignore = (conn.dialect || db.dialect) === 'mysql' ? 'IGNORE' : 'OR IGNORE';
  await conn.run(
    `INSERT ${ignore} INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`,
    [serverId, userId, roleId]
  );
  return { ok: true };
}

async function unassign(serverId, userId, roleId, conn = db) {
  await conn.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?', [serverId, userId, roleId]);
  return { ok: true };
}

async function ensureDefault(serverId, userId, conn = db) {
  const existing = await conn.get('SELECT 1 FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  if (existing) return;
  const d = await defaultRole(serverId);
  if (d) await assign(serverId, userId, d.id, conn);
}

module.exports = {
  DEFAULT_ROLES, createDefaults, list, get, defaultRole, byName,
  create, update, remove, userRoles, assign, unassign, ensureDefault,
};
