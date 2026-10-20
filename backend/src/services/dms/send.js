// Sending a direct message.
//
// Four things make this more than an insert, and each has bitten before:
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
//
//   Encryption. In a conversation that is encrypted the body is an envelope and the row
//   holds the envelope; in one that is not, it is text and the row holds the text. Which
//   of the two applies is the status service's answer, never the client's.

const db = require('../../db');
const { now, uuid } = require('../../util');
const uploads = require('../uploads');
const threads = require('../threads');
const e2ee = require('../e2ee');
const { visibleConversation } = require('./conversation');
const { assertLength } = require('./limits');
const { nextSeq } = require('./history');

const DEDUPE_SELECT = `SELECT dm.*, u.username AS author_name, u.display_name AS author_display
  FROM dm_messages dm JOIN users u ON u.id = dm.author_id`;

async function send(userId, username, conversationId, body) {
  const input = body || {};
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'Conversation not found' };

  // A message in an encrypted conversation is an envelope. The text is never
  // read and never stored: the client encrypted it and the server holds no
  // key that opens it.
  const carriesEnvelopes = input.envelopes !== undefined && input.envelopes !== null;
  const text = carriesEnvelopes
    ? ''
    : String((input.content === null || input.content === undefined) ? '' : input.content).trim();
  const ids = uploads.sanitizeIds(input.attachmentIds);
  // A file on its own is a message. Requiring text here meant a picture could not be sent
  // in a DM at all.
  if (!text && !ids.length && !carriesEnvelopes) throw { code: 'VALIDATION_ERROR', message: 'Message is empty' };

  // A reply to something that is not in this conversation is refused rather than quietly
  // posted flat.
  const threadRootId = await threads.resolveRoot('dm', conversationId, input.replyToId);
  if (!carriesEnvelopes) assertLength(text);

  const nonce = String(input.clientNonce || '').trim().slice(0, 64) || null;

  if (nonce) {
    const existing = await db.get(
      DEDUPE_SELECT + ' WHERE dm.conversation_id = ? AND dm.client_nonce = ? AND dm.author_id = ?',
      [conversationId, nonce, userId]
    );
    if (existing) {
      const stored = e2ee.readMessageBody(existing.content);
      return {
        id: existing.id,
        seq: existing.seq === null || existing.seq === undefined ? null : Number(existing.seq),
        conversationId: existing.conversation_id,
        content: stored.content,
        encrypted: stored.encrypted,
        envelopes: stored.envelopes,
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

  // Whether this conversation is encrypted is the status service's answer. A
  // body the server cannot validate is refused, and nothing is stored.
  const accepted = await e2ee.acceptMessageBody(userId, conversationId, {
    content: text,
    envelopes: input.envelopes,
    attachmentIds: ids,
  });

  const msg = {
    id: uuid(), conversation_id: conversationId, author_id: userId,
    content: accepted.stored, created_at: now(), thread_root_id: threadRootId,
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
  if (!inserted) throw { code: 'CONFLICT', message: 'Could not assign a message position, please retry' };

  const attachments = await uploads.attachToMessage(ids, msg.id, userId, { conversationId });

  return {
    id: msg.id,
    seq: msg.seq,
    conversationId: msg.conversation_id,
    // The text of a message that is not encrypted, and nothing at all for
    // one that is: the client reads the envelope.
    content: accepted.content,
    encrypted: accepted.encrypted,
    envelopes: accepted.envelopes,
    // What is true about this conversation's encryption, so that a client can
    // say it rather than guess.
    encryption: accepted.encryption,
    createdAt: msg.created_at,
    editedAt: null,
    authorId: userId,
    authorName: username,
    threadRootId,
    attachments,
  };
}

module.exports = { send };
