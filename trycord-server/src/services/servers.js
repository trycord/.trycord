// Server lifecycle: create (server + owner membership + roles + category + channels),
// update settings, delete (atomic cascade). All multi-row flows are transactional.
const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const roles = require('./roles');
const { Codes } = require('../errors');
const { effectivePermissions, isKnown } = require('./permissions');

const LIST_COLS = `
  s.id, s.name, s.description, s.owner_id, s.join_code,
  s.is_public, s.is_discoverable, s.created_at, s.enforcement_state,
  (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
  (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count,
  (SELECT MAX(m2.created_at) FROM messages m2
     JOIN channels c2 ON c2.id = m2.channel_id WHERE c2.server_id = s.id) AS last_activity_at`;

async function withAccess(row, userId, perms) {
  if (!row) return null;
  row.is_public = !!row.is_public;
  row.is_discoverable = !!row.is_discoverable;
  row.is_owner = row.owner_id === userId;
  // Callers that already hold the computed set (middleware req.access,
  // the batched mine() flow) pass it in; otherwise compute as before.
  row.permissions = perms || [...(await effectivePermissions(userId, row.id))];
  return row;
}

// One roles query for a whole server list instead of two queries per
// row (owner lookup + roles). Returns serverId -> permission array.
async function rolesForServers(userId, serverIds) {
  const out = {};
  const ids = (serverIds || []).filter(Boolean).slice(0, 500);
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT mr.server_id AS sid, r.permissions FROM member_roles mr
     JOIN roles r ON r.id = mr.role_id
     WHERE mr.user_id = ? AND mr.server_id IN (${ph})`,
    [userId].concat(ids)
  );
  for (const r of rows) {
    try {
      for (const p of JSON.parse(r.permissions)) {
        if (isKnown(p)) ((out[r.sid] = out[r.sid] || new Set())).add(p);
      }
    } catch { /* ignore malformed role row */ }
  }
  for (const k of Object.keys(out)) out[k] = [...out[k]];
  return out;
}

function isUniqueViolation(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

async function create({ name, description, joinCode, isPublic, isDiscoverable }, owner) {
  const cleanName = String(name || '').trim().slice(0, 64);
  if (!cleanName) throw { code: 'VALIDATION_ERROR', message: 'name required' };
  const code = String(joinCode || crypto.randomBytes(4).toString('hex')).toLowerCase();
  if (!/^[a-z0-9-]{3,32}$/.test(code)) {
    throw { code: 'VALIDATION_ERROR', message: 'join code must be 3-32 chars: a-z, 0-9, -' };
  }
  try {
    return await db.transaction(async (t) => {
      const serverId = uuid();
      await t.run(
        `INSERT INTO servers
         (id, name, description, owner_id, join_code, is_public, is_discoverable, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [serverId, cleanName, String(description || '').slice(0, 500), owner.id, code,
          isPublic ? 1 : 0, isDiscoverable === undefined ? (isPublic ? 1 : 0) : (isDiscoverable ? 1 : 0), now()]
      );
      await t.run(
        'INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)',
        [uuid(), owner.id, serverId, owner.username, now()]
      );
      await roles.createDefaults(serverId, t);
      const admin = await roles.byName(serverId, 'Admin');
      if (admin) await roles.assign(serverId, owner.id, admin.id, t);
      const catId = uuid();
      await t.run('INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)', [catId, serverId, 'Text Channels', 0]);
      const channelId = uuid();
      await t.run(
        'INSERT INTO channels (id, server_id, category_id, name, topic, type, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [channelId, serverId, catId, 'general', 'General chat', 'text', 0]
      );
      return { serverId, joinCode: code, channelId };
    });
  } catch (e) {
    // Service-shaped errors pass through; raw driver errors get translated.
    if (e && e.code && Codes[e.code]) throw e;
    if (isUniqueViolation(e)) throw { code: 'CONFLICT', message: 'join code taken' };
    throw e;
  }
}

async function detail(serverId, userId, perms) {
  const row = await db.get(
    `SELECT ${LIST_COLS},
      (SELECT COUNT(*) FROM messages m2
         JOIN channels c2 ON c2.id = m2.channel_id WHERE c2.server_id = s.id) AS message_count,
      (SELECT COUNT(*) FROM roles r WHERE r.server_id = s.id) AS role_count,
       u.username AS owner_name, u.display_name AS owner_display
    FROM servers s JOIN users u ON u.id = s.owner_id WHERE s.id = ?`,
    [serverId]
  );
  return withAccess(row, userId, perms);
}

async function mine(userId) {
  const rows = await db.all(
    `SELECT ${LIST_COLS} FROM servers s
     JOIN server_members m ON m.server_id = s.id
     WHERE m.user_id = ? ORDER BY s.created_at DESC`,
    [userId]
  );
  // Owners bypass roles by contract; one query covers every other row.
  const owners = new Set(rows.filter((r) => r.owner_id === userId).map((r) => r.id));
  const batched = await rolesForServers(userId, rows.filter((r) => !owners.has(r.id)).map((r) => r.id));
  return Promise.all(rows.map((r) => withAccess(r, userId, owners.has(r.id) ? ['*'] : (batched[r.id] || []))));
}

