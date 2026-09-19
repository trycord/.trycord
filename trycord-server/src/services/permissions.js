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

function getOwnerId(serverId) {
  const row = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  return row ? row.owner_id : null;
}

// Union of all permission strings granted to the user via roles.
function effectivePermissions(userId, serverId) {
  if (getOwnerId(serverId) === userId) return new Set(['*']);
  const rows = db.prepare(`
    SELECT r.permissions FROM member_roles mr
    JOIN roles r ON r.id = mr.role_id
    WHERE mr.server_id = ? AND mr.user_id = ?
  `).all(serverId, userId);
  const out = new Set();
  for (const r of rows) {
    try {
      for (const p of JSON.parse(r.permissions)) if (isKnown(p)) out.add(p);
    } catch { /* ignore malformed role row */ }
  }
  return out;
}

function hasPermission(userId, serverId, perm) {
  const perms = effectivePermissions(userId, serverId);
  return perms.has('*') || perms.has(perm);
}

module.exports = { PERMISSIONS, isKnown, getOwnerId, effectivePermissions, hasPermission };
