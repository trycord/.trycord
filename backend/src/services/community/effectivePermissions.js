// What a member can actually do in a community.
//
// A member's permissions are the sum of the roles they hold, and then the
// overrides on the categories and channels they can see. So the honest
// answer to "what may this person do here?" has three parts:
//
//   - the roles they hold, because that is where the authority comes from;
//   - the permissions those roles give across the community;
//   - and the places where an override changes the answer, because that is
//     where the community has decided to be different from the default.
//
// The third part is the one a moderator actually needs. A person who may
// post everywhere except in the quiet channel is not a person who may post
// everywhere, and only the override tells the difference.
//
// The owner holds everything and is said so plainly, because a preview that
// listed no permissions for the owner would be a lie of omission.

'use strict';

const db = require('../../db');
const {
  PERMISSIONS, effectivePermissionsFor, effectiveChannelPermissions, isKnown,
} = require('../permissions');

/**
 * The names of the permissions, in the order they are shown.
 *
 * The order is the order they are explained in, so the preview reads as a
 * list of duties rather than an alphabet.
 */
function ordered(perms) {
  const names = Object.keys(PERMISSIONS);
  const known = names.filter((name) => perms.has(name));
  const unknown = [...perms].filter((name) => name !== '*' && !isKnown(name)).sort();
  return known.concat(unknown);
}

/**
 * The roles a member holds in a community.
 *
 * @param {string} serverId
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function rolesOf(serverId, userId) {
  return db.all(
    'SELECT r.id, r.name, r.color, r.permissions FROM member_roles mr '
    + 'JOIN roles r ON r.id = mr.role_id '
    + 'WHERE mr.server_id = ? AND mr.user_id = ? ORDER BY r.position, r.name',
    [serverId, userId]
  );
}

/**
 * What a member can do in a community.
 *
 * @param {object} server   the community row
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function preview(server, userId) {
  const serverId = server.id;
  const isOwner = server.owner_id === userId;

  const roleRows = await rolesOf(serverId, userId);
  const perms = await effectivePermissionsFor(server.owner_id, userId, serverId);

  // The roles, and what each one gives.
  const roles = roleRows.map((row) => {
    let held = [];
    try { held = JSON.parse(row.permissions) || []; } catch { held = []; }
    return {
      id: String(row.id),
      name: String(row.name),
      color: row.color || null,
      permissions: held.filter(isKnown),
    };
  });

  // Where an override changes the answer.
  //
  // A channel is interesting when the member's permissions there differ from
  // the community-wide ones - which is what an override does, and only that.
  const channels = await db.all(
    'SELECT id, name, category_id FROM channels WHERE server_id = ? ORDER BY position, name',
    [serverId]
  );
  const differences = [];
  for (const channel of channels) {
    const here = await effectiveChannelPermissions(
      server.owner_id, userId, serverId, channel.id
    );
    const changed = [];
    for (const name of Object.keys(PERMISSIONS)) {
      const wide = perms.has(name);
      const narrow = here.has(name);
      if (wide === narrow) continue;
      changed.push({ permission: name, effect: narrow ? 'allow' : 'deny' });
    }
    if (changed.length) {
      differences.push({
        channelId: String(channel.id),
        channelName: String(channel.name),
        categoryId: channel.category_id ? String(channel.category_id) : null,
        changed,
      });
    }
  }

  return {
    userId: String(userId),
    isOwner,
    roles,
    permissions: isOwner ? ['*'] : ordered(perms),
    // The places where the community has decided to be different.
    overrides: differences,
  };
}

module.exports = { preview, rolesOf, ordered };
