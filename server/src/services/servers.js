// Communities, membership and invites.
//
// Ownership is a column on servers, not a flag on server_members, so a member cannot be
// demoted out of owning their own community by role surgery.

const db = require('../db');
const { now, uuid, slug } = require('../util');
const permissions = require('./permissions');
const can = permissions.can;

async function create({ name, description, joinCode, isPublic, isDiscoverable }, owner) {
  const id = uuid();
  const code = String(joinCode || uuid().slice(0, 8)).toLowerCase();
  const base = slug(name);
  let unique = base;
  // A slug has to be unique across the instance because it is the public address.
  for (let i = 2; await db.get('SELECT id FROM servers WHERE slug = ?', [unique]); i++) {
    unique = `${base}-${i}`;
  }

  const at = now();
  await db.run(
    `INSERT INTO servers (id, name, description, owner_id, join_code, slug, is_public,
       is_discoverable, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, String(name).trim(), description || '', owner.id, code, unique,
      isPublic ? 1 : 0, isDiscoverable === false ? 0 : 1, at]
  );

  await db.run(
    'INSERT INTO server_members (id, user_id, server_id, joined_at) VALUES (?, ?, ?, ?)',
    [uuid(), owner.id, id, at]
  );

  // Every new community gets a default role holding the permissions everyone starts with,
  // so an owner is not the only one who can speak in a brand-new community.
  await db.run(
    'INSERT INTO roles (id, server_id, name, color, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [uuid(), id, '@everyone', null, 0, JSON.stringify(['READ_MESSAGES', 'SEND_MESSAGES'])]
  );

  const channelId = uuid();
  await db.run(
    `INSERT INTO channels (id, server_id, name, slug, type, position) VALUES (?, ?, 'general', 'general', 'text', 0)`,
    [channelId, id]
  );

  return { serverId: id, joinCode: code, channelId, slug: unique };
}

async function list(userId) {
  const rows = await db.all(
    `SELECT s.id, s.name, s.description, s.slug, s.icon_url, s.banner_url,
       s.is_public, s.is_discoverable, s.join_code, s.created_at,
       (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
     FROM servers s
       JOIN server_members m ON m.server_id = s.id AND m.user_id = ?
      ORDER BY s.name`,
    [userId]
  );
  return rows.map(shape);
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    slug: row.slug,
    iconUrl: row.icon_url || null,
    bannerUrl: row.banner_url || null,
    isPublic: !!row.is_public,
    isDiscoverable: !!row.is_discoverable,
    joinCode: row.join_code || null,
    memberCount: Number(row.member_count || 0),
    createdAt: row.created_at,
  };
}

async function membership(userId, serverId) {
  const row = await db.get(
    `SELECT m.joined_at, m.nickname, s.owner_id,
       (SELECT COUNT(*) FROM server_members x WHERE x.server_id = s.id) AS member_count
     FROM server_members m JOIN servers s ON s.id = m.server_id
      WHERE m.server_id = ? AND m.user_id = ?`,
    [serverId, userId]
  );
  if (!row) return null;
  return {
    joinedAt: row.joined_at,
    nickname: row.nickname || null,
    isOwner: row.owner_id === userId,
    memberCount: Number(row.member_count || 0),
  };
}

async function detail(serverId, viewerId) {
  const row = await db.get(
    `SELECT s.*, (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
     FROM servers s WHERE s.id = ?`,
    [serverId]
  );
  if (!row) return null;

  // Membership is what makes a community readable by direct lookup. Appearing in the
  // discovery feed is a separate question, answered by the discover route, and being in
  // it is not the same as being open to anyone who guesses an id.
  const member = viewerId ? await membership(viewerId, serverId) : null;
  if (!member) return null;

  const out = shape({ ...row, member_count: row.member_count });
  out.isMember = true;
  out.isOwner = member.isOwner;
  return out;
}

async function update(serverId, viewerId, patch) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!can(perms, 'MANAGE_SERVER')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot manage this community' };
  }

  const allowed = ['name', 'description', 'is_public', 'is_discoverable'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    params.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : String(patch[key]).slice(0, 2000));
  }
  if (!sets.length) return detail(serverId, viewerId);

  params.push(serverId);
  await db.run(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, params);
  return detail(serverId, viewerId);
}

async function remove(serverId, viewerId) {
  const row = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (!row) throw { code: 'SERVER_NOT_FOUND', message: 'community not found' };
  if (row.owner_id !== viewerId) {
    throw { code: 'PERMISSION_DENIED', message: 'only the owner can delete this community' };
  }
  await db.run('DELETE FROM servers WHERE id = ?', [serverId]);
  return { ok: true };
}

async function members(serverId, viewerId, { limit = 100, offset = 0 } = {}) {
  if (!(await membership(viewerId, serverId))) {
    throw { code: 'NOT_A_MEMBER', message: 'you are not a member of this community' };
  }
  const rows = await db.all(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, m.joined_at, m.nickname,
       s.owner_id
     FROM server_members m
       JOIN users u ON u.id = m.user_id
       JOIN servers s ON s.id = m.server_id
      WHERE m.server_id = ?
      ORDER BY m.joined_at LIMIT ? OFFSET ?`,
    [serverId, Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200), Math.max(parseInt(offset, 10) || 0, 0)]
  );

  const roleRows = await db.all(
    `SELECT mr.user_id, r.name FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ?`,
    [serverId]
  );
  const rolesOf = {};
  for (const r of roleRows) {
    (rolesOf[r.user_id] = rolesOf[r.user_id] || []).push(r.name);
  }

  return rows.map((r) => ({
    id: r.id,
    userId: r.id,
    username: r.username,
    displayName: r.display_name,
    nickname: r.nickname || null,
    avatarUrl: r.avatar_url || null,
    isOwner: r.owner_id === r.id,
    joinedAt: r.joined_at,
    roles: rolesOf[r.id] || [],
  }));
}

async function leave(serverId, userId) {
  const row = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (!row) throw { code: 'SERVER_NOT_FOUND', message: 'community not found' };
  if (row.owner_id === userId) {
    throw { code: 'PERMISSION_DENIED', message: 'the owner cannot leave — transfer ownership first' };
  }
  await db.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  await db.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  return { ok: true };
}

async function transferOwnership(serverId, userId, newOwnerId) {
  const row = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (!row) throw { code: 'SERVER_NOT_FOUND', message: 'community not found' };
  if (row.owner_id !== userId) throw { code: 'PERMISSION_DENIED', message: 'only the owner can transfer ownership' };

  const target = await db.get(
    'SELECT user_id FROM server_members WHERE server_id = ? AND user_id = ?',
    [serverId, newOwnerId]
  );
  if (!target) throw { code: 'NOT_FOUND', message: 'that person is not a member of this community' };

  await db.run('UPDATE servers SET owner_id = ? WHERE id = ?', [newOwnerId, serverId]);
  return { ok: true };
}

// --- invites ----------------------------------------------------------------

async function createInvite(serverId, creatorId, { maxUses, expiresInHours }) {
  const perms = await permissions.serverPermissions(creatorId, serverId);
  if (!can(perms, 'MANAGE_INVITES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot create invites for this community' };
  }

  const code = uuid().slice(0, 8).toUpperCase();
  const expires = expiresInHours
    ? new Date(Date.now() + Number(expiresInHours) * 3600000).toISOString()
    : null;

  await db.run(
    'INSERT INTO invites (id, server_id, code, creator_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuid(), serverId, code, creatorId, maxUses == null ? null : Number(maxUses), expires, now()]
  );
  return { code, expiresAt: expires, maxUses: maxUses == null ? null : Number(maxUses) };
}

async function listInvites(serverId, viewerId) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!can(perms, 'MANAGE_INVITES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot see the invites for this community' };
  }
  return db.all(
    'SELECT id, code, max_uses, uses, expires_at, revoked, created_at FROM invites WHERE server_id = ? ORDER BY created_at DESC',
    [serverId]
  );
}

