// Reading a conversation's messages.
//
// The contract mirrors the channel history exactly, and deliberately so: `seq` is the
// authoritative order, `after` walks forward for reconnect catch-up, `before` walks back
// and accepts either a seq or a legacy message id. Two surfaces with two pagination
// schemes means a client that understands one is broken on the other.
//
// The `before` anchor is resolved to a seq rather than compared on a (created_at, id)
// tuple, because the tuple is exactly what seq replaced: two rows can share a created_at,
// and comparing on it made the page boundary depend on which row the storage engine
// happened to return first.

const db = require('../../db');
const uploads = require('../uploads');
const threads = require('../threads');
const embeds = require('../embeds');
const { visibleConversation } = require('./conversation');

// Next canonical position within a conversation. The unique index on
// (conversation_id, seq) is the authority: if two writers race onto the same value, one
// insert loses with a constraint violation and retries against the new maximum, so an
// ambiguous order can never be written.
async function nextSeq(conversationId) {
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM dm_messages WHERE conversation_id = ?', [conversationId]);
  return (row ? Number(row.m) : 0) + 1;
}

// Resolve a legacy cursor (message id) to its seq, scoped so an id from another
// conversation cannot be used as an anchor here.
async function resolveSeq(conversationId, id) {
  const row = await db.get(
    'SELECT seq FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [id, conversationId]
  );
  if (!row || row.seq === null || row.seq === undefined) return null;
  return Number(row.seq);
}

const SELECT = `SELECT dm.*, u.username AS author_name, u.display_name AS author_display,
       u.avatar_url AS author_avatar, u.banner_url AS author_banner
  FROM dm_messages dm JOIN users u ON u.id = dm.author_id`;

async function history(userId, conversationId, { before = null, after = null, limit = 50 } = {}) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  let rows;
  let forward = false;
  if (after !== null && after !== undefined && after !== '') {
    forward = true;
    rows = await db.all(
      `${SELECT} WHERE dm.conversation_id = ? AND dm.seq > ? ORDER BY dm.seq ASC LIMIT ${lim}`,
      [conversationId, Math.max(parseInt(after, 10) || 0, 0)]
    );
  } else if (before) {
    const raw = String(before);
    const anchorSeq = /^\d+$/.test(raw) ? Number(raw) : await resolveSeq(conversationId, raw);
    if (anchorSeq === null) throw { code: 'NOT_FOUND', message: 'message not found' };
    rows = await db.all(
      `${SELECT} WHERE dm.conversation_id = ? AND dm.seq < ? ORDER BY dm.seq DESC LIMIT ${lim}`,
      [conversationId, anchorSeq]
    );
  } else {
    rows = await db.all(
      `${SELECT} WHERE dm.conversation_id = ? ORDER BY dm.seq DESC LIMIT ${lim}`,
      [conversationId]
    );
  }

  // Normalise to oldest-first for the client. Only the backward page arrives newest-first.
  if (!forward) rows.reverse();

  // One query each for the whole page: files, reply counts, previews.
  const ids = rows.map((m) => m.id);
  const [files, counts, cards] = await Promise.all([
    uploads.getForDmMessages(ids),
    threads.replyCounts('dm', conversationId, ids),
    // Previews are resolved after the fact, so this is where a reader who reloads picks
    // them up.
    embeds.listForMessages(ids, 'dm'),
  ]);

  return rows.map((m) => ({
    id: m.id,
    seq: m.seq === null || m.seq === undefined ? null : Number(m.seq),
    conversationId: m.conversation_id,
    content: m.content,
    createdAt: m.created_at,
    editedAt: m.edited_at || null,
    authorId: m.author_id,
    authorName: m.author_display || m.author_name,
    threadRootId: m.thread_root_id || null,
    replyCount: counts[m.id] || 0,
    attachments: files[m.id] || [],
    // Present and empty rather than absent: an arriving card needs a tray, and a missing
    // key is indistinguishable from a preview that never came.
    embeds: cards[m.id] || [],
  }));
}

module.exports = { nextSeq, resolveSeq, history };
