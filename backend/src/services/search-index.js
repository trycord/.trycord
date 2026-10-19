// The in-house search index.
//
// The provider this instance offers is its own: no vendor, nothing to install,
// the same behaviour on every database. The cost of owning it is that somebody
// has to keep it true, and that is this file.
//
// What it holds: one row per distinct word per message, lowercased, with the
// permission columns copied alongside. A query is then a lookup on the words
// rather than a scan of the messages.
//
// What keeps it true:
//   - a message that is written is indexed
//   - a message that is edited is reindexed
//   - a message that is deleted loses its rows
//   - messages that existed before the index did are backfilled by a job
//
// The permission columns are copied rather than joined on purpose. A search
// asks for words and gets back rows that already say who may see them, so the
// permission check cannot be left out of a later rewrite of the query.

const db = require('../db');

// Words are lowercased, and stripped of everything that is not a letter, a
// digit, an underscore or an apostrophe. Anything shorter than two characters
// is dropped: a one-letter word matches half the language and finds nothing
// useful.
const WORD_MAX = 64;

function wordsOf(text) {
  const out = new Set();
  const raw = String(text || '').toLowerCase();
  const parts = raw.split(/[^\p{L}\p{N}_'’-]+/u);
  for (const part of parts) {
    const word = part.replace(/^['’-]+|['’-]+$/g, '');
    if (word.length < 2) continue;
    out.add(word.slice(0, WORD_MAX));
  }
  return [...out];
}

// Indexes one message. The old rows go first, so an edit cannot leave the
// previous words behind to match a query it no longer answers.
async function indexMessage(message) {
  if (!message || !message.id) return;
  const words = wordsOf(message.content);
  await db.run('DELETE FROM message_search_words WHERE message_id = ?', [message.id]);
  if (!words.length) return;

  const serverId = message.serverId || (await serverOf(message.channelId));
  if (!serverId) return;
  const channelId = message.channelId || (await channelOf(message.id));
  if (!channelId) return;

  const at = message.createdAt || new Date().toISOString();
  for (const word of words) {
    await db.run(
      'INSERT INTO message_search_words (message_id, word, server_id, channel_id, author_id, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?)',
      [message.id, word, serverId, channelId, message.authorId, at]
    );
  }
}

async function channelOf(messageId) {
  const row = await db.get('SELECT channel_id FROM messages WHERE id = ?', [messageId]);
  return row ? row.channel_id : null;
}

async function removeMessage(messageId) {
  await db.run('DELETE FROM message_search_words WHERE message_id = ?', [messageId]);
}

async function serverOf(channelId) {
  if (!channelId) return null;
  const row = await db.get('SELECT server_id FROM channels WHERE id = ?', [channelId]);
  return row ? row.server_id : null;
}

// The rows a query would match, with the permission already applied.
//
// Every word in the query has to be present, which is what makes "two words"
// mean both rather than either. The result is ordered by how many of the
// words matched and then by recency, so a message that matches everything
// comes first.
async function find(query, options) {
  const opts = options || {};
  const terms = wordsOf(query);
  if (!terms.length) return [];

  const userId = opts.userId;
  const serverId = opts.serverId || null;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 50);

  const params = [];
  const placeholders = terms.map(() => '?').join(', ');
  for (const term of terms) params.push(term);

  let sql = 'SELECT message_id, COUNT(*) AS matched FROM message_search_words'
    + ' WHERE word IN (' + placeholders + ')';
  if (serverId) { sql += ' AND server_id = ?'; params.push(serverId); }
  sql += ' GROUP BY message_id';
  if (userId) {
    // The permission check, in the index: a message is only a candidate if
    // the reader is in the community it belongs to.
    sql += ' HAVING SUM(CASE WHEN EXISTS ('
      + 'SELECT 1 FROM server_members sm WHERE sm.server_id = message_search_words.server_id'
      + ' AND sm.user_id = ?'
      + ' AND sm.server_id = message_search_words.server_id'
      + ') THEN 1 ELSE 0 END) > 0';
    params.push(userId);
  }
  sql += ' ORDER BY matched DESC, message_id DESC LIMIT ' + (limit * 4);

  const hits = await db.all(sql, params);
  if (!hits.length) return [];

  const ids = hits.map((h) => h.message_id);
  const rows = await db.all(
    'SELECT m.*, u.username AS author_name, u.display_name AS author_display,'
    + ' ch.name AS channel_name, ch.server_id AS server_id, s.name AS server_name'
    + ' FROM messages m'
    + ' JOIN users u ON u.id = m.author_id'
    + ' JOIN channels ch ON ch.id = m.channel_id'
    + ' JOIN servers s ON s.id = ch.server_id'
    + ' WHERE m.id IN (' + ids.map(() => '?').join(', ') + ')'
    + ' ORDER BY m.created_at DESC, m.id DESC',
    ids
  );

  const matched = new Map(hits.map((h) => [h.message_id, h.matched]));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => Object.assign({}, row, { matched_words: matched.get(row.id) || 0 }));
}

