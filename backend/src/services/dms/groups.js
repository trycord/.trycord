// Group conversations.
//
// A conversation of two people is identified by its pair key, and that is
// the whole of what it is. A conversation of more than two is a group: it has
// a name, its readers are its members, and the person who created it owns it.
//
// Ownership is not decoration. Without it, every member can rename the group,
// remove every other member, and there is nobody who can be held responsible
// for the result. The owner may hand the group on; an admin may rename it and
// remove ordinary members; a member may add people and leave.
//
// What a group is not: a channel. It has no moderation of its own beyond the
// conversation, and the people in it do not gain anything over each other
// outside it. It is a conversation with more than two people in it.

const db = require('../../db');
const { now, uuid } = require('../../util');
const privacy = require('../privacy');
const { memberIds } = require('./conversation');

// How many people a group holds.
//
// A conversation is a place two or three people talk in. A group of thirty is
// a channel, and a channel is a different thing with different rules.
const MAX_GROUP_MEMBERS = 12;

const ROLES = ['owner', 'admin', 'member'];

// What a role may do inside this conversation. The client uses these to hide a
// control it would be refused for; the service uses the same role check before
// every write, because a hidden control is not an authorization check.
function permissions(role, group) {
  const admin = role === 'owner' || role === 'admin';
  return {
    canRename: !!group && admin,
    canChangeAvatar: !!group && admin,
    canAddMembers: !!role && !!group,
    canRemoveMembers: !!group && admin,
    canPromoteMembers: !!group && role === 'owner',
    canTransferOwnership: !!group && role === 'owner',
    canLeave: !!role && !(group && role === 'owner'),
  };
}


async function userExists(id) {
  return !!(await db.get('SELECT id FROM users WHERE id = ?', [id]));
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    // The picture, and whether the person is a bot. The conversation list
    // draws a face beside every conversation, and a bot's face says it is a
    // bot.
    avatarUrl: row.avatar_url || null,
    isBot: !!row.is_bot,
    createdAt: row.created_at,
  };
}

// The name a group is shown by.
//
// A group with a name is shown by it. A group without one is shown by the
// people in it, because that is the only thing that says which conversation
// it is - and a name that nobody chose is worse than the truth.
function displayName(conv, members) {
  const named = conv && conv.name ? String(conv.name).trim() : '';
  if (named) return named;
  const people = members.filter(Boolean);
  if (!people.length) return 'A conversation';
  if (people.length === 1) return people[0].displayName || people[0].username;
  if (people.length === 2) {
    return (people[0].displayName || people[0].username) + ' and '
      + (people[1].displayName || people[1].username);
  }
  return (people[0].displayName || people[0].username) + ' and '
    + String(people.length - 1) + ' others';
}

// The members of a conversation, in the order they joined.
async function members(conversationId, t) {
  const q = t || db;
  const rows = await q.all(
    'SELECT u.id, u.username, u.display_name, u.created_at, u.avatar_url, u.is_bot, '
    + 'dm.joined_at, dm.role '
    + 'FROM dm_members dm JOIN users u ON u.id = dm.user_id '
    + 'WHERE dm.conversation_id = ? ORDER BY dm.joined_at ASC',
    [conversationId]
  );
  return rows.map((row) => Object.assign(publicUser(row), {
    joinedAt: row.joined_at,
    role: ROLES.includes(row.role) ? row.role : 'member',
  }));
}

