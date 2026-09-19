// Server lifecycle: create (server + owner membership + roles + category + channels),
// update settings, delete (atomic cascade). All multi-row flows are transactional.
const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const roles = require('./roles');
const { Codes } = require('../errors');
const { effectivePermissions } = require('./permissions');

const LIST_COLS = `
  s.id, s.name, s.description, s.owner_id, s.join_code,
  s.is_public, s.is_discoverable, s.created_at,
  (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
  (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count,
  (SELECT MAX(m2.created_at) FROM messages m2
     JOIN channels c2 ON c2.id = m2.channel_id WHERE c2.server_id = s.id) AS last_activity_at`;

async function withAccess(row, userId) {
  if (!row) return null;
  row.is_public = !!row.is_public;
  row.is_discoverable = !!row.is_discoverable;
  row.is_owner = row.owner_id === userId;
  row.permissions = [...(await effectivePermissions(userId, row.id))];
  return row;
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

async function detail(serverId, userId) {
  const row = await db.get(
    `SELECT ${LIST_COLS},
      (SELECT COUNT(*) FROM messages m2
         JOIN channels c2 ON c2.id = m2.channel_id WHERE c2.server_id = s.id) AS message_count,
      u.username AS owner_name, u.display_name AS owner_display
    FROM servers s JOIN users u ON u.id = s.owner_id WHERE s.id = ?`,
    [serverId]
  );
  return withAccess(row, userId);
}

async function mine(userId) {
  const rows = await db.all(
    `SELECT ${LIST_COLS} FROM servers s
     JOIN server_members m ON m.server_id = s.id
     WHERE m.user_id = ? ORDER BY s.created_at DESC`,
    [userId]
  );
  return Promise.all(rows.map((r) => withAccess(r, userId)));
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

module.exports = { create, detail, mine, update, remove };
