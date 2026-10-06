// Role lifecycle: the built-in baseline, CRUD, assignment. All permission
// changes flow through here.
const db = require('../db');
const { uuid } = require('../util');
const { isKnown } = require('./permissions');

// Exactly one seeded role, and it is not a convenience preset.
//
// @everyone is the community's baseline: every member holds it, and its
// permission set is what a member can do out of the box. Staff configure it
// like any other role, which is why its permissions stay editable.
//
// No "Admin" or "Moderator" is seeded. The owner already inherits every
// permission from ownership alone, so an Admin role holding all of them would
// be a second, weaker path to total power and would make the hierarchy
// incoherent - a member with Admin could then outrank the owner in every way
// that matters while still being told they are not the owner.
const BASELINE_ROLE = {
  name: '@everyone', position: 1, permissions: ['SEND_MESSAGES'], is_default: 1,
};
const DEFAULT_ROLES = [BASELINE_ROLE];

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

// createDefaults seeds the single baseline role. Named for the call site that
// creates a community; there is nothing plural about it any more.
async function createDefaults(serverId, conn = db) {
  const d = BASELINE_ROLE;
  await conn.run(
    'INSERT INTO roles (id, server_id, name, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, ?)',
    [uuid(), serverId, d.name, d.position, JSON.stringify(d.permissions), d.is_default]
  );
}

async function list(serverId) {
  const rows = await db.all('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC, name ASC', [serverId]);
  return rows.map(parseRow);
}

async function get(roleId) {
  return parseRow(await db.get('SELECT * FROM roles WHERE id = ?', [roleId]));
}

// The community baseline role. Renamed from defaultRole() to say what it is:
// the one role every member holds, whose permissions staff configure.
async function baselineRole(serverId) {
  return parseRow(await db.get('SELECT * FROM roles WHERE server_id = ? AND is_default = 1', [serverId]));
}

async function byName(serverId, name) {
  return parseRow(await db.get('SELECT * FROM roles WHERE server_id = ? AND name = ?', [serverId, name]));
}
function isUniqueViolation(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

// Where a new custom role lands: the lowest slot that is still ABOVE @everyone.
//
// @everyone is the floor of the hierarchy - it is what every member has, so
// nothing may rank below it. Stacking new roles at MIN(position) - 1 as this
// used to put every custom role underneath @everyone, which inverted the one
// guarantee the hierarchy has to make.
async function nextPosition(serverId, conn = db) {
  const floor = await conn.get(
    'SELECT COALESCE(MIN(position), 0) AS p FROM roles WHERE server_id = ? AND is_default = 1',
    [serverId]
  );
  const lowestCustom = await conn.get(
    'SELECT MIN(position) AS p FROM roles WHERE server_id = ? AND is_default = 0',
    [serverId]
  );
  const base = floor ? Number(floor.p) : 0;
  const lowest = lowestCustom && lowestCustom.p !== null ? Number(lowestCustom.p) : null;
  if (lowest === null) return base + 1;
  return lowest > base ? lowest : base + 1;
}

async function create(serverId, { name, permissions, color }) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'role name required' };
  const perms = Array.isArray(permissions) ? permissions.filter(isKnown) : [];
  const position = await nextPosition(serverId);
  try {
    const id = uuid();
    await db.run(
      'INSERT INTO roles (id, server_id, name, color, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [id, serverId, clean, cleanColor(color), position, JSON.stringify(perms)]
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
    // The baseline role is identified by the flag, not by its label. Letting it
    // be renamed means the community silently loses the role every member is
    // supposed to hold, and the UI can no longer find it to protect it. Its
    // permissions and colour stay fully editable - that is the point of it
    // being the community's baseline. Only its identity is fixed.
    const clean = String(name).trim().slice(0, 32);
    if (!clean) throw { code: 'VALIDATION_ERROR', message: 'role name cannot be empty' };
    if (role.is_default) {
      // Submitting the name it already has is not a rename. The editor always
      // posts the full object, so rejecting every name would make the baseline
      // impossible to configure at all - the exact thing it exists for.
      if (clean !== String(role.name || '').trim()) {
        throw { code: 'VALIDATION_ERROR', message: '@everyone cannot be renamed - it is the community baseline role' };
      }
    } else {
      sets.push('name = ?');
      vals.push(clean);
    }
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
  if (role.is_default) throw { code: 'VALIDATION_ERROR', message: 'the @everyone baseline role cannot be deleted' };
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
    const rows = await t.all('SELECT id, is_default FROM roles WHERE server_id = ?', [serverId]);
    const known = new Set(rows.map((r) => String(r.id)));
    const clean = orderedIds.map(String);
    if (clean.length !== known.size || !clean.every((id) => known.has(id))) {
      throw { code: 'VALIDATION_ERROR', message: 'orderedIds must contain exactly the server roles' };
    }
    // @everyone is always last, whatever order was sent. The client sends the
    // whole list, so without this a drag could float the baseline role above a
    // custom one and quietly invert who outranks whom.
    const everyone = rows.filter((r) => r.is_default).map((r) => String(r.id));
    const custom = clean.filter((id) => !everyone.includes(id));
    const ordered = [...custom, ...everyone];

    // Highest first, so index 0 is the most senior and the floor is last.
    let pos = ordered.length - 1;
    for (const id of ordered) {
      await t.run('UPDATE roles SET position = ? WHERE id = ?', [pos--, id]);
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

// Every member holds the community baseline. This is the only assignment the
// system performs on its own; no other role is ever granted automatically.
async function ensureBaseline(serverId, userId, conn = db) {
  const existing = await conn.get('SELECT 1 FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  if (existing) return;
  const d = await baselineRole(serverId);
  if (d) await assign(serverId, userId, d.id, conn);
}

// Whether a member already holds a role. Kept because the role assignment
// surfaces need it to show current state; it is not a grant path - assignment
// goes through assign(), which enforces the hierarchy.
async function userHasRole(serverId, userId, roleId, conn = db) {
  const row = await conn.get(
    'SELECT 1 AS ok FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?',
    [serverId, userId, roleId]
  );
  return !!row;
}

module.exports = {
  DEFAULT_ROLES, createDefaults, list, get, baselineRole, byName,
  create, update, remove, reorder, topPosition, userRoles, assign, unassign,
  ensureBaseline, userHasRole,
};
