// Pinned messages in a direct conversation.
//
// A channel's pins live in pinned_messages, keyed by channel. A conversation is
// not a channel, and pretending it has one so that a row can be reused is how a
// foreign key starts pointing at the wrong table. This is the same idea with the
// right key: a conversation, a message that is in it, and who pinned it.
//
// Anybody in the conversation may pin and unpin. A pin is not a moderation
// action; it is the group deciding which message is worth keeping at hand.

const db = require('../../db');
const { now, escapeLike } = require('../../util');
const uploads = require('../uploads');
const e2ee = require('../e2ee');
const { visibleConversation } = require('./conversation');

async function memberOrThrow(conversationId, userId) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'Conversation not found' };
  return seen;
}

async function list(userId, conversationId) {
  await memberOrThrow(conversationId, userId);
  const rows = await db.all(
    `SELECT p.pinned_at, p.pinned_by,
            dm.id, dm.conversation_id, dm.seq, dm.content, dm.created_at, dm.edited_at, dm.thread_root_id,
            u.username AS author_name, u.display_name AS author_display, u.avatar_url AS author_avatar,
            pu.username AS pinner_name, pu.display_name AS pinner_display
     FROM dm_pins p
     JOIN dm_messages dm ON dm.id = p.message_id
     JOIN users u ON u.id = dm.author_id
     LEFT JOIN users pu ON pu.id = p.pinned_by
     WHERE p.conversation_id = ?
     ORDER BY p.pinned_at DESC`,
    [conversationId]
  );
  const files = await uploads.getForDmMessages(rows.map((r) => r.id));
  return rows.map((row) => {
    const stored = e2ee.readMessageBody(row.content);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
      content: stored.content,
      encrypted: stored.encrypted,
      envelopes: stored.envelopes,
      createdAt: row.created_at,
      editedAt: row.edited_at || null,
      authorId: row.author_id,
      authorName: row.author_display || row.author_name,
      threadRootId: row.thread_root_id || null,
      attachments: files[row.id] || [],
      pinnedAt: row.pinned_at,
      pinnedBy: row.pinned_by,
      pinnedByName: row.pinner_display || row.pinner_name || null,
    };
  });
}

async function add(userId, conversationId, messageId) {
  await memberOrThrow(conversationId, userId);
  const id = String(messageId || '').trim();
  if (!id) throw { code: 'VALIDATION_ERROR', message: 'A message has to be named.' };
  const message = await db.get(
    'SELECT id FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [id, conversationId]
  );
  if (!message) throw { code: 'NOT_FOUND', message: 'Message not found' };
  const ts = now();
  try {
    await db.run(
      'INSERT INTO dm_pins (conversation_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)',
      [conversationId, id, userId, ts]
    );
  } catch (error) {
    // Pinning twice is the same pin, not an error the reader has to resolve.
    if (db.isUniqueViolation(error)) {
      const existing = await db.get(
        'SELECT pinned_at, pinned_by FROM dm_pins WHERE conversation_id = ? AND message_id = ?',
        [conversationId, id]
      );
      return { pinned: true, alreadyPinned: true, messageId: id, pinnedAt: existing && existing.pinned_at, pinnedBy: existing && existing.pinned_by };
    }
    throw error;
  }
  return { pinned: true, alreadyPinned: false, messageId: id, pinnedAt: ts, pinnedBy: userId };
}

async function remove(userId, conversationId, messageId) {
  await memberOrThrow(conversationId, userId);
  const id = String(messageId || '').trim();
  const row = await db.get(
    'SELECT 1 FROM dm_pins WHERE conversation_id = ? AND message_id = ?',
    [conversationId, id]
  );
  if (!row) throw { code: 'NOT_FOUND', message: 'That message is not pinned.' };
  await db.run('DELETE FROM dm_pins WHERE conversation_id = ? AND message_id = ?', [conversationId, id]);
  return { pinned: false, messageId: id };
}

// Search inside one conversation.
//
// The server can only search what it can read. An encrypted conversation holds
// envelopes, so the result says that rather than pretending a ciphertext match
// is a message the reader wrote. The client that holds the keys can search its
// local copy; this route is for the plaintext conversations and for the
// metadata around them.
async function search(userId, conversationId, query, limit) {
  await memberOrThrow(conversationId, userId);
  const q = String(query || '').trim();
  if (q.length < 2) throw { code: 'VALIDATION_ERROR', message: 'Type at least 2 characters to search.' };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const lit = escapeLike(q.slice(0, 100));
  const rows = await db.all(
    `SELECT dm.*, u.username AS author_name, u.display_name AS author_display,
            u.avatar_url AS author_avatar, u.is_bot AS author_is_bot
     FROM dm_messages dm JOIN users u ON u.id = dm.author_id
     WHERE dm.conversation_id = ? AND dm.content LIKE ? ESCAPE '!'
     ORDER BY dm.seq DESC LIMIT ${lim}`,
    [conversationId, `%${lit}%`]
  );
  return rows
    .map((row) => {
      const stored = e2ee.readMessageBody(row.content);
      if (stored.encrypted) return null;
      return {
        id: row.id,
        seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
        conversationId: row.conversation_id,
        content: stored.content,
        createdAt: row.created_at,
        editedAt: row.edited_at || null,
        authorId: row.author_id,
        authorName: row.author_display || row.author_name,
        authorAvatarUrl: row.author_avatar || null,
      };
    })
    .filter(Boolean);
}

module.exports = { list, add, remove, search };