async function update(serverId, patch) {
  const sets = [];
  const vals = [];
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) throw { code: 'VALIDATION_ERROR', message: 'name cannot be empty' };
    sets.push('name = ?');
    vals.push(String(patch.name).slice(0, 64));
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    vals.push(String(patch.description).slice(0, 500));
  }
  if (patch.isPublic !== undefined) {
    sets.push('is_public = ?');
    vals.push(patch.isPublic ? 1 : 0);
  }
  if (patch.isDiscoverable !== undefined) {
    sets.push('is_discoverable = ?');
    vals.push(patch.isDiscoverable ? 1 : 0);
  }
  if (!sets.length) throw { code: 'VALIDATION_ERROR', message: 'nothing to update' };
  vals.push(serverId);
  await db.run(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, vals);
  return db.get('SELECT * FROM servers WHERE id = ?', [serverId]);
}

async function remove(serverId) {
  // Dependent rows cascade via foreign keys; one statement, atomic by itself.
  await db.run('DELETE FROM servers WHERE id = ?', [serverId]);
  return { ok: true };
}

// Hand a community to a new owner.
//
// The whole point of this is that an owner could not leave: `leave` refuses
// for the owner, and nothing could change owner_id, so the only exit was
// deleting the community. Ownership is a single column, so the invariants are
// enforced by doing all of it in one transaction:
//
//   - the new owner is a current member (otherwise a community could end up
//     owned by someone who cannot even see it)
//   - the caller is the current owner (authorisation, re-checked inside the
//     transaction rather than trusted from middleware)
//   - the new owner is granted a top role, because a community whose owner
//     holds no roles would be unadministrable
//   - the old owner stays a member, and is demoted to a normal role so the
//     community is never left with two owners
//   - exactly one owner exists before and after, and never none in between
async function transferOwnership(serverId, actorId, targetUserId) {
  const target = String(targetUserId || '').trim();
  if (!target) throw { code: 'VALIDATION_ERROR', message: 'a new owner is required' };
  if (target === String(actorId)) {
    throw { code: 'VALIDATION_ERROR', message: 'you already own this community' };
  }
  return db.transaction(async (t) => {
    const srv = await t.get('SELECT id, owner_id FROM servers WHERE id = ?', [serverId]);
    if (!srv) throw { code: 'NOT_FOUND', message: 'community not found' };
    if (String(srv.owner_id) !== String(actorId)) {
      throw { code: 'PERMISSION_DENIED', message: 'only the owner can transfer ownership' };
    }
    const member = await t.get(
      'SELECT 1 AS ok FROM server_members WHERE server_id = ? AND user_id = ?',
      [serverId, target]
    );
    if (!member) {
      throw { code: 'NOT_A_MEMBER', message: 'the new owner must already be a member of this community' };
    }

    // Promote the new owner above every existing role, then give the old
    // owner a plain member role so they keep access without authority.
    const top = await roles.topPosition(serverId, target, t);
    const admin = await t.get(
      "SELECT id FROM roles WHERE server_id = ? AND is_default = 0 ORDER BY position DESC LIMIT 1",
      [serverId]
    );
    if (admin) {
      await t.run(
        'UPDATE roles SET position = ? WHERE id = ? AND position <= ?',
        [Number(top) + 1, admin.id, Number(top)]
      );
      await t.run(
        'INSERT ' + (t.dialect === 'mysql' ? 'IGNORE' : 'OR IGNORE') +
        ' INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)',
        [serverId, target, admin.id]
      );
    }
    const fallback = await t.get(
      'SELECT id FROM roles WHERE server_id = ? AND is_default = 1 LIMIT 1',
      [serverId]
    );
    if (fallback) {
      // Drop any elevated roles the outgoing owner held, then leave them with
      // the default role only. Without this the "old owner" would keep
      // whatever power they had, which is not what transferring means.
      await t.run(
        'DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id <> ?',
        [serverId, actorId, fallback.id]
      );
      await t.run(
        'INSERT ' + (t.dialect === 'mysql' ? 'IGNORE' : 'OR IGNORE') +
        ' INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)',
        [serverId, actorId, fallback.id]
      );
    }

    // Single statement: one owner before, one after, never zero.
    await t.run('UPDATE servers SET owner_id = ? WHERE id = ? AND owner_id = ?',
      [target, serverId, actorId]);
    const after = await t.get('SELECT id, owner_id, name FROM servers WHERE id = ?', [serverId]);
    if (!after || String(after.owner_id) !== target) {
      throw { code: 'CONFLICT', message: 'ownership transfer did not apply' };
    }
    return { serverId: after.id, name: after.name, ownerId: target, previousOwnerId: String(actorId) };
  });
}

module.exports = { create, detail, mine, update, remove, transferOwnership };
