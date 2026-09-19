// Permission registry + evaluation. Owners bypass all checks.
// Add new permission names here — evaluation logic stays unchanged.
const db = require('../db');

const PERMISSIONS = {
  MANAGE_SERVER: 'Full server control (settings, visibility).',
  MANAGE_CHANNELS: 'Create, edit, and delete channels and categories.',
  MANAGE_ROLES: 'Create, edit, assign, and delete roles.',
  MANAGE_INVITES: 'Create and revoke invites.',
  KICK_MEMBERS: 'Remove members from the server.',
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
  if ((await getOwnerId(serverId, conn)) === userId) return new Set(['*']);
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

async function hasPermission(userId, serverId, perm, conn = db) {
  const perms = await effectivePermissions(userId, serverId, conn);
  return perms.has('*') || perms.has(perm);
}

module.exports = { PERMISSIONS, isKnown, getOwnerId, effectivePermissions, hasPermission };