async function revokeInvite(serverId, inviteId, viewerId) {
  const perms = await permissions.serverPermissions(viewerId, serverId);
  if (!can(perms, 'MANAGE_INVITES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot revoke invites for this community' };
  }
  const inv = await db.get('SELECT id FROM invites WHERE id = ? AND server_id = ?', [inviteId, serverId]);
  if (!inv) throw { code: 'NOT_FOUND', message: 'invite not found' };
  await db.run('UPDATE invites SET revoked = 1 WHERE id = ?', [inviteId]);
  return { ok: true };
}

async function previewInvite(code) {
  const inv = await inviteByCode(code);
  if (!inv) return null;
  const srv = await db.get(
    `SELECT id, name, description, icon_url, is_public FROM servers WHERE id = ?`,
    [inv.server_id]
  );
  if (!srv) return null;
  const count = await db.get(
    'SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?',
    [srv.id]
  );
  // Minimal safe info for a pre-join display: never settings, members, or messages.
  return {
    serverId: srv.id,
    name: srv.name,
    description: srv.description || '',
    iconUrl: srv.icon_url || null,
    isPublic: !!srv.is_public,
    memberCount: Number(count.n || 0),
    expiresAt: inv.expires_at,
    revoked: !!inv.revoked,
  };
}

async function inviteByCode(code) {
  return db.get('SELECT * FROM invites WHERE code = ?', [String(code || '').toUpperCase().trim()]);
}