// The role of one member, or null when they are not in the conversation.
async function roleOf(conversationId, userId, t) {
  const q = t || db;
  const row = await q.get(
    'SELECT role FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  return row ? (ROLES.includes(row.role) ? row.role : 'member') : null;
}

function requireAdmin(role) {
  if (role !== 'owner' && role !== 'admin') {
    throw { code: 'PERMISSION_DENIED', message: 'Only an owner or admin can do that.' };
  }
}

function requireOwner(role) {
  if (role !== 'owner') {
    throw { code: 'PERMISSION_DENIED', message: 'Only the owner can do that.' };
  }
}


// Whether a conversation is a group: more than two people in it.
function isGroup(conv, members) {
  if (conv && conv.name) return true;
  return members.length > 2;
}

// Create a conversation with more than two people in it.
//
// The people have to be able to open a conversation with the person who
// creates it: the same gate a one-to-one conversation goes through, so a
// group cannot be used to reach somebody who has said no.
async function createGroup(me, body) {
  const input = body || {};
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw { code: 'VALIDATION_ERROR', message: 'A group needs a name.' };

  const wanted = [];
  for (const id of Array.isArray(input.userIds) ? input.userIds : []) {
    const member = String(id || '').trim();
    if (!member) continue;
    if (member === String(me.id)) continue;
    if (wanted.indexOf(member) === -1) wanted.push(member);
  }
  if (!wanted.length) {
    throw { code: 'VALIDATION_ERROR', message: 'A group needs somebody else in it.' };
  }
  if (wanted.length + 1 > MAX_GROUP_MEMBERS) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'A group holds ' + MAX_GROUP_MEMBERS + ' people, including you.',
    };
  }

  for (const id of wanted) {
    if (!(await userExists(id))) {
      throw { code: 'NOT_FOUND', message: 'One of the people you named is not here.' };
    }
    const gate = await privacy.canOpenDm(me.id, id);
    if (!gate.allowed) {
      const error = new Error(gate.message);
      error.code = gate.code;
      throw error;
    }
  }

  const id = uuid();
  const ts = now();
  try {
    await db.transaction(async (t) => {
      // A group has no pair key: there is no pair to key it by, and the
      // column is unique, so a group must not pretend to have one.
      await t.run(
        'INSERT INTO dm_conversations (id, pair_key, name, owner_id, created_at, updated_at) '
        + 'VALUES (?, NULL, ?, ?, ?, ?)',
        [id, name, me.id, ts, ts]
      );
      await t.run(
        'INSERT INTO dm_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)',
        [id, me.id, 'owner', ts, ts]
      );
      for (const member of wanted) {
        await t.run(
          'INSERT INTO dm_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)',
          [id, member, 'member', ts, null]
        );
      }
    });
  } catch (error) {
    throw error;
  }

  return describe(id, me.id);
}

// The conversation, as a reader sees it.
//
// The one-to-one answer is unchanged - it still carries `peer` - and a group
// carries the members and the name as well. A client that does not know
// about groups keeps working.
async function describe(conversationId, readerId) {
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  if (!conv) return null;
  const people = await members(conversationId);
  const group = isGroup(conv, people);
  const others = people.filter((person) => String(person.id) !== String(readerId));
  const me = people.find((person) => String(person.id) === String(readerId));
  const myRole = me ? me.role : null;
  return {
    id: conv.id,
    name: conv.name || null,
    avatarUrl: conv.avatar_url || null,
    ownerId: conv.owner_id || null,
    isGroup: group,
    // The peer of a one-to-one conversation. A group has no single peer, and
    // says so rather than naming one of them.
    peer: group ? null : (others[0] || null),
    members: people,
    // The same people under the name the conversation-open endpoint uses. A
    // client that learns a group from creation, invitation or detail should
    // not need three field names for the same list.
    people,
    memberCount: people.length,
    displayName: displayName(conv, people),
    myRole,
    permissions: permissions(myRole, group),
  };
}

// Rename a group.
//
// The owner and admins may do this. A name is what the people in the
// conversation call it, but it is still a shared object; letting any member
// rename it turns the heading of the conversation into a prank surface.
async function rename(conversationId, readerId, name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'A group needs a name.' };
  const role = await roleOf(conversationId, readerId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  const people = await members(conversationId);
  if (!isGroup(conv, people)) {
    throw { code: 'VALIDATION_ERROR', message: 'Only a group can be renamed.' };
  }
  requireAdmin(role);
  await db.run('UPDATE dm_conversations SET name = ?, updated_at = ? WHERE id = ?',
    [clean, now(), conversationId]);
  return describe(conversationId, readerId);
}

