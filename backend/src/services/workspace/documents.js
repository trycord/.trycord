// Collaborative documents.
//
// A document is a community-scoped page: a title and a body made of the same
// typed blocks the page editor stores (services/pageContent.js). The content
// model is reused whole - the vocabulary, the validation and the renderer all
// live in that one module - so a document can never carry raw HTML and a
// community document and an instance page are made of the same parts.
//
// What a document adds over a page is the collaborative behaviour:
//
//   - a revision per save, append-only, so the history is never rewritten
//   - conflict detection: a save states the revision it was written against,
//     and a save written against an older revision is refused rather than
//     silently overwriting somebody's work
//   - comments, anchored to a block
//   - links out of the document
const db = require('../../db');
const { now, uuid } = require('../../util');
const content = require('../pageContent');
// The word splitter is the one the message index uses, so a document is
// tokenised the same way a message is and the two indexes behave alike.
const searchIndex = require('../search-index');
const { fail, text, required, httpUrl, oneOf, conflict } = require('./common');

const MAX_TITLE = 128;
const COMMENT_MAX = 4000;
const LINK_KINDS = ['document', 'url'];

function parseBlocks(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shape(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    spaceId: row.space_id || null,
    title: row.title,
    body: parseBlocks(row.body),
    revision: Number(row.revision),
    authorId: row.author_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeRevision(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    revision: Number(row.revision),
    title: row.title,
    body: parseBlocks(row.body),
    authorId: row.author_id || null,
    createdAt: row.created_at,
  };
}

// The text of a body, for the search index. The blocks are the source of
// truth; this is only a reading of them.
function plainText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    if (Array.isArray(block.items)) parts.push(block.items.join(' '));
  }
  return parts.join(' ');
}

// Keep the index in step with the document. The old words go first, so an
// edit cannot leave a word behind that the document no longer contains.
async function indexDocument(documentId, serverId, title, blocks, createdAt) {
  await db.run('DELETE FROM document_search_words WHERE document_id = ?', [documentId]);
  const words = searchIndex.wordsOf(title + ' ' + plainText(blocks));
  for (const word of words) {
    await db.run(
      'INSERT INTO document_search_words (document_id, word, server_id, created_at) VALUES (?, ?, ?, ?)',
      [documentId, word, serverId, createdAt || now()]
    );
  }
}

async function get(serverId, documentId) {
  const row = await db.get('SELECT * FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  return row ? shape(row) : null;
}

async function list(serverId, { limit = 50, offset = 0 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = Math.max(Number(offset) || 0, 0);
  const rows = await db.all(
    'SELECT * FROM documents WHERE server_id = ? ORDER BY updated_at DESC, id DESC LIMIT ' + cap + ' OFFSET ' + skip,
    [serverId]
  );
  return rows.map(shape);
}

async function create(serverId, actorId, { title, body, spaceId }) {
  const name = required(title, MAX_TITLE, 'title');
  // normalise() is the page editor's own validator: it caps the block count,
  // rejects unknown block types and refuses a link target that is not http,
  // https, mailto or a path. A document therefore cannot be saved in a shape
  // the renderer does not understand. A body that is not a list of blocks is
  // refused rather than quietly turned into an empty document.
  const blocks = content.normalise(body === undefined || body === null ? [] : body);
  let space = null;
  if (spaceId) {
    space = await db.get('SELECT id FROM spaces WHERE id = ? AND server_id = ?', [spaceId, serverId]);
    if (!space) fail('NOT_FOUND', 'space not found in this community');
  }
  const id = uuid();
  const ts = now();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO documents (id, server_id, space_id, title, body, revision, author_id, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [id, serverId, space ? space.id : null, name, JSON.stringify(blocks), actorId, ts, ts]
    );
    await t.run(
      'INSERT INTO document_revisions (id, document_id, revision, title, body, author_id, created_at)'
      + ' VALUES (?, ?, 1, ?, ?, ?, ?)',
      [uuid(), id, name, JSON.stringify(blocks), actorId, ts]
    );
  });
  await indexDocument(id, serverId, name, blocks, ts);
  return get(serverId, id);
}

