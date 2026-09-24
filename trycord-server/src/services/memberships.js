// Membership lifecycle: the authoritative record of who belongs to a server.
// Join/leave/kick go through here — never raw INSERTs in routes.
const db = require('../db');
const { now, uuid } = require('../util');
const roles = require('./roles');

async function get(serverId, userId, conn = db) {
  return conn.get('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
}

async function list(serverId) {
  // Member rows and their roles are independent queries — run together.
  const [members, roleRows] = await Promise.all([
    db.all(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, m.nickname, m.joined_at,
        CASE WHEN u.id = s.owner_id THEN 1 ELSE 0 END AS is_owner
      FROM server_members m
      JOIN users u ON u.id = m.user_id
      JOIN servers s ON s.id = m.server_id
      WHERE m.server_id = ?
      ORDER BY is_owner DESC, m.joined_at ASC`,
      [serverId]
    ),
    db.all(
      `SELECT mr.user_id, r.id, r.name, r.position FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
       WHERE mr.server_id = ? ORDER BY r.position DESC`,
      [serverId]
    ),
  ]);
  const byUser = {};
  for (const r of roleRows) {
    (byUser[r.user_id] = byUser[r.user_id] || []).push({ id: r.id, name: r.name });
  }
  return members.map((m) => ({ ...m, is_owner: !!m.is_owner, roles: byUser[m.id] || [] }));
}

async function joinInner(serverId, userId, username, conn) {
  const srv = await conn.get('SELECT id, enforcement_state FROM servers WHERE id = ?', [serverId]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
  // Trust & Safety: suspended servers are closed to new members. Existing
  // members are handled by the access chain (resolveServer).
  if (srv.enforcement_state === 'suspended') {
    throw { code: 'SERVER_SUSPENDED', message: 'server is suspended' };
  }
  if (await get(serverId, userId, conn)) throw { code: 'ALREADY_MEMBER', message: 'already a member' };
  await conn.run(
    'INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)',
    [uuid(), userId, serverId, username, now()]
  );
  await roles.ensureDefault(serverId, userId, conn);
  return { serverId };
}

async function join(serverId, user) {
  return db.transaction((t) => joinInner(serverId, user.id, user.username, t));
}

async function joinByCode(code, user) {
  const srv = await db.get('SELECT id FROM servers WHERE join_code = ?', [String(code).toLowerCase().trim()]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
  return join(srv.id, user);
}

// Exposed for invite consumption inside the invite transaction.
async function joinIn(serverId, user, conn) {
  return joinInner(serverId, user.id, user.username, conn);
}

async function leave(serverId, userId) {
  return db.transaction(async (t) => {
    const srv = await t.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
    if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
    if (!(await get(serverId, userId, t))) throw { code: 'NOT_A_MEMBER', message: 'not a member' };
    if (srv.owner_id === userId) {
      throw { code: 'OWNER_CANNOT_LEAVE', message: 'the owner cannot leave — transfer ownership or delete the server' };
    }
    await t.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
    await t.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
    return { ok: true };
  });
}

// Set or clear a member's per-community nickname. The route gates who may
// call this (self = anyone; others = staff with KICK_MEMBERS). NULL clears.
async function setNickname(serverId, targetId, nickname, conn = db) {
  const clean = String(nickname == null ? '' : nickname).trim();
  if (clean && (clean.length < 2 || clean.length > 32)) {
    const e = new Error('nickname must be 2-32 characters');
    e.code = 'VALIDATION_ERROR'; throw e;
  }
  if (!(await get(serverId, targetId, conn))) {
    const e = new Error('not a member');
    e.code = 'NOT_A_MEMBER'; throw e;
  }
  await conn.run(
    'UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?',
    [clean || null, serverId, targetId]
  );
  return { serverId, userId: targetId, nickname: clean || null };
}

async function kick(serverId, actorId, targetId) {
  return db.transaction(async (t) => {
    const srv = await t.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
    if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
    if (!(await get(serverId, targetId, t))) throw { code: 'NOT_A_MEMBER', message: 'user is not a member' };
    if (targetId === srv.owner_id) throw { code: 'VALIDATION_ERROR', message: 'the owner cannot be kicked' };
    if (targetId === actorId) throw { code: 'VALIDATION_ERROR', message: 'you cannot kick yourself' };
    // Role hierarchy: you can only kick members ranked below you.
    if (actorId !== srv.owner_id) {
      const top = async (uid) => {
        if (uid === srv.owner_id) return Infinity;
        const rs = await roles.userRoles(uid, serverId, t);
        return rs.length ? Math.max(...rs.map((r) => r.position)) : -1;
      };
      if ((await top(actorId)) <= (await top(targetId))) {
        throw { code: 'PERMISSION_DENIED', message: 'target outranks you' };
      }
    }
    await t.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
    await t.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
    return { ok: true };
  });
}

module.exports = { get, list, join, joinByCode, joinIn, leave, kick, setNickname };
