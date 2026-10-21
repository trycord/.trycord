// Group conversations.
//
// A conversation of two people is identified by its pair key, and that is
// the whole of what it is. A conversation of more than two is a group: it has
// a name, its readers are its members, and anybody in it may add somebody or
// take somebody out.
//
// The table could always hold a group - `dm_members` has one row per
// person - and nothing could create one. This is that.
//
// What a group is not: a channel. It has no roles, no permissions and no
// moderation of its own, and the people in it do not gain anything over
// each other. It is a conversation with more than two people in it.

const db = require('../../db');
const { now, uuid } = require('../../util');
const privacy = require('../privacy');
const { memberIds } = require('./conversation');

// How many people a group holds.
//
// A conversation is a place two or three people talk in. A group of thirty is
// a channel, and a channel is a different thing with different rules.
const MAX_GROUP_MEMBERS = 12;

async function userExists(id) {
  return !!(await db.get('SELECT id FROM users WHERE id = ?', [id]));
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
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
  const others = members.filter((member) => String(member.id) !== String(conv && conv.owner_id));
  if (!others.length) return 'A conversation';
  if (others.length === 1) return others[0].displayName || others[0].username;
  if (others.length === 2) {
    return (others[0].displayName || others[0].username) + ' and '
      + (others[1].displayName || others[1].username);
  }
  return (others[0].displayName || others[0].username) + ' and '
    + String(others.length - 1) + ' others';
}

// The members of a conversation, in the order they joined.
async function members(conversationId, t) {
  const q = t || db;
  const rows = await q.all(
    'SELECT u.id, u.username, u.display_name, u.created_at, dm.joined_at '
    + 'FROM dm_members dm JOIN users u ON u.id = dm.user_id '
    + 'WHERE dm.conversation_id = ? ORDER BY dm.joined_at ASC',
    [conversationId]
  );
  return rows.map((row) => Object.assign(publicUser(row), { joinedAt: row.joined_at }));
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
        'INSERT INTO dm_conversations (id, pair_key, name, created_at, updated_at) '
        + 'VALUES (?, NULL, ?, ?, ?)',
        [id, name, ts, ts]
      );
      await t.run(
        'INSERT INTO dm_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
        [id, me.id, ts, ts]
      );
      for (const member of wanted) {
        await t.run(
          'INSERT INTO dm_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
          [id, member, ts, null]
        );
      }
    });
  } catch (error) {
    throw error;
  }

  return {
    id,
    name,
    members: await members(id),
    isGroup: true,
  };
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
  return {
    id: conv.id,
    name: conv.name || null,
    isGroup: group,
    // The peer of a one-to-one conversation. A group has no single peer, and
    // says so rather than naming one of them.
    peer: group ? null : (others[0] || null),
    members: people,
    memberCount: people.length,
    displayName: displayName(conv, people),
  };
}

// Rename a group.
//
// Anybody in it may do this: a name is what the people in the conversation
// call it, and it is not a setting of the instance.
async function rename(conversationId, readerId, name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'A group needs a name.' };
  const found = await db.get(
    'SELECT 1 FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, readerId]
  );
  if (!found) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  await db.run('UPDATE dm_conversations SET name = ?, updated_at = ? WHERE id = ?',
    [clean, now(), conversationId]);
  return describe(conversationId, readerId);
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
  const found = await db.get(
    'SELECT 1 FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, readerId]
  );
  if (!found) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
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
  await db.run(
    'INSERT INTO dm_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
    [conversationId, wanted, now(), null]
  );
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  return describe(conversationId, readerId);
}

// Take somebody out of a group.
//
// The last person cannot be taken out: a conversation with nobody in it is
// not a conversation, and the reader would be left with a row they cannot
// open.
async function removeMember(conversationId, readerId, userId) {
  const wanted = String(userId || '').trim();
  const present = await db.get(
    'SELECT 1 FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, readerId]
  );
  if (!present) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const current = await memberIds(conversationId);
  if (current.length <= 2) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'A conversation of two people cannot lose one of them.',
    };
  }
  await db.run(
    'DELETE FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, wanted]
  );
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  return describe(conversationId, readerId);
}

// Leave a group.
async function leave(conversationId, readerId) {
  const current = await memberIds(conversationId);
  if (current.length <= 2) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'A conversation of two people cannot lose one of them.',
    };
  }
  await db.run(
    'DELETE FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, readerId]
  );
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  return { ok: true, left: true };
}

module.exports = {
  MAX_GROUP_MEMBERS,
  members,
  isGroup,
  displayName,
  describe,
  createGroup,
  rename,
  addMember,
  removeMember,
  leave,
};
