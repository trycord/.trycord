// The access rules the workspace shares.
//
// Two questions, asked the same way everywhere:
//
//   1. May this member take part in this channel?
//   2. May this member see this space?
//
// Both are answered with the community's own model. The channel question uses
// the channel-scoped permission evaluator - the same one the message routes
// use to decide whether somebody may post - and the space question uses the
// community's roles. There is no second permission system here: a space can
// narrow what a member sees, and it can never widen it.
const permissions = require('../permissions');
const roles = require('../roles');

// Whether this member may take part in a channel.
//
// The repository has exactly one channel-level access notion and it is the
// channel-scoped evaluator: a category or channel override narrows what the
// community's roles grant inside that channel. A member who may not post in a
// channel is not a participant in it, and a space that referenced it must not
// list it for them. The owner holds every permission, so the owner sees every
// channel.
async function canAccessChannel(userId, serverId, channelId) {
  if (!channelId) return false;
  return permissions.hasChannelPermission(userId, serverId, channelId, 'SEND_MESSAGES');
}

// Whether this member may see a space.
//
// A public space is visible to every member of the community. A private one
// is visible to the members holding the role it names, and to the owner. A
// private space with no role is the owner's alone: naming no role is not the
// same as naming every role.
async function canViewSpace(serverId, space, userId, isOwner) {
  if (!space || !space.is_private) return true;
  if (isOwner) return true;
  if (!space.required_role_id) return false;
  return roles.userHasRole(serverId, userId, space.required_role_id);
}

module.exports = { canAccessChannel, canViewSpace };
