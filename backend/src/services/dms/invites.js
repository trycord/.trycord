// Invitations to a group conversation.
//
// A direct add is a fact: the person is in the group before they see it. An
// invitation is a question, and it has to be answerable - including no. The two
// exist beside each other because both are legitimate: adding somebody you are
// already talking to is not the same act as asking somebody who has not agreed
// to be in a room with nine other people.
//
// The same gate as a one-to-one conversation still applies when the invitation
// is sent: a group cannot be used to reach somebody who has said no to being
// contacted.

const db = require('../../db');
const { now, uuid } = require('../../util');
const privacy = require('../privacy');
const groups = require('./groups');

const STATUSES = ['pending', 'accepted', 'declined', 'cancelled'];

async function userExists(id) {
  return !!(await db.get('SELECT id FROM users WHERE id = ?', [id]));
}

function shape(row, extra) {
  const more = extra || {};
  return {
    id: row.id,
    conversationId: row.conversation_id,
    inviterId: row.inviter_id,
    inviteeId: row.invitee_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: more.name || null,
    displayName: more.displayName || null,
    memberCount: more.memberCount || 0,
    inviter: more.inviter || null,
  };
}

async function groupOrThrow(conversationId) {
  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  if (!conv) throw { code: 'NOT_FOUND', message: 'Conversation not found' };
  const people = await groups.members(conversationId);
  if (!groups.isGroup(conv, people)) {
    throw { code: 'VALIDATION_ERROR', message: 'Only a group can be invited to.' };
  }
  return { conv, people };
}

