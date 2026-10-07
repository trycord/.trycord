// Changing a message that is already there, and marking a conversation read.
//
// Edit is author-only with no revision history: edited_at marks the latest revision,
// matching the channel-message model. A full history table would be a different product.
//
// The three functions share a shape on purpose - check membership, load the row, check
// authorship, act - and that shape is written out three times rather than abstracted. The
// middle step differs (one row versus a read position), and a helper that took a callback
// to hide that would be harder to read than the repetition.

const db = require('../../db');
const { now } = require('../../util');
const uploads = require('../uploads');
const { visibleConversation } = require('./conversation');
const { assertLength } = require('./limits');

async function edit(userId, conversationId, messageId, content, username) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const msg = await db.get(
    'SELECT * FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  );
  if (!msg) throw { code: 'NOT_FOUND', message: 'message not found' };
  if (msg.author_id !== userId) throw { code: 'PERMISSION_DENIED', message: 'only the author can edit' };
  const text = String(content === null || content === undefined ? '' : content).trim();
  if (!text) throw { code: 'VALIDATION_ERROR', message: 'message is empty' };
  assertLength(text);

  const editedAt = now();
  await db.run('UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?', [text, editedAt, msg.id]);
  return {
    id: msg.id,
    conversationId,
    content: text,
    createdAt: msg.created_at,
    editedAt,
    authorId: userId,
    authorName: username,
  };
}

// Hard delete, author only - same model as channel messages.
async function remove(userId, conversationId, messageId) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const msg = await db.get(
    'SELECT * FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  );
  if (!msg) throw { code: 'NOT_FOUND', message: 'message not found' };
  if (msg.author_id !== userId) throw { code: 'PERMISSION_DENIED', message: 'cannot delete this message' };

  // The rows go with the message by cascade; the objects on disk do not, so they are
  // named before the delete.
  const files = await uploads.getForDmMessage(msg.id);
  // As in a channel: the replies stay, and become ordinary messages again.
  await db.run('UPDATE dm_messages SET thread_root_id = NULL WHERE thread_root_id = ?', [msg.id]);
  await db.run('DELETE FROM dm_messages WHERE id = ?', [msg.id]);
  await uploads.removeFiles(files.map((f) => ({
    id: f.id,
    channel_id: null,
    dm_conversation_id: conversationId,
  })));
  return { id: msg.id, conversationId };
}

// Viewing the conversation drives read state, never the list load - so opening the DM
// list does not mark everything read behind the reader's back.
async function markRead(userId, conversationId) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const ts = now();
  await db.run(
    'UPDATE dm_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?',
    [ts, conversationId, userId]
  );
  return { conversationId, lastReadAt: ts };
}

module.exports = { edit, remove, markRead };
