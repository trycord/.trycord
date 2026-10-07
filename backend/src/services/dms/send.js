// Sending a direct message.
//
// Three things make this more than an insert, and each has bitten before:
//
//   Idempotency. A client that retries a submission carries the same nonce and gets the
//   row the first attempt already wrote. Scoped to the conversation and never compared
//   against content, so two genuinely identical messages are still two messages.
//
//   Position. The row is written with a canonical seq, retrying on the rare race where a
//   concurrent writer claimed the same one. The insert and the conversation's
//   updated_at bump are one transaction, so a conversation can never be re-sorted to the
//   top by a message that then failed to save.
//
//   Attachments. Adopted after the insert, exactly as the channel path does: an id that
//   is not this uploader's own pending upload in this conversation does not match, so it
//   is ignored rather than attached.

const db = require('../../db');
const { now, uuid } = require('../../util');
const uploads = require('../uploads');
const threads = require('../threads');
const { visibleConversation } = require('./conversation');
const { assertLength } = require('./limits');
const { nextSeq } = require('./history');

const DEDUPE_SELECT = `SELECT dm.*, u.username AS author_name, u.display_name AS author_display
  FROM dm_messages dm JOIN users u ON u.id = dm.author_id`;

async function send(userId, username, conversationId, content, clientNonce = null, attachmentIds = [], replyToId = null) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };

  const text = String((content === null || content === undefined) ? '' : content).trim();
  const ids = uploads.sanitizeIds(attachmentIds);
  // A file on its own is a message. Requiring text here meant a picture could not be sent
  // in a DM at all.
  if (!text && !ids.length) throw { code: 'VALIDATION_ERROR', message: 'message is empty' };

  // A reply to something that is not in this conversation is refused rather than quietly
  // posted flat.
  const threadRootId = await threads.resolveRoot('dm', conversationId, replyToId);
  assertLength(text);

  const nonce = String(clientNonce || '').trim().slice(0, 64) || null;

  if (nonce) {
    const existing = await db.get(
      DEDUPE_SELECT + ' WHERE dm.conversation_id = ? AND dm.client_nonce = ?',
      [conversationId, nonce]
    );
    if (existing) {
      return {
        id: existing.id,
        seq: existing.seq === null || existing.seq === undefined ? null : Number(existing.seq),
        conversationId: existing.conversation_id,
        content: existing.content,
        createdAt: existing.created_at,
        editedAt: null,
        authorId: existing.author_id,
        authorName: username,
        threadRootId: existing.thread_root_id || null,
        attachments: await uploads.getForDmMessage(existing.id),
        deduped: true,
      };
    }
  }

  const msg = {
    id: uuid(), conversation_id: conversationId, author_id: userId,
    content: text, created_at: now(), thread_root_id: threadRootId,
  };

  let inserted = false;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const seq = await nextSeq(conversationId);
    try {
      await db.transaction(async (t) => {
        await t.run(
          'INSERT INTO dm_messages (id, conversation_id, author_id, content, created_at, seq, client_nonce, thread_root_id)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [msg.id, msg.conversation_id, msg.author_id, msg.content, msg.created_at, seq, nonce, threadRootId]
        );
        await t.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [msg.created_at, conversationId]);
      });
      msg.seq = seq;
      inserted = true;
    } catch (e) {
      const dup = /unique/i.test(String(e && e.message)) || (e && e.code === 'SQLITE_CONSTRAINT');
      if (!dup || attempt === 4) throw e;
      // A unique violation on the nonce means a concurrent duplicate won, so the message
      // does exist - it just is not ours to create twice.
      if (nonce) {
        const again = await db.get(
          'SELECT id, seq FROM dm_messages WHERE conversation_id = ? AND client_nonce = ?',
          [conversationId, nonce]
        );
        if (again) { msg.id = again.id; msg.seq = again.seq; inserted = true; }
      }
    }
  }
  if (!inserted) throw { code: 'CONFLICT', message: 'could not assign a message position, please retry' };

  const attachments = await uploads.attachToMessage(ids, msg.id, userId, { conversationId });

  return {
    id: msg.id,
    seq: msg.seq,
    conversationId: msg.conversation_id,
    content: msg.content,
    createdAt: msg.created_at,
    editedAt: null,
    authorId: userId,
    authorName: username,
    threadRootId,
    attachments,
  };
}

module.exports = { send };