// A save.
//
// The caller states the revision it was written against. The stored revision
// is the authority: the update only lands when the row still carries that
// revision, so two people saving the same document produce one save and one
// conflict, and the loser is told what the current revision is rather than
// losing their work silently.
//
// `overwrite` is the deliberate way past the check: the client has shown the
// author what the current revision is and the author has chosen to replace
// it. It is never implied.
async function save(serverId, documentId, actorId, { title, body, revision, overwrite }) {
  const row = await db.get('SELECT * FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!row) fail('NOT_FOUND', 'document not found');
  const current = Number(row.revision);
  const submitted = Number(revision);
  if (!Number.isInteger(submitted) || submitted < 1) {
    fail('VALIDATION_ERROR', 'a save must state the revision it was written against');
  }
  if (submitted !== current && overwrite !== true) {
    throw conflict('this document changed since you loaded it', {
      currentRevision: current,
      submittedRevision: submitted,
      currentTitle: row.title,
      currentUpdatedAt: row.updated_at,
    });
  }
  const name = title === undefined ? row.title : required(title, MAX_TITLE, 'title');
  const blocks = body === undefined
    ? parseBlocks(row.body)
    : content.normalise(body === undefined || body === null ? [] : body);
  const bodyJson = JSON.stringify(blocks);
  const next = current + 1;
  const ts = now();
  await db.transaction(async (t) => {
    const res = await t.run(
      'UPDATE documents SET title = ?, body = ?, revision = ?, author_id = ?, updated_at = ?'
      + ' WHERE id = ? AND revision = ?',
      [name, bodyJson, next, actorId, ts, row.id, current]
    );
    // The guard is here as well as in the check above: the row may have been
    // written by somebody else between the read and this statement.
    if (res.changes !== 1) {
      const latest = await t.get('SELECT revision FROM documents WHERE id = ?', [row.id]);
      throw conflict('this document changed since you loaded it', {
        currentRevision: latest ? Number(latest.revision) : current,
        submittedRevision: submitted,
      });
    }
    await t.run(
      'INSERT INTO document_revisions (id, document_id, revision, title, body, author_id, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), row.id, next, name, bodyJson, actorId, ts]
    );
  });
  await indexDocument(row.id, serverId, name, blocks, ts);
  return get(serverId, row.id);
}

async function revisions(serverId, documentId, limit = 50) {
  const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!doc) fail('NOT_FOUND', 'document not found');
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await db.all(
    'SELECT * FROM document_revisions WHERE document_id = ? ORDER BY revision DESC LIMIT ' + cap,
    [doc.id]
  );
  return rows.map(shapeRevision);
}

async function revision(serverId, documentId, number) {
  const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!doc) fail('NOT_FOUND', 'document not found');
  const row = await db.get(
    'SELECT * FROM document_revisions WHERE document_id = ? AND revision = ?',
    [doc.id, Number(number)]
  );
  if (!row) fail('NOT_FOUND', 'revision not found');
  return shapeRevision(row);
}

// Two revisions, side by side, with the blocks that differ.
//
// The comparison is over the block list: a block that is only in one of them
// is added or removed, a block that is in both but not equal is changed. That
// is the honest comparison for a body made of blocks - a diff over characters
// would talk about a paragraph that was reworded rather than about the block
// that changed.
async function compare(serverId, documentId, from, to) {
  const a = await revision(serverId, documentId, from);
  const b = await revision(serverId, documentId, to);
  const changes = [];
  const length = Math.max(a.body.length, b.body.length);
  for (let i = 0; i < length; i++) {
    const before = a.body[i] === undefined ? null : a.body[i];
    const after = b.body[i] === undefined ? null : b.body[i];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({
      index: i,
      change: before === null ? 'added' : after === null ? 'removed' : 'changed',
      before,
      after,
    });
  }
  return {
    documentId,
    from: { revision: a.revision, title: a.title, authorId: a.authorId, createdAt: a.createdAt },
    to: { revision: b.revision, title: b.title, authorId: b.authorId, createdAt: b.createdAt },
    titleChanged: a.title !== b.title,
    changes,
  };
}

// Restore an earlier revision.
//
// The restored body is appended as a new revision, exactly like a save. The
// revision being restored stays in the history: what the document looked like
// at every point is still true, and the restore is one more point on that
// line.
async function restore(serverId, documentId, actorId, number) {
  const row = await db.get('SELECT * FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!row) fail('NOT_FOUND', 'document not found');
  const source = await db.get(
    'SELECT * FROM document_revisions WHERE document_id = ? AND revision = ?',
    [row.id, Number(number)]
  );
  if (!source) fail('NOT_FOUND', 'revision not found');
  const current = Number(row.revision);
  const next = current + 1;
  const ts = now();
  await db.transaction(async (t) => {
    const res = await t.run(
      'UPDATE documents SET title = ?, body = ?, revision = ?, author_id = ?, updated_at = ?'
      + ' WHERE id = ? AND revision = ?',
      [source.title, source.body, next, actorId, ts, row.id, current]
    );
    if (res.changes !== 1) {
      const latest = await t.get('SELECT revision FROM documents WHERE id = ?', [row.id]);
      throw conflict('this document changed since you loaded it', {
        currentRevision: latest ? Number(latest.revision) : current,
        submittedRevision: current,
      });
    }
    await t.run(
      'INSERT INTO document_revisions (id, document_id, revision, title, body, author_id, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), row.id, next, source.title, source.body, actorId, ts]
    );
  });
  await indexDocument(row.id, serverId, source.title, parseBlocks(source.body), ts);
  return get(serverId, row.id);
}

// ---- comments ---------------------------------------------------------

function shapeComment(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    authorId: row.author_id,
    blockId: row.block_id || null,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
    resolvedBy: row.resolved_by || null,
  };
}

