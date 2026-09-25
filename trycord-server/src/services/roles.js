// Role lifecycle: defaults, CRUD, assignment. All permission changes flow through here.
const db = require('../db');
const { uuid } = require('../util');
const { PERMISSIONS, isKnown } = require('./permissions');

const ALL = Object.keys(PERMISSIONS);

const DEFAULT_ROLES = [
  { name: 'Admin', position: 3, permissions: ALL, is_default: 0 },
  { name: 'Moderator', position: 2, permissions: ['KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'MANAGE_INVITES', 'SEND_MESSAGES'], is_default: 0 },
  { name: 'Member', position: 1, permissions: ['SEND_MESSAGES'], is_default: 1 },
];

function parseRow(r) {
  if (!r) return null;
  let permissions = [];
  try { permissions = JSON.parse(r.permissions); } catch { /* keep empty */ }
  return { ...r, color: r.color || null, permissions, is_default: !!r.is_default };
}

// Role colors are persisted display hints only — validated hex, never free
// text, so clients can style role pills/names without guessing from names.
function cleanColor(color) {
  if (color == null || color === '') return null;
  const c = String(color).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw { code: 'VALIDATION_ERROR', message: 'role color must be a hex color like #ff8a24' };
  return '#' + c.slice(1).toLowerCase();
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

async function create(serverId, { name, permissions, color }) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'role name required' };
  const perms = Array.isArray(permissions) ? permissions.filter(isKnown) : [];
  // New custom roles start at the bottom of the hierarchy.
  const posRow = await db.get('SELECT COALESCE(MIN(position), 1) - 1 AS p FROM roles WHERE server_id = ?', [serverId]);
  try {
    const id = uuid();
    await db.run(
      'INSERT INTO roles (id, server_id, name, color, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [id, serverId, clean, cleanColor(color), posRow.p, JSON.stringify(perms)]
    );
    return get(id);
  } catch (e) {
    if (isUniqueViolation(e)) throw { code: 'CONFLICT', message: 'a role with that name exists' };
    throw e;
  }
}

async function update(role, { name, permissions, color }) {
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
  if (color !== undefined) {
    sets.push('color = ?');
    vals.push(cleanColor(color));
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

// Atomic hierarchy reorder: the client sends the full desired order; every
// id must belong to this server. Positions are rewritten 0..n in one
// transaction so concurrent readers never see a half-applied order.
async function reorder(serverId, orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw { code: 'VALIDATION_ERROR', message: 'orderedIds must be a non-empty array' };
  }
  return db.transaction(async (t) => {
    const rows = await t.all('SELECT id FROM roles WHERE server_id = ?', [serverId]);
    const known = new Set(rows.map((r) => String(r.id)));
    const clean = orderedIds.map(String);
    if (clean.length !== known.size || !clean.every((id) => known.has(id))) {
      throw { code: 'VALIDATION_ERROR', message: 'orderedIds must contain exactly the server roles' };
    }
    let pos = 0;
    for (const id of clean) {
      await t.run('UPDATE roles SET position = ? WHERE id = ?', [pos++, id]);
    }
    return list(serverId);
  });
}

// Highest role position a user holds (owner = Infinity). Centralizes the
// hierarchy rule so assign/unassign/kick/ban/timeout all enforce it.
async function topPosition(serverId, userId, conn = db) {
  try {
    const srv = await conn.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
    if (srv && String(srv.owner_id) === String(userId)) return Infinity;
  } catch { /* fall through to roles */ }
  const rs = await userRoles(userId, serverId, conn);
  return rs.length ? Math.max(...rs.map((r) => r.position)) : -1;
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
  create, update, remove, reorder, topPosition, userRoles, assign, unassign, ensureDefault,
};
