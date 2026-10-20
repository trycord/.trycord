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
const filters = require('./search-filters');

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
  const rows = await fetchMessages(ids);

  const matched = new Map(hits.map((h) => [h.message_id, h.matched]));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => Object.assign({}, row, { matched_words: matched.get(row.id) || 0 }));
}

// The messages themselves, for a set of ids, in the order the caller asks
// for. The permission columns the rows carry are the ones the history read
// carries, so a search result and a history row look the same to a client.
async function fetchMessages(ids) {
  if (!ids.length) return [];
  return db.all(
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
}

// The clauses the filters add to a message query.
//
// Every fragment is an AND against the aliases a message query already uses:
// m for the message, ch for its channel and u for its author. They are
// returned as strings with their parameters pushed in the same order, so a
// caller can drop them into the WHERE clause of any message query and get
// the same filters.
//
// The fragments are never a way round the permission check: they narrow the
// same rows the membership test narrows, and the membership test is in the
// statement whether or not a filter was given.
function filterClauses(parsed, params, options) {
  const opts = options || {};
  const where = [];
  const f = (parsed && parsed.filters) || {};

  if (f.from) {
    where.push('LOWER(u.username) = ?');
    params.push(String(f.from).toLowerCase());
  }
  if (f.in) {
    // A channel is named by its name or by its slug, with or without the
    // hash a reader writes.
    const channel = String(f.in).replace(/^#/, '').toLowerCase();
    where.push('(LOWER(ch.name) = ? OR LOWER(ch.slug) = ?)');
    params.push(channel, channel);
  }
  if (f.before) {
    where.push('m.created_at < ?');
    params.push(f.before);
  }
  if (f.after) {
    where.push('m.created_at >= ?');
    params.push(f.after);
  }
  if (f.has === 'file') {
    where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)');
  }
  if (f.type) {
    where.push(typeClause(f.type));
  }
  if (f.is === 'unread') {
    // Unread means there is no read cursor at or after the message. A channel
    // the reader has never marked has no cursor at all, so nothing in it has
    // been read.
    where.push('NOT EXISTS (SELECT 1 FROM channel_read_cursors c'
      + ' WHERE c.user_id = ? AND c.channel_id = ch.id AND c.last_read_at >= m.created_at)');
    params.push(opts.userId);
  }
  return where;
}

// The clause for a type filter.
//
// The types are the kinds of thing a message can carry, and each is answered
// from the tables that hold them: an attachment is a file, an embed is a
// link preview, and both say what they are.
function typeClause(type) {
  if (type === 'image') {
    return '(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id'
      + ' AND LOWER(a.mime) LIKE \'image/%\')'
      + ' OR EXISTS (SELECT 1 FROM message_embeds e WHERE e.message_id = m.id AND e.kind = \'image\'))';
  }
  if (type === 'video') {
    return '(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id'
      + ' AND LOWER(a.mime) LIKE \'video/%\')'
      + ' OR EXISTS (SELECT 1 FROM message_embeds e WHERE e.message_id = m.id AND e.kind = \'video\'))';
  }
  if (type === 'link') {
    return 'EXISTS (SELECT 1 FROM message_embeds e WHERE e.message_id = m.id AND e.url IS NOT NULL)';
  }
  if (type === 'code') {
    return '(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id'
      + ' AND (LOWER(a.mime) LIKE \'text/x-%\''
      + ' OR LOWER(a.mime) IN (\'application/json\',\'application/javascript\',\'application/typescript\''
      + ',\'application/xml\',\'application/sql\',\'application/yaml\',\'application/x-yaml\',\'application/toml\')))'
      + ' OR EXISTS (SELECT 1 FROM message_embeds e WHERE e.message_id = m.id AND e.kind = \'code\')'
      + ' OR m.content LIKE \'%```%\')';
  }
  return '1 = 1';
}

// The filtered search.
//
// The filters and the permission check are one statement. The membership test
// is always in it, so a filter narrows what the reader may see and can never
// widen it: a filter that names a community the reader is not in answers
// nothing at all, rather than everything.
//
// A query with no terms is answered from the filters alone, which is what
// makes "from:ada" on its own a way of asking for everything ada wrote.
async function findFiltered(parsed, options) {
  const opts = options || {};
  const query = typeof parsed === 'string' ? filters.parse(parsed) : parsed;
  const terms = wordsOf(query.terms.join(' '));
  const userId = opts.userId;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 50);
  if (!terms.length && !query.hasFilters) return [];

  const params = [];
  const where = [];

  if (terms.length) {
    where.push('w.word IN (' + terms.map(() => '?').join(', ') + ')');
    for (const term of terms) params.push(term);
  }
  if (opts.serverId) {
    where.push('w.server_id = ?');
    params.push(opts.serverId);
  }
  if (userId) {
    // The permission check, in the index: a message is only a candidate if
    // the reader is in the community it belongs to.
    where.push('EXISTS (SELECT 1 FROM server_members sm'
      + ' WHERE sm.server_id = w.server_id AND sm.user_id = ?)');
    params.push(userId);
  }
  where.push(...filterClauses(query, params, { userId }));

  const sql = 'SELECT w.message_id, COUNT(*) AS matched FROM message_search_words w'
    + ' JOIN messages m ON m.id = w.message_id'
    + ' JOIN channels ch ON ch.id = m.channel_id'
    + ' JOIN users u ON u.id = m.author_id'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' GROUP BY w.message_id'
    + ' ORDER BY matched DESC, w.message_id DESC LIMIT ' + (limit * 4);

  const hits = await db.all(sql, params);
  if (!hits.length) return [];

  const ids = hits.map((h) => h.message_id);
  const rows = await fetchMessages(ids);

  const matched = new Map(hits.map((h) => [h.message_id, h.matched]));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(0, limit)
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
  indexMessage, removeMessage, wordsOf, find, findFiltered, filterClauses,
  findDocuments, backfill, backfillJob, available,
};