// Send an invitation. Re-inviting after a decline revives the same row rather
// than creating a second question about the same person and group.
async function invite(conversationId, inviterId, inviteeId) {
  const wanted = String(inviteeId || '').trim();
  if (!wanted) throw { code: 'VALIDATION_ERROR', message: 'Somebody has to be invited.' };
  if (wanted === String(inviterId)) throw { code: 'VALIDATION_ERROR', message: 'You are already in it.' };
  const role = await groups.roleOf(conversationId, inviterId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const { conv, people } = await groupOrThrow(conversationId);
  if (!(await userExists(wanted))) throw { code: 'NOT_FOUND', message: 'That person is not here.' };
  if (people.some((p) => String(p.id) === wanted)) {
    throw { code: 'CONFLICT', message: 'They are already in it.' };
  }
  if (people.length >= groups.MAX_GROUP_MEMBERS) {
    throw { code: 'VALIDATION_ERROR', message: 'That group is full.' };
  }
  const gate = await privacy.canOpenDm(inviterId, wanted);
  if (!gate.allowed) {
    const error = new Error(gate.message);
    error.code = gate.code;
    throw error;
  }

  const existing = await db.get(
    'SELECT * FROM dm_invites WHERE conversation_id = ? AND invitee_id = ?',
    [conversationId, wanted]
  );
  const ts = now();
  if (existing && existing.status === 'pending') {
    throw { code: 'CONFLICT', message: 'They have already been invited.' };
  }
  if (existing) {
    await db.run(
      "UPDATE dm_invites SET inviter_id = ?, status = 'pending', created_at = ?, updated_at = ? WHERE id = ?",
      [inviterId, ts, ts, existing.id]
    );
    return shape(
      { id: existing.id, conversation_id: conversationId, inviter_id: inviterId, invitee_id: wanted, status: 'pending', created_at: ts, updated_at: ts },
      { name: conv.name, displayName: groups.displayName(conv, people), memberCount: people.length }
    );
  }
  const id = uuid();
  try {
    await db.run(
      `INSERT INTO dm_invites (id, conversation_id, inviter_id, invitee_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, conversationId, inviterId, wanted, ts, ts]
    );
  } catch (error) {
    if (db.isUniqueViolation(error)) {
      throw { code: 'CONFLICT', message: 'They have already been invited.' };
    }
    throw error;
  }
  return shape(
    { id, conversation_id: conversationId, inviter_id: inviterId, invitee_id: wanted, status: 'pending', created_at: ts, updated_at: ts },
    { name: conv.name, displayName: groups.displayName(conv, people), memberCount: people.length }
  );
}

// The invitations waiting for this account, with enough context to decide:
// the group's name, who asked, and how many people are already in it.
async function listFor(userId) {
  const rows = await db.all(
    `SELECT i.*, c.name AS conv_name, c.owner_id AS conv_owner,
            u.username AS inviter_name, u.display_name AS inviter_display, u.avatar_url AS inviter_avatar
     FROM dm_invites i
     JOIN dm_conversations c ON c.id = i.conversation_id
     JOIN users u ON u.id = i.inviter_id
     WHERE i.invitee_id = ? AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
    [userId]
  );
  const out = [];
  for (const row of rows) {
    const people = await groups.members(row.conversation_id);
    // The group may have shrunk to two people since the invitation was sent.
    // Then it is no longer a group, and the invitation is no longer a question
    // anybody can answer.
    if (!groups.isGroup({ name: row.conv_name, owner_id: row.conv_owner }, people)) continue;
    out.push(shape(row, {
      name: row.conv_name,
      displayName: groups.displayName({ name: row.conv_name, owner_id: row.conv_owner }, people),
      memberCount: people.length,
      inviter: {
        id: row.inviter_id,
        username: row.inviter_name,
        displayName: row.inviter_display,
        avatarUrl: row.inviter_avatar || null,
      },
    }));
  }
  return out;
}

async function pendingFor(userId, inviteId) {
  const row = await db.get('SELECT * FROM dm_invites WHERE id = ?', [inviteId]);
  if (!row || row.status !== 'pending') throw { code: 'NOT_FOUND', message: 'Invitation not found' };
  if (String(row.invitee_id) !== String(userId)) {
    throw { code: 'PERMISSION_DENIED', message: 'Only the invited person can answer.' };
  }
  return row;
}

// Accept. Joining is a membership insert inside the same transaction that
// marks the invitation answered, so a crash between them cannot leave an
// accepted invitation with no membership.
async function accept(userId, inviteId) {
  const row = await pendingFor(userId, inviteId);
  const { conv, people } = await groupOrThrow(row.conversation_id);
  if (!people.some((p) => String(p.id) === String(userId))) {
    if (people.length >= groups.MAX_GROUP_MEMBERS) {
      throw { code: 'VALIDATION_ERROR', message: 'That group is full.' };
    }
    try {
      await db.transaction(async (t) => {
        await t.run(
          'INSERT INTO dm_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)',
          [row.conversation_id, userId, 'member', now(), null]
        );
        await t.run(
          "UPDATE dm_invites SET status = 'accepted', updated_at = ? WHERE id = ?",
          [now(), row.id]
        );
        await t.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [now(), row.conversation_id]);
      });
    } catch (error) {
      if (!db.isUniqueViolation(error)) throw error;
      // Somebody added them at the same moment. They are in; the invitation is
      // answered the same way.
      await db.run("UPDATE dm_invites SET status = 'accepted', updated_at = ? WHERE id = ?", [now(), row.id]);
    }
  } else {
    await db.run("UPDATE dm_invites SET status = 'accepted', updated_at = ? WHERE id = ?", [now(), row.id]);
  }
  const after = await groups.members(row.conversation_id);
  return {
    invitation: shape(Object.assign({}, row, { status: 'accepted' }), {
      name: conv.name,
      displayName: groups.displayName(conv, after),
      memberCount: after.length,
    }),
    conversation: await groups.describe(row.conversation_id, userId),
  };
}

async function decline(userId, inviteId) {
  const row = await pendingFor(userId, inviteId);
  await db.run("UPDATE dm_invites SET status = 'declined', updated_at = ? WHERE id = ?", [now(), row.id]);
  return { id: row.id, status: 'declined', inviterId: row.inviter_id, conversationId: row.conversation_id };
}

// The sender may take an invitation back, and so may whoever runs the group:
// an owner or admin has to be able to stop an invitation that should not have
// been sent.
async function cancel(conversationId, userId, inviteId) {
  const row = await db.get(
    'SELECT * FROM dm_invites WHERE id = ? AND conversation_id = ?',
    [inviteId, conversationId]
  );
  if (!row) throw { code: 'NOT_FOUND', message: 'Invitation not found' };
  const role = await groups.roleOf(conversationId, userId);
  if (!role) throw { code: 'NOT_FOUND', message: 'That conversation is not here.' };
  const allowed = String(row.inviter_id) === String(userId) || role === 'owner' || role === 'admin';
  if (!allowed) throw { code: 'PERMISSION_DENIED', message: 'You cannot cancel this invitation.' };
  if (row.status === 'pending') {
    await db.run("UPDATE dm_invites SET status = 'cancelled', updated_at = ? WHERE id = ?", [now(), row.id]);
  }
  return { id: row.id, status: 'cancelled', inviteeId: row.invitee_id, conversationId: row.conversation_id };
}

module.exports = { STATUSES, invite, listFor, accept, decline, cancel };
