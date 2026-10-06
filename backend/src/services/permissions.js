// Permission registry + evaluation. Owners bypass all checks.
// Add new permission names here — evaluation logic stays unchanged.
const db = require('../db');

const PERMISSIONS = {
  MANAGE_SERVER: 'Full server control (settings, visibility).',
  MANAGE_CHANNELS: 'Create, edit, and delete channels and categories.',
  MANAGE_ROLES: 'Create, edit, assign, and delete roles.',
  MANAGE_INVITES: 'Create and revoke invites.',
  KICK_MEMBERS: 'Remove members from the server.',
  BAN_MEMBERS: 'Ban/unban members and manage timeouts.',
  MANAGE_MESSAGES: 'Delete any message in the server.',
  SEND_MESSAGES: 'Post messages in channels.',
};

function isKnown(perm) {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, perm);
}

async function getOwnerId(serverId, conn = db) {
  const row = await conn.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  return row ? row.owner_id : null;
}

// Union of all permission strings granted to the user via roles.
async function effectivePermissions(userId, serverId, conn = db) {
  return effectivePermissionsFor(await getOwnerId(serverId, conn), userId, serverId, conn);
}

// Same as effectivePermissions, but skips the owner lookup when the
// caller already holds the server row (middleware, list flows). One
// fewer round trip per call; identical result.
async function effectivePermissionsFor(ownerId, userId, serverId, conn = db) {
  if (ownerId === userId) return new Set(['*']);
  const rows = await conn.all(
    `SELECT r.permissions FROM member_roles mr
     JOIN roles r ON r.id = mr.role_id
     WHERE mr.server_id = ? AND mr.user_id = ?`,
    [serverId, userId]
  );
  const out = new Set();
  for (const r of rows) {
    try {
      for (const p of JSON.parse(r.permissions)) if (isKnown(p)) out.add(p);
    } catch { /* ignore malformed role row */ }
  }
  return out;
}

// Channel-scoped permissions.
//
// Precedence, most specific last so it overwrites:
//
//   1. roles           - the community-wide default (union of role grants)
//   2. category        - overrides for the channel's category, if any
//   3. channel         - overrides for this channel, if any
//
// Within one level an explicit 'deny' beats an explicit 'allow', so a
// contradictory pair resolves to the safer answer rather than to whichever
// row the database happened to return first. Absent rows mean "inherit" and
// change nothing, which is what keeps existing communities behaving exactly
// as they did before overrides existed.
//
// ownerId === userId still short-circuits to '*': ownership is absolute and
// no override may lock an owner out of their own community.
async function effectiveChannelPermissions(ownerId, userId, serverId, channelId, conn = db) {
  const base = await effectivePermissionsFor(ownerId, userId, serverId, conn);
  if (!channelId || base.has('*')) return base;

  const ch = await conn.get('SELECT category_id FROM channels WHERE id = ? AND server_id = ?',
    [channelId, serverId]);
  if (!ch) return base;

  const apply = (rows) => {
    // Two passes so deny always wins regardless of row order.
    for (const effect of ['allow', 'deny']) {
      for (const r of rows) {
        if (!isKnown(r.permission) || r.effect !== effect) continue;
        if (effect === 'deny') base.delete(r.permission);
        else base.add(r.permission);
      }
    }
  };

  if (ch.category_id) {
    apply(await conn.all(
      'SELECT permission, effect FROM category_permission_overrides WHERE category_id = ?',
      [ch.category_id]
    ));
  }
  apply(await conn.all(
    'SELECT permission, effect FROM channel_permission_overrides WHERE channel_id = ?',
    [channelId]
  ));
  return base;
}

// Channel-scoped gate. Without a channelId this is exactly hasPermission, so
// every existing community-level call site keeps its current meaning.
async function hasChannelPermission(userId, serverId, channelId, perm, conn = db) {
  const perms = await effectiveChannelPermissions(
    await getOwnerId(serverId, conn), userId, serverId, channelId, conn
  );
  return perms.has('*') || perms.has(perm);
}

// Community-level gate. Unchanged in meaning: this is what every existing
// call site (MANAGE_ROLES, BAN_MEMBERS, ...) uses, and none of those are
// channel-scoped. Channel-scoped checks use hasChannelPermission.
async function hasPermission(userId, serverId, perm, conn = db) {
  const perms = await effectivePermissions(userId, serverId, conn);
  return perms.has('*') || perms.has(perm);
}

// Override table -> its id column. Explicit rather than derived: the tables
// are plural ("..._overrides") while the columns are singular
// ("channel_id"), so slicing the table name produces a column that does not
// exist.
const OVERRIDE_TABLES = {
  channel_permission_overrides: 'channel_id',
  category_permission_overrides: 'category_id',
};

// Read the override rows for an entity, shaped for a permission editor:
// a full map of every known permission to inherit/allow/deny so the UI never
// has to guess what "unset" looks like.
async function overridesFor(table, id) {
  const idCol = OVERRIDE_TABLES[table];
  if (!idCol) throw { code: 'VALIDATION_ERROR', message: 'unknown override table' };
  const rows = await db.all(`SELECT permission, effect FROM ${table} WHERE ${idCol} = ?`, [id]);
  const out = {};
  for (const p of Object.keys(PERMISSIONS)) out[p] = 'inherit';
  for (const r of rows) if (isKnown(r.permission)) out[r.permission] = r.effect === 'deny' ? 'deny' : 'allow';
  return out;
}

async function setOverride(table, id, permission, effect) {
  const idCol = OVERRIDE_TABLES[table];
  if (!idCol) throw { code: 'VALIDATION_ERROR', message: 'unknown override table' };
  if (!isKnown(permission)) throw { code: 'VALIDATION_ERROR', message: 'unknown permission' };
  if (effect === 'inherit') {
    await db.run(`DELETE FROM ${table} WHERE ${idCol} = ? AND permission = ?`, [id, permission]);
    return { permission, effect: 'inherit' };
  }
  if (effect !== 'allow' && effect !== 'deny') {
    throw { code: 'VALIDATION_ERROR', message: 'effect must be allow, deny or inherit' };
  }
  // Upsert: the PK is (entity, permission) so a second write replaces rather
  // than accumulating a contradictory pair.
  //
  // Each dialect spells its own upsert, so the statement is chosen by dialect
  // rather than attempted and caught. MySQL has no ON CONFLICT: feeding it one
  // is a parse error, and recovering from that with a bare UPDATE only edits
  // rows that already exist - it never creates the missing one, so the first
  // write of every override was silently dropped while the caller was told it
  // had succeeded. Sniffing the error text is not a fix either: MySQL quotes
  // the rejected statement back in the message, so the parse error raised by
  // the wrong dialect trivially "looks like" a duplicate-key conflict.
  const upsert = db.dialect === 'mysql'
    ? `INSERT INTO ${table} (${idCol}, permission, effect) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE effect = VALUES(effect)`
    : `INSERT INTO ${table} (${idCol}, permission, effect) VALUES (?, ?, ?)
       ON CONFLICT (${idCol}, permission) DO UPDATE SET effect = excluded.effect`;
  await db.run(upsert, [id, permission, effect]);
  return { permission, effect };
}

module.exports = {
  PERMISSIONS, isKnown, getOwnerId, effectivePermissions, effectivePermissionsFor,
  effectiveChannelPermissions, hasChannelPermission, hasPermission, overridesFor, setOverride,
};
