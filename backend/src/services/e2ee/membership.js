// Who is in a conversation.
//
// The E2EE subsystem has to answer "which devices should hold this
// conversation's key", and the answer is the conversation's membership. That
// membership already exists - a direct conversation has its members, a
// community channel has the community's members - so this module reads it
// rather than keeping a second copy that could disagree with the first.
//
// It reads the messaging tables and writes nothing. A conversation it does
// not recognise has no membership it can vouch for, and the caller is told
// so rather than being handed an empty list that would look like a
// conversation with nobody in it.

'use strict';

const db = require('../../db');
const { protocolError } = require('./envelope');

/**
 * The members of a conversation.
 *
 * @param {string} conversationId
 * @returns {Promise<{kind: string, userIds: string[]}>}
 */
async function members(conversationId) {
  const dm = await db.get('SELECT id FROM dm_conversations WHERE id = ?', [conversationId]);
  if (dm) {
    const rows = await db.all('SELECT user_id FROM dm_members WHERE conversation_id = ?', [conversationId]);
    return { kind: 'dm', userIds: rows.map((r) => r.user_id) };
  }
  const channel = await db.get('SELECT id, server_id FROM channels WHERE id = ?', [conversationId]);
  if (channel) {
    const rows = await db.all('SELECT user_id FROM server_members WHERE server_id = ?', [channel.server_id]);
    return { kind: 'channel', userIds: rows.map((r) => r.user_id) };
  }
  return null;
}

/**
 * The members of a conversation, or a refusal.
 *
 * @param {string} conversationId
 * @param {string} userId the caller
 * @returns {Promise<{kind: string, userIds: string[]}>}
 */
async function requireMembership(conversationId, userId) {
  const found = await members(conversationId);
  if (!found) {
    throw protocolError('E2EE_NOT_FOUND', 'no such conversation', 404);
  }
  if (!found.userIds.includes(userId)) {
    throw protocolError('E2EE_FORBIDDEN', 'you are not in this conversation', 403);
  }
  return found;
}

module.exports = { members, requireMembership };
