// Membership lifecycle: the authoritative record of who belongs to a server.
// Join/leave/kick/ban/timeout go through here — never raw INSERTs in routes.
const db = require('../db');
const { now, uuid } = require('../util');
const roles = require('./roles');
const events = require('./events');

function expiresAt(minutes) {
  if (minutes == null) return null;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) throw { code: 'VALIDATION_ERROR', message: 'minutes must be a non-negative number' };
  if (m === 0) return null;
  if (m > 40320) throw { code: 'VALIDATION_ERROR', message: 'timeout/ban cannot exceed 28 days' };
  return new Date(Date.now() + m * 60000).toISOString();
}

function isActive(row) {
  if (!row) return false;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).getTime() > Date.now();
}

async function get(serverId, userId, conn = db) {
  return conn.get('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
}

// Roster paging. The owner must always be in the first page, so they are
// fetched separately and merged in rather than being subject to the page
// window - otherwise an owner on a large community could scroll off their
// own roster.
async function list(serverId, { limit = null, offset = 0, search = '' } = {}) {
  // Member rows and their roles are independent queries — run together.
  const q = String(search || '').trim();
  const like = '%' + q + '%';
  const cap = limit === null || limit === undefined
    ? null
    : Math.min(Math.max(parseInt(limit, 10) || 0, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  // Without a cap this returned the entire roster for any member, and the
  // role query returned every role assignment in the community regardless of
  // which page was asked for. Both are unbounded on a large community.
  const where = q ? 'AND (u.username LIKE ? OR u.display_name LIKE ? OR m.nickname LIKE ?)' : '';
  const args = q ? [serverId, like, like, like] : [serverId];

  const [members, roleRows] = await Promise.all([
    cap === null
      ? db.all(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status_text,
          u.is_bot, m.nickname, m.joined_at, m.timeout_expires_at,
          CASE WHEN u.id = s.owner_id THEN 1 ELSE 0 END AS is_owner
        FROM server_members m
        JOIN users u ON u.id = m.user_id
        JOIN servers s ON s.id = m.server_id
        WHERE m.server_id = ? ${where}
        ORDER BY is_owner DESC, m.joined_at ASC`,
        args
      )
      : db.all(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status_text,
          u.is_bot, m.nickname, m.joined_at, m.timeout_expires_at,
          CASE WHEN u.id = s.owner_id THEN 1 ELSE 0 END AS is_owner
        FROM server_members m
        JOIN users u ON u.id = m.user_id
        JOIN servers s ON s.id = m.server_id
        WHERE m.server_id = ? ${where}
        ORDER BY (u.id = s.owner_id) DESC, m.joined_at ASC
        LIMIT ${cap} OFFSET ${off}`,
        args
      ),
    // Scope the role lookup to the page actually returned, otherwise this
    // still reads every assignment in the community.
    (cap === null
      ? db.all(
        `SELECT mr.user_id, r.id, r.name, r.color, r.position FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.server_id = ? ORDER BY r.position DESC`,
        [serverId]
      )
      : (async () => {
        const page = await db.all(
          `SELECT u.id FROM server_members m JOIN users u ON u.id = m.user_id
           JOIN servers s ON s.id = m.server_id
           WHERE m.server_id = ? ${where}
           ORDER BY (u.id = s.owner_id) DESC, m.joined_at ASC
           LIMIT ${cap} OFFSET ${off}`,
          args
        );
        if (!page.length) return [];
        const ids = page.map((p) => p.id);
        return db.all(
          `SELECT mr.user_id, r.id, r.name, r.color, r.position FROM member_roles mr
           JOIN roles r ON r.id = mr.role_id
           WHERE mr.server_id = ? AND mr.user_id IN (${ids.map(() => '?').join(',')})
           ORDER BY r.position DESC`,
          [serverId].concat(ids)
        );
      })()),
  ]);

  const byUser = {};
  for (const r of roleRows) {
    (byUser[r.user_id] = byUser[r.user_id] || []).push({ id: r.id, name: r.name, color: r.color || null });
  }
  // Note: an extra `total` property here would be silently dropped by
  // JSON.stringify, so a paged caller cannot learn the true roster size from
  // this array response. Exposing a total properly means changing the
  // envelope to { items, total }, which is a contract change - deliberately
  // not done here.
  return members.map((m) => ({
    ...m,
    is_owner: !!m.is_owner,
    is_bot: !!m.is_bot,
    roles: byUser[m.id] || [],
  }));
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
  const ban = await conn.get('SELECT * FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  if (isActive(ban)) throw { code: 'BANNED', message: 'you are banned from this server' };
  if (ban) await conn.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId]);
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

// Shared manageability rule: the owner is untouchable, nobody can act on
// themselves, and everyone else can only act on members ranked strictly
// below their own top role. Used by kick/ban/timeout alike.
async function assertManageable(serverId, actorId, targetId, verb, conn = db) {
  const srv = await conn.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
  if (String(targetId) === String(srv.owner_id)) {
    throw { code: 'VALIDATION_ERROR', message: 'the owner cannot be ' + verb };
  }
  if (String(targetId) === String(actorId)) {
    throw { code: 'VALIDATION_ERROR', message: 'you cannot ' + verb + ' yourself' };
  }
  if (String(actorId) !== String(srv.owner_id)) {
    const [actorTop, targetTop] = await Promise.all([
      roles.topPosition(serverId, actorId, conn),
      roles.topPosition(serverId, targetId, conn),
    ]);
    if (actorTop <= targetTop) throw { code: 'PERMISSION_DENIED', message: 'target outranks you' };
  }
  return srv;
}

async function removeMembership(serverId, targetId, conn) {
  await conn.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
  await conn.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
}

async function kick(serverId, actorId, targetId) {
  const out = await db.transaction(async (t) => {
    await assertManageable(serverId, actorId, targetId, 'kicked', t);
    if (!(await get(serverId, targetId, t))) throw { code: 'NOT_A_MEMBER', message: 'user is not a member' };
    await removeMembership(serverId, targetId, t);
    return { ok: true };
  });
  events.emit(serverId, 'member_kicked', { userId: String(targetId) });
  events.evict(serverId, targetId, 'kicked from server');
  return out;
}

async function leave(serverId, userId) {
  const out = await db.transaction(async (t) => {
    const srv = await t.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
    if (!srv) throw { code: 'SERVER_NOT_FOUND', message: 'server not found' };
    if (!(await get(serverId, userId, t))) throw { code: 'NOT_A_MEMBER', message: 'not a member' };
    if (srv.owner_id === userId) {
      throw { code: 'OWNER_CANNOT_LEAVE', message: 'the owner cannot leave — transfer ownership or delete the server' };
    }
    await removeMembership(serverId, userId, t);
    return { ok: true };
  });
  events.emit(serverId, 'member_left', { userId: String(userId) });
  events.evict(serverId, userId, 'left server');
  return out;
}

// Ban: persistent per-server ban state. The target is removed immediately
// (like a kick) and cannot rejoin until unbanned or the ban expires.
// minutes null/omitted = permanent.
async function ban(serverId, actorId, targetId, { reason, minutes } = {}) {
  const target = await db.get('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target) throw { code: 'NOT_FOUND', message: 'user not found' };
  const out = await db.transaction(async (t) => {
    await assertManageable(serverId, actorId, targetId, 'banned', t);
    await removeMembership(serverId, targetId, t);
    await t.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
    const exp = expiresAt(minutes);
    await t.run(
      'INSERT INTO server_bans (id, server_id, user_id, actor_id, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), serverId, targetId, actorId, String(reason || '').slice(0, 500) || null, exp, now()]
    );
    return { ok: true, expiresAt: exp };
  });
  events.emit(serverId, 'member_banned', { userId: String(targetId) });
  events.evict(serverId, targetId, 'banned from server');
  return out;
}

async function unban(serverId, targetId) {
  const row = await db.get('SELECT id FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'that ban does not exist' };
  await db.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
  events.emit(serverId, 'member_unbanned', { userId: String(targetId) });
  return { ok: true };
}

async function listBans(serverId) {
  const rows = await db.all(
    `SELECT b.user_id, b.reason, b.expires_at, b.created_at, u.username, u.display_name,
       a.username AS actor_name
     FROM server_bans b
     JOIN users u ON u.id = b.user_id
     LEFT JOIN users a ON a.id = b.actor_id
     WHERE b.server_id = ? ORDER BY b.created_at DESC`,
    [serverId]
  );
  const nowMs = Date.now();
  return rows
    .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > nowMs)
    .map((r) => ({
      userId: r.user_id, username: r.username, displayName: r.display_name,
      reason: r.reason, expiresAt: r.expires_at, createdAt: r.created_at,
      actorName: r.actor_name || null,
    }));
}

// Timeout: the member stays, but cannot post until it lapses. minutes
// null/0 clears. Enforced server-side on every message send.
async function timeout(serverId, actorId, targetId, minutes) {
  const out = await db.transaction(async (t) => {
    await assertManageable(serverId, actorId, targetId, 'timed out', t);
    if (!(await get(serverId, targetId, t))) throw { code: 'NOT_A_MEMBER', message: 'user is not a member' };
    const exp = expiresAt(minutes);
    await t.run('UPDATE server_members SET timeout_expires_at = ? WHERE server_id = ? AND user_id = ?',
      [exp, serverId, targetId]);
    return { ok: true, expiresAt: exp };
  });
  events.emit(serverId, 'member_timeout', { userId: String(targetId), expiresAt: out.expiresAt });
  return out;
}

async function isTimedOut(serverId, userId, conn = db) {
  const row = await conn.get('SELECT timeout_expires_at FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  return !!(row && row.timeout_expires_at && new Date(row.timeout_expires_at).getTime() > Date.now());
}

module.exports = {
  get, list, join, joinByCode, joinIn, leave, kick, setNickname,
  ban, unban, listBans, timeout, isTimedOut,
};
