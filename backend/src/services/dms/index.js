// Direct-message conversations: transactional get-or-create with a canonical
// participant-pair key (so Alice↔Bob is always exactly one conversation),
// cursor-paginated history, persistent read positions, author-only delete.
// All multi-row flows run inside db.transaction (works on SQLite + MySQL).
//
// This file is the composition root. The modules under ./dms/ each answer one question:
//
//   conversation.js  what is a conversation, and who is in it
//   history.js       reading messages, and the canonical positions they page on
//   send.js          writing one
//   manage.js        editing, deleting, and marking read
//   list.js          the conversation list, and opening one conversation
//   groups.js        conversations of more than two people
//   invites.js       asking somebody to join one of those conversations
//   pins.js          messages kept at hand, and searching inside a conversation
//   limits.js        how long a message may be

const conversation = require('./conversation');
const history = require('./history');
const send = require('./send');
const manage = require('./manage');
const list = require('./list');
const groups = require('./groups');
const invites = require('./invites');
const pins = require('./pins');
const limits = require('./limits');

module.exports = {
  pairKey: conversation.pairKey,
  visibleConversation: conversation.visibleConversation,
  memberIds: conversation.memberIds,
  getOrCreate: conversation.getOrCreate,
  listMine: list.listMine,
  history: history.history,
  send: send.send,
  edit: manage.edit,
  remove: manage.remove,
  markRead: manage.markRead,
  detail: list.detail,
  // The conversations of more than two people.
  createGroup: groups.createGroup,
  renameGroup: groups.rename,
  setGroupAvatar: groups.setAvatar,
  groupAvatar: groups.avatar,
  addGroupMember: groups.addMember,
  removeGroupMember: groups.removeMember,
  leaveGroup: groups.leave,
  groupMembers: groups.members,
  groupRole: groups.roleOf,
  groupPermissions: groups.permissions,
  setGroupRole: groups.setRole,
  transferGroupOwnership: groups.transferOwnership,
  MAX_GROUP_MEMBERS: groups.MAX_GROUP_MEMBERS,
  // Invitations to a group.
  inviteToGroup: invites.invite,
  groupInvites: invites.listFor,
  acceptGroupInvite: invites.accept,
  declineGroupInvite: invites.decline,
  cancelGroupInvite: invites.cancel,
  // Pins and in-conversation search.
  listPins: pins.list,
  addPin: pins.add,
  removePin: pins.remove,
  searchMessages: pins.search,
  MAX_CONTENT: limits.MAX_CONTENT,
};
