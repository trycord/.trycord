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

function createDefaults(serverId) {
  for (const d of DEFAULT_ROLES) {
    db.prepare('INSERT INTO roles (id, server_id, name, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid(), serverId, d.name, d.position, JSON.stringify(d.permissions), d.is_default);
  }
}

function list(serverId) {
  return db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, name ASC')
    .all(serverId).map(parseRow);
}

function get(roleId) {
  return parseRow(db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId));
}

function defaultRole(serverId) {
  return parseRow(db.prepare('SELECT * FROM roles WHERE server_id = ? AND is_default = 1').get(serverId));
}

function byName(serverId, name) {
  return parseRow(db.prepare('SELECT * FROM roles WHERE server_id = ? AND name = ?').get(serverId, name));
}

function create(serverId, { name, permissions }) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'role name required' };
  const perms = Array.isArray(permissions) ? permissions.filter(isKnown) : [];
  // New custom roles start at the bottom of the hierarchy.
  const pos = db.prepare('SELECT COALESCE(MIN(position), 1) - 1 AS p FROM roles WHERE server_id = ?').get(serverId).p;
  try {
    const id = uuid();
    db.prepare('INSERT INTO roles (id, server_id, name, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, 0)')
      .run(id, serverId, clean, pos, JSON.stringify(perms));
    return get(id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw { code: 'CONFLICT', message: 'a role with that name exists' };
    throw e;
  }
}

function update(role, { name, permissions }) {
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
    db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw { code: 'CONFLICT', message: 'a role with that name exists' };
    throw e;
  }
  return get(role.id);
}

function remove(role) {
  if (role.is_default) throw { code: 'VALIDATION_ERROR', message: 'the default role cannot be deleted' };
  const n = db.prepare('SELECT COUNT(*) AS n FROM member_roles WHERE role_id = ?').get(role.id).n;
  if (n > 0) throw { code: 'ROLE_IN_USE', message: `role is assigned to ${n} member(s)` };
  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  return { ok: true };
}

function userRoles(userId, serverId) {
  return db.prepare(`
    SELECT r.* FROM member_roles mr JOIN roles r ON r.id = mr.role_id
    WHERE mr.server_id = ? AND mr.user_id = ? ORDER BY r.position DESC
  `).all(serverId, userId).map(parseRow);
}

function assign(serverId, userId, roleId) {
  db.prepare('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)')
    .run(serverId, userId, roleId);
  return { ok: true };
}

function unassign(serverId, userId, roleId) {
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?')
    .run(serverId, userId, roleId);
  return { ok: true };
}

function ensureDefault(serverId, userId) {
  const existing = db.prepare('SELECT 1 FROM member_roles WHERE server_id = ? AND user_id = ?')
    .get(serverId, userId);
  if (existing) return;
  const d = defaultRole(serverId);
  if (d) assign(serverId, userId, d.id);
}

module.exports = {
  DEFAULT_ROLES, createDefaults, list, get, defaultRole, byName,
  create, update, remove, userRoles, assign, unassign, ensureDefault,
};
