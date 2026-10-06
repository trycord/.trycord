// Replies.
//
// A thread is flat: a reply names the message it hangs from, and a reply to a
// reply joins the same thread rather than nesting. That is a deliberate limit -
// nesting needs a depth rule, a collapsed-state model and a tree to render, and
// nobody has asked for it. It also means the root is simply the message nobody
// replied to, so there is no self-reference to get wrong and no second table.
//
// Channels and direct messages are the same problem over two tables that differ
// only in the column naming the scope, so they are described once here rather
// than written twice.

const db = require('../db');
const uploads = require('./uploads');

const SCOPES = {
  channel: { table: 'messages', scope: 'channel_id', author: 'author_id' },
  dm: { table: 'dm_messages', scope: 'conversation_id', author: 'author_id' },
};

function shape(m, attachments) {
  return {
    id: m.id,
    seq: m.seq === null || m.seq === undefined ? null : Number(m.seq),
    content: m.content,
    createdAt: m.created_at,
    editedAt: m.edited_at || null,
    authorId: m.author_id,
    authorName: m.author_name || m.author_display || null,
    threadRootId: m.thread_root_id || null,
    replyCount: m.reply_count === null || m.reply_count === undefined ? 0 : Number(m.reply_count),
    attachments: attachments || [],
  };
}

// The id a reply to `messageId` should be filed under, or null when this is not
// a reply. Throws rather than returning null for a target that does not exist or
// is not in this scope: silently dropping it would post the reply with no visible
// parent, which looks like the app lost the message.
//
// The reader is not passed because scope membership is the check - a channel id
// in the path has already been permission-checked by the caller, and a
// conversation id has already been membership-checked.
async function resolveRoot(kind, scopeId, messageId) {
  if (!messageId) return null;
  const s = SCOPES[kind];
  const target = await db.get(
    `SELECT id, thread_root_id FROM ${s.table} WHERE id = ? AND ${s.scope} = ?`,
    [String(messageId), scopeId]
  );
  if (!target) {
    const e = new Error('the message being replied to does not exist here');
    e.code = 'NOT_FOUND';
    throw e;
  }
  // Replying to a reply joins its thread.
  return target.thread_root_id || target.id;
}

// root + its replies, oldest first. One query for the replies and one for their
// files, so a thread costs the same whatever its size.
async function fetch(kind, scopeId, rootId) {
  const s = SCOPES[kind];
  const root = await db.get(
    `SELECT m.*, u.username AS author_name, u.display_name AS author_display
     FROM ${s.table} m JOIN users u ON u.id = m.${s.author}
     WHERE m.id = ? AND m.${s.scope} = ?`,
    [rootId, scopeId]
  );
  if (!root) {
    const e = new Error('thread not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const replies = await db.all(
    `SELECT m.*, u.username AS author_name, u.display_name AS author_display
     FROM ${s.table} m JOIN users u ON u.id = m.${s.author}
     WHERE m.thread_root_id = ? AND m.${s.scope} = ?
     ORDER BY m.seq ASC`,
    [rootId, scopeId]
  );
  const ids = replies.map((r) => r.id);
  const files = kind === 'dm' ? await uploads.getForDmMessages(ids) : await uploads.getForMessages(ids);
  const rootFiles = kind === 'dm' ? await uploads.getForDmMessage(root.id) : await uploads.getForMessage(root.id);
  return {
    root: shape(root, rootFiles),
    replies: replies.map((r) => shape(r, files[r.id] || [])),
  };
}

// rootId -> reply count, for the badges on a page of history. One grouped query
// rather than a count per message, which is the difference between a history page
// that loads and one that does not.
async function replyCounts(kind, scopeId, rootIds) {
  const ids = (rootIds || []).filter(Boolean).slice(0, 250);
  if (!ids.length) return {};
  const s = SCOPES[kind];
  const rows = await db.all(
    `SELECT thread_root_id, COUNT(*) AS n FROM ${s.table}
     WHERE thread_root_id IN (${ids.map(() => '?').join(',')}) AND ${s.scope} = ?
     GROUP BY thread_root_id`,
    ids.concat([scopeId])
  );
  const map = {};
  for (const r of rows) map[r.thread_root_id] = Number(r.n);
  return map;
}

module.exports = { resolveRoot, fetch, replyCounts, shape };
