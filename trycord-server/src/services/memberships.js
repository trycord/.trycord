// Membership lifecycle: the authoritative record of who belongs to a server.
// Join/leave/kick go through here — never raw INSERTs in routes.
const db = require('../db');
const { now, uuid } = require('../util');
const roles = require('./roles');

function get(serverId, userId) {
  return db.prepare('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function list(serverId) {
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, m.nickname, m.joined_at,
      CASE WHEN u.id = s.owner_id THEN 1 ELSE 0 END AS is_owner
    FROM server_members m
    JOIN users u ON u.id = m.user_id
    JOIN servers s ON s.id = m.server_id
    WHERE m.server_id = ?
    ORDER BY is_owner DESC, m.joined_at ASC
  `).all(serverId);
  const roleRows = db.prepare(`
    SELECT mr.user_id, r.id, r.name, r.position FROM member_roles mr
    JOIN roles r ON r.id = mr.role_id
    WHERE mr.server_id = ? ORDER BY r.position DESC
  `).all(serverId);
  const byUser = {};
  for (const r of roleRows) {
    (byUser[r.user_id] = byUser[r.user_id] || []).push({ id: r.id, name: r.name });
  }
  return members.map((m) => ({ ...m, is_owner: !!m.is_owner, roles: byUser[m.id] || [] }));
}

const joinTx = db.transaction((serverId, userId, username) => {
  const srv = db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
  if (get(serverId, userId)) throw { code: 'ALREADY_MEMBER', message: 'already a member' };
  db.prepare('INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), userId, serverId, username, now());
  roles.ensureDefault(serverId, userId);
  return { serverId };
});

function join(serverId, user) {
  return joinTx(serverId, user.id, user.username);
}

function joinByCode(code, user) {
  const srv = db.prepare('SELECT id FROM servers WHERE join_code = ?')
    .get(String(code).toLowerCase().trim());
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
  return joinTx(srv.id, user.id, user.username);
}

const leaveTx = db.transaction((serverId, userId) => {
  const srv = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
  if (!get(serverId, userId)) throw { code: 'NOT_A_MEMBER', message: 'not a member' };
  if (srv.owner_id === userId) {
    throw { code: 'OWNER_CANNOT_LEAVE', message: 'the owner cannot leave — transfer ownership or delete the server' };
  }
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  return { ok: true };
});

function leave(serverId, userId) {
  return leaveTx(serverId, userId);
}

const kickTx = db.transaction((serverId, actorId, targetId) => {
  const srv = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
  if (!get(serverId, targetId)) throw { code: 'NOT_A_MEMBER', message: 'user is not a member' };
  if (targetId === srv.owner_id) throw { code: 'VALIDATION_ERROR', message: 'the owner cannot be kicked' };
  if (targetId === actorId) throw { code: 'VALIDATION_ERROR', message: 'you cannot kick yourself' };
  // Role hierarchy: you can only kick members ranked below you.
  if (actorId !== srv.owner_id) {
    const top = (uid) => {
      if (uid === srv.owner_id) return Infinity;
      const rs = roles.userRoles(uid, serverId);
      return rs.length ? Math.max(...rs.map((r) => r.position)) : -1;
    };
    if (top(actorId) <= top(targetId)) {
      throw { code: 'PERMISSION_DENIED', message: 'target outranks you' };
    }
  }
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(serverId, targetId);
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, targetId);
  return { ok: true };
});

function kick(serverId, actorId, targetId) {
  return kickTx(serverId, actorId, targetId);
}

module.exports = { get, list, join, joinByCode, leave, kick };