// Change a group's picture. The image has already been stored by the upload
// service; this records the URL. Passing null removes it.
async function setAvatar(conversationId, readerId, avatarUrl) {
  const role = await roleOf(conversationId, readerId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  const people = await members(conversationId);
  if (!isGroup(conv, people)) {
    throw { code: 'VALIDATION_ERROR', message: 'Only a group can have a picture.' };
  }
  requireAdmin(role);
  await db.run('UPDATE dm_conversations SET avatar_url = ?, updated_at = ? WHERE id = ?',
    [avatarUrl || null, now(), conversationId]);
  return describe(conversationId, readerId);
}

async function avatar(conversationId) {
  const row = await db.get('SELECT avatar_url FROM dm_conversations WHERE id = ?', [conversationId]);
  return row ? (row.avatar_url || null) : null;
}

// Add somebody to a group.
//
// The same gate a one-to-one conversation goes through, so a group cannot be
// used to reach somebody who has said no.
async function addMember(conversationId, readerId, userId) {
  const wanted = String(userId || '').trim();
  if (!wanted) throw { code: 'VALIDATION_ERROR', message: 'Somebody has to be added.' };
  if (wanted === String(readerId)) {
    throw { code: 'VALIDATION_ERROR', message: 'You are already in it.' };
  }
  const role = await roleOf(conversationId, readerId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  const people = await members(conversationId);
  if (!isGroup(conv, people)) {
    throw { code: 'VALIDATION_ERROR', message: 'Only a group can have people added to it.' };
  }
  if (!(await userExists(wanted))) {
    throw { code: 'NOT_FOUND', message: 'That person is not here.' };
  }
  const present = await db.get(
    'SELECT 1 FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, wanted]
  );
  if (present) throw { code: 'CONFLICT', message: 'They are already in it.' };

  const current = await memberIds(conversationId);
  if (current.length >= MAX_GROUP_MEMBERS) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'A group holds ' + MAX_GROUP_MEMBERS + ' people, including you.',
    };
  }
  const gate = await privacy.canOpenDm(readerId, wanted);
  if (!gate.allowed) {
    const error = new Error(gate.message);
    error.code = gate.code;
    throw error;
  }
  try {
    await db.run(
      'INSERT INTO dm_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)',
      [conversationId, wanted, 'member', now(), null]
    );
  } catch (error) {
    // Two adds at once - a double tap on the button - raced the check above,
    // and the second insert was refused by the uniqueness that keeps one
    // membership per person. The membership the first one made is the
    // membership, so the answer is the same refusal a second add gives.
    if (db.isUniqueViolation(error)) {
      throw { code: 'CONFLICT', message: 'They are already in it.' };
    }
    throw error;
  }
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  return describe(conversationId, readerId);
}

// Take somebody out of a group.
//
// The last person cannot be taken out: a conversation with nobody in it is
// not a conversation, and the reader would be left with a row they cannot
// open. Removing yourself is leaving, and takes the same rule about the owner
// handing the group on first.
//
// An admin may remove ordinary members. The owner may remove anybody but
// themselves; an admin may not remove another admin, because two admins
// removing each other is a race with no correct winner.
async function removeMember(conversationId, readerId, userId) {
  const wanted = String(userId || '').trim();
  if (!wanted) throw { code: 'VALIDATION_ERROR', message: 'Somebody has to be removed.' };
  if (wanted === String(readerId)) return leave(conversationId, readerId);
  const role = await roleOf(conversationId, readerId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  const people = await members(conversationId);
  if (!isGroup(conv, people)) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'A conversation of two people cannot lose one of them.',
    };
  }
  const target = people.find((person) => String(person.id) === wanted);
  if (!target) throw { code: 'NOT_FOUND', message: 'They are not in it.' };
  // Removing one of the last two would leave a conversation with a single
  // person in it: not a conversation, and not a room anybody can answer in.
  // This is the same floor `leave` applies, enforced on the other door.
  if (people.length <= 2) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'A conversation of two people cannot lose one of them.',
    };
  }
  if (target.role === 'owner') {
    throw { code: 'PERMISSION_DENIED', message: 'The owner has to hand the group on first.' };
  }
  requireAdmin(role);
  if (target.role === 'admin' && role !== 'owner') {
    throw { code: 'PERMISSION_DENIED', message: 'Only the owner can remove an admin.' };
  }
  await db.run(
    'DELETE FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, wanted]
  );
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  return describe(conversationId, readerId);
}

