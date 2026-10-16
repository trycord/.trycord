// Community Memory: curated knowledge entries that outlive chat history.
//
// A community's authorized members can create, edit, and read entries. Each
// entry links back to the source message it was distilled from, preserving
// provenance and authorship. Revisions are append-only: editing creates a new
// revision row, so nothing is ever silently overwritten.
//
// Entries are scoped to a single server. Access is gated on server membership:
// any member of the community may read entries; only members with the
// MEMORIZE permission may create, edit, or delete them.
const db = require('../db');
const { now, uuid } = require('../util');
const enforcement = require('./enforcement');

const MEMORY_STATUSES = ['published', 'archived'];

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('entry not found');
  e.code = 'NOT_FOUND';
  throw e;
}

function parse(body) {
  try {
    return JSON.parse(body || '[]');
  } catch {
    return [];
  }
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    channelId: row.channel_id,
    title: row.title,
    body: row.body,
    authorId: row.author_id,
    sourceMessageId: row.source_message_id,
    revisionCount: row.revision_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ensureRow(serverId, id) {
  const row = await db.get('SELECT * FROM community_memory_entries WHERE id = ? AND server_id = ?', [id, serverId]);
  if (!row) notFound();
  return row;
}

async function list(serverId) {
  const rows = await db.all(
    'SELECT * FROM community_memory_entries WHERE server_id = ? ORDER BY updated_at DESC',
    [serverId]
  );
  return rows.map(toPublic);
}

async function get(serverId, id) {
  return toPublic(await ensureRow(serverId, id));
}

async function create({ serverId, actorId, title, body, channelId, sourceMessageId }) {
  if (!title || !String(title).trim()) bad('title required', 'VALIDATION_ERROR');
  if (!body || !String(body).trim()) bad('body required', 'VALIDATION_ERROR');

  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO community_memory_entries (id, server_id, channel_id, title, body, author_id, source_message_id, revision_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, serverId, channelId || null, String(title).trim().slice(0, 255), String(body).trim(), actorId, sourceMessageId || null, 1, 'published', ts, ts]
  );
  await enforcement.audit(actorId, 'COMMUNITY_MEMORY_CREATE', 'community_memory_entry', id, null);
  return get(serverId, id);
}

async function update({ serverId, actorId, id, title, body }) {
  const row = await ensureRow(serverId, id);
  const sets = [];
  const vals = [];

  if (title !== undefined) {
    if (!String(title).trim()) bad('title required', 'VALIDATION_ERROR');
    sets.push('title = ?');
    vals.push(String(title).trim().slice(0, 255));
  }
  if (body !== undefined) {
    if (!String(body).trim()) bad('body required', 'VALIDATION_ERROR');
    sets.push('body = ?');
    vals.push(String(body).trim());
  }

  if (!sets.length) throw { code: 'VALIDATION_ERROR', message: 'nothing to update' };

  const ts = now();
  const rev = await nextRevision(id);
  await db.transaction(async (t) => {
    await t.run(
      'UPDATE community_memory_entries SET ' + sets.join(', ') + ', updated_at = ?, revision_count = revision_count + 1 WHERE id = ?',
      [...vals, ts, id]
    );
    await t.run(
      'INSERT INTO community_memory_revisions (id, entry_id, revision, title, body, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), id, rev, row.title, row.body, row.author_id, row.updated_at]
    );
  });
  await enforcement.audit(actorId, 'COMMUNITY_MEMORY_UPDATE', 'community_memory_entry', id, null);
  return get(serverId, id);
}

async function nextRevision(id) {
  const row = await db.get('SELECT COALESCE(MAX(revision), 0) AS m FROM community_memory_revisions WHERE entry_id = ?', [id]);
  return (row ? Number(row.m) : 0) + 1;
}

async function remove({ serverId, actorId, id }) {
  await ensureRow(serverId, id);
  await db.run('DELETE FROM community_memory_entries WHERE id = ?', [id]);
  await db.run('DELETE FROM community_memory_revisions WHERE entry_id = ?', [id]);
  await enforcement.audit(actorId, 'COMMUNITY_MEMORY_DELETE', 'community_memory_entry', id, null);
  return { ok: true };
}

async function listRevisions(entryId) {
  return db.all(
    'SELECT id, revision, title, body, author_id, created_at FROM community_memory_revisions WHERE entry_id = ? ORDER BY revision DESC',
    [entryId]
  );
}

module.exports = {
  create,
  get,
  list,
  update,
  remove,
  listRevisions,
};