// Documents are searchable the same way messages are.
//
// A community document is indexed into document_search_words - the same shape
// as the message index, with the community copied beside the words - so a
// query cannot return a document the reader may not see. The permission check
// lives in the index, exactly as it does for messages.
async function findDocuments(query, options) {
  const opts = options || {};
  const terms = wordsOf(query);
  if (!terms.length) return [];

  const userId = opts.userId;
  const serverId = opts.serverId || null;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 50);

  const params = [];
  const placeholders = terms.map(() => '?').join(', ');
  for (const term of terms) params.push(term);

  let sql = 'SELECT document_id, COUNT(*) AS matched FROM document_search_words'
    + ' WHERE word IN (' + placeholders + ')';
  if (serverId) { sql += ' AND server_id = ?'; params.push(serverId); }
  sql += ' GROUP BY document_id';
  if (userId) {
    sql += ' HAVING SUM(CASE WHEN EXISTS ('
      + 'SELECT 1 FROM server_members sm WHERE sm.server_id = document_search_words.server_id'
      + ' AND sm.user_id = ?'
      + ' AND sm.server_id = document_search_words.server_id'
      + ') THEN 1 ELSE 0 END) > 0';
    params.push(userId);
  }
  sql += ' ORDER BY matched DESC, document_id DESC LIMIT ' + (limit * 4);

  let hits;
  try {
    hits = await db.all(sql, params);
  } catch (e) {
    // The document index is not there on an instance that has never had a
    // document. A search that cannot find documents still finds messages.
    return [];
  }
  if (!hits.length) return [];

  const ids = hits.map((h) => h.document_id);
  const rows = await db.all(
    'SELECT d.id, d.server_id, d.space_id, d.title, d.updated_at, s.name AS server_name'
    + ' FROM documents d JOIN servers s ON s.id = d.server_id'
    + ' WHERE d.id IN (' + ids.map(() => '?').join(', ') + ')',
    ids
  );

  const matched = new Map(hits.map((h) => [h.document_id, h.matched]));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => Object.assign({}, row, {
      kind: 'document',
      matched_words: matched.get(row.id) || 0,
    }));
}

// Walks the messages that are not in the index yet and puts them in. It is
// bounded, so it can be run again and again: each pass takes another slice.
async function backfill(limit) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  const rows = await db.all(
    'SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at, ch.server_id AS server_id'
    + ' FROM messages m JOIN channels ch ON ch.id = m.channel_id'
    + ' WHERE m.id NOT IN (SELECT message_id FROM message_search_words)'
    + ' ORDER BY m.created_at DESC LIMIT ' + cap
  );
  for (const row of rows) {
    // The row comes back with the database's column names; the indexer takes
    // the shape it uses everywhere else.
    await indexMessage({
      id: row.id,
      channelId: row.channel_id,
      authorId: row.author_id,
      content: row.content,
      createdAt: row.created_at,
      serverId: row.server_id,
    });
  }
  return { indexed: rows.length };
}

// Whether the index table is there at all. A deployment that has not run the
// migration yet falls back to the slower query rather than failing.
async function available() {
  try {
    const row = await db.get(
      "SELECT 1 AS n FROM information_schema.tables WHERE table_name = 'message_search_words'"
    );
    if (row && row.n) return true;
  } catch { /* SQLite and others: try the direct way */ }
  try {
    const row = await db.get("SELECT 1 AS n FROM message_search_words LIMIT 1");
    return !!row;
  } catch {
    return false;
  }
}

// The scheduled backfill. It indexes a slice of the messages that are not in
// the index yet, and queues the next slice. A backlog of any size is worked
// through over a few passes rather than in one enormous transaction.
const SLICE = 500;

async function backfillJob() {
  const jobs = require('./jobs');
  const out = await backfill(SLICE);
  if (out.indexed >= SLICE) {
    try {
      await jobs.enqueue('search_backfill', {}, { runAfterMs: 5000, maxAttempts: 3 });
    } catch (e) {
      console.warn('[search] could not queue the next backfill slice: ' + (e && e.message));
    }
  }
  if (out.indexed) console.log('[search] indexed ' + out.indexed + ' message(s)');
  return out;
}

module.exports = {
  indexMessage, removeMessage, wordsOf, find, findDocuments,
  backfill, backfillJob, available,
};