// Leave a group.
//
// The owner cannot walk away from a group that still has people in it without
// first handing it on: an ownerless group has nobody who can remove a bad
// actor, and the instance has no admin who can step in on the group's behalf.
async function leave(conversationId, readerId) {
  const role = await roleOf(conversationId, readerId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const current = await memberIds(conversationId);
  if (current.length <= 2) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'A conversation of two people cannot lose one of them.',
    };
  }
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  const people = await members(conversationId);
  if (role === 'owner' && isGroup(conv, people)) {
    throw { code: 'OWNER_CANNOT_LEAVE', message: 'Hand the group to somebody else before leaving.' };
  }
  await db.run(
    'DELETE FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, readerId]
  );
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  return { ok: true, left: true };
}

// Promote or demote a member. Only the owner, and never the owner's own role.
async function setRole(conversationId, readerId, userId, value) {
  const wanted = String(userId || '').trim();
  const next = String(value || '').trim().toLowerCase();
  if (next !== 'admin' && next !== 'member') {
    throw { code: 'VALIDATION_ERROR', message: 'Role must be admin or member.' };
  }
  const role = await roleOf(conversationId, readerId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  const people = await members(conversationId);
  if (!isGroup(conv, people)) {
    throw { code: 'VALIDATION_ERROR', message: 'Only a group has roles.' };
  }
  requireOwner(role);
  const target = people.find((person) => String(person.id) === wanted);
  if (!target) throw { code: 'NOT_FOUND', message: 'They are not in it.' };
  if (target.role === 'owner') {
    throw { code: 'PERMISSION_DENIED', message: 'The owner cannot be demoted. Transfer the group instead.' };
  }
  if (wanted === String(readerId)) {
    throw { code: 'VALIDATION_ERROR', message: 'You cannot change your own role.' };
  }
  await db.run(
    'UPDATE dm_members SET role = ? WHERE conversation_id = ? AND user_id = ?',
    [next, conversationId, wanted]
  );
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  return { conversation: await describe(conversationId, readerId), userId: wanted, role: next };
}

// Hand the group on. The previous owner stays as an admin, because a group
// with no experienced hand in it is how a group dies.
async function transferOwnership(conversationId, readerId, userId) {
  const wanted = String(userId || '').trim();
  if (!wanted) throw { code: 'VALIDATION_ERROR', message: 'Somebody has to receive the group.' };
  const role = await roleOf(conversationId, readerId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  const people = await members(conversationId);
  if (!isGroup(conv, people)) {
    throw { code: 'VALIDATION_ERROR', message: 'Only a group can be handed on.' };
  }
  requireOwner(role);
  if (wanted === String(readerId)) {
    throw { code: 'VALIDATION_ERROR', message: 'You already own it.' };
  }
  const target = people.find((person) => String(person.id) === wanted);
  if (!target) throw { code: 'NOT_FOUND', message: 'They are not in it.' };
  await db.transaction(async (t) => {
    await t.run('UPDATE dm_conversations SET owner_id = ?, updated_at = ? WHERE id = ?',
      [wanted, now(), conversationId]);
    await t.run('UPDATE dm_members SET role = ? WHERE conversation_id = ? AND user_id = ?',
      ['admin', conversationId, readerId]);
    await t.run('UPDATE dm_members SET role = ? WHERE conversation_id = ? AND user_id = ?',
      ['owner', conversationId, wanted]);
  });
  return { conversation: await describe(conversationId, readerId), ownerId: wanted };
}

module.exports = {
  MAX_GROUP_MEMBERS,
  ROLES,
  members,
  roleOf,
  permissions,
  isGroup,
  displayName,
  describe,
  createGroup,
  rename,
  setAvatar,
  avatar,
  addMember,
  removeMember,
  leave,
  setRole,
  transferOwnership,
};