async function comments(serverId, documentId) {
  const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!doc) fail('NOT_FOUND', 'document not found');
  const rows = await db.all(
    'SELECT * FROM document_comments WHERE document_id = ? ORDER BY created_at ASC, id ASC',
    [doc.id]
  );
  return rows.map(shapeComment);
}

// A comment is anchored to a block when the editor says which one. The block
// is not looked up: the editor owns the block ids of the body it is showing,
// and a comment that outlives the block it was about is still a comment.
async function comment(serverId, documentId, actorId, { body, blockId }) {
  const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!doc) fail('NOT_FOUND', 'document not found');
  const message = required(body, COMMENT_MAX, 'body');
  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO document_comments (id, document_id, server_id, author_id, block_id, body, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, doc.id, serverId, actorId, text(blockId, 64, 'blockId') || null, message, ts, ts]
  );
  const row = await db.get('SELECT * FROM document_comments WHERE id = ?', [id]);
  return shapeComment(row);
}

async function resolveComment(serverId, documentId, commentId, actorId, resolved) {
  const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!doc) fail('NOT_FOUND', 'document not found');
  const row = await db.get(
    'SELECT * FROM document_comments WHERE id = ? AND document_id = ?',
    [commentId, doc.id]
  );
  if (!row) fail('NOT_FOUND', 'comment not found');
  const ts = now();
  await db.run(
    'UPDATE document_comments SET resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?',
    [resolved === false ? null : ts, resolved === false ? null : actorId, ts, row.id]
  );
  const after = await db.get('SELECT * FROM document_comments WHERE id = ?', [row.id]);
  return shapeComment(after);
}

// ---- links ------------------------------------------------------------

function shapeLink(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    kind: row.kind,
    targetId: row.target_id || null,
    url: row.url || null,
    label: row.label || '',
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function links(serverId, documentId) {
  const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!doc) fail('NOT_FOUND', 'document not found');
  const rows = await db.all(
    'SELECT * FROM document_links WHERE document_id = ? ORDER BY created_at ASC, id ASC',
    [doc.id]
  );
  return rows.map(shapeLink);
}

// A link is either to another document in this community or to a URL the
// member opens themselves. A URL is stored and handed back; the server never
// fetches it, embeds it or proxies it.
async function addLink(serverId, documentId, actorId, { kind, targetId, url, label }) {
  const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [documentId, serverId]);
  if (!doc) fail('NOT_FOUND', 'document not found');
  const linkKind = oneOf(kind, LINK_KINDS, 'kind');
  let target = null;
  let href = null;
  if (linkKind === 'document') {
    target = String(targetId || '').trim();
    if (!target) fail('VALIDATION_ERROR', 'targetId is required for a document link');
    const other = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [target, serverId]);
    if (!other) fail('NOT_FOUND', 'document not found in this community');
  } else {
    href = httpUrl(url);
  }
  const id = uuid();
  await db.run(
    'INSERT INTO document_links (id, document_id, server_id, kind, target_id, url, label, created_by, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, doc.id, serverId, linkKind, target, href, text(label, 255, 'label'), actorId, now()]
  );
  const row = await db.get('SELECT * FROM document_links WHERE id = ?', [id]);
  return shapeLink(row);
}

// ---- search -----------------------------------------------------------

// Find documents by their words.
//
// The same rule the message index uses: every word in the query has to be
// present, so "two words" means both rather than either, and the result is
// ordered by how many of them matched and then by recency.
async function search(serverId, query, limit = 25) {
  const terms = searchIndex.wordsOf(query);
  if (!terms.length) return [];
  const cap = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const placeholders = terms.map(() => '?').join(', ');
  const hits = await db.all(
    'SELECT document_id, COUNT(DISTINCT word) AS matched FROM document_search_words'
    + ' WHERE word IN (' + placeholders + ') AND server_id = ?'
    + ' GROUP BY document_id HAVING COUNT(DISTINCT word) = ?',
    terms.concat([serverId, terms.length])
  );
  if (!hits.length) return [];
  const ids = hits.map((h) => h.document_id);
  const rows = await db.all(
    'SELECT * FROM documents WHERE id IN (' + ids.map(() => '?').join(', ') + ')'
    + ' ORDER BY updated_at DESC, id DESC',
    ids
  );
  const matched = new Map(hits.map((h) => [h.document_id, Number(h.matched)]));
  return rows.map((row) => Object.assign(shape(row), { matchedWords: matched.get(row.id) || 0 }));
}

module.exports = {
  create, get, list, save, revisions, revision, compare, restore,
  comments, comment, resolveComment,
  links, addLink,
  search,
};