// Join by invite code, or by the community's own permanent join code.
async function joinByCode(userId, code) {
  const inv = await inviteByCode(code);
  if (inv) {
    if (inv.revoked) throw { code: 'INVITE_REVOKED', message: 'this invite has been revoked' };
    if (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) {
      throw { code: 'INVITE_EXPIRED', message: 'this invite has expired' };
    }
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) {
      throw { code: 'INVITE_EXHAUSTED', message: 'this invite has no uses left' };
    }

    return db.transaction(async (t) => {
      // Re-read inside the transaction: the expiry and the use count can both move
      // between the check above and here, and this second read is the one that decides.
      const fresh = await t.get('SELECT * FROM invites WHERE id = ?', [inv.id]);
      if (!fresh || fresh.revoked) throw { code: 'INVITE_REVOKED', message: 'this invite has been revoked' };
      if (fresh.expires_at && new Date(fresh.expires_at).getTime() <= Date.now()) {
        throw { code: 'INVITE_EXPIRED', message: 'this invite has expired' };
      }
      if (fresh.max_uses !== null && fresh.uses >= fresh.max_uses) {
        throw { code: 'INVITE_EXHAUSTED', message: 'this invite has no uses left' };
      }
      await addMember(t, fresh.server_id, userId);
      await t.run('UPDATE invites SET uses = uses + 1 WHERE id = ?', [fresh.id]);
      return { serverId: fresh.server_id };
    });
  }

  const srv = await db.get(
    'SELECT id FROM servers WHERE join_code = ?',
    [String(code || '').toLowerCase().trim()]
  );
  if (!srv) throw { code: 'INVITE_INVALID', message: 'that invite code is not valid' };
  return joinById(userId, srv.id);
}

async function joinById(userId, serverId) {
  await addMember(db, serverId, userId);
  return { serverId };
}

async function addMember(conn, serverId, userId) {
  const existing = await conn.get(
    'SELECT id FROM server_members WHERE server_id = ? AND user_id = ?',
    [serverId, userId]
  );
  if (existing) return;

  const at = now();
  await conn.run(
    'INSERT INTO server_members (id, user_id, server_id, joined_at) VALUES (?, ?, ?, ?)',
    [uuid(), userId, serverId, at]
  );
  await conn.run(
    'INSERT INTO server_membership_events (id, server_id, user_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuid(), serverId, userId, 'join', at]
  );
}

module.exports = {
  create, list, shape, detail, update, remove, membership, members,
  leave, transferOwnership, joinByCode, joinById, addMember,
  createInvite, listInvites, revokeInvite, previewInvite,
  permissions: permissions.serverPermissions,
  can: permissions.can,
};
