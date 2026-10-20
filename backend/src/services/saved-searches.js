// The searches a reader has saved.
//
// A saved search is the reader's own: the list is answered from the owner
// alone, and every read, change and deletion carries the owner in the WHERE
// clause, so one reader's saved search is never another's to see.
//
// The rows cascade with the account. A saved search is a record of what
// somebody was looking for, and it goes with the account that made it.

const db = require('../db');
const { now, uuid } = require('../clock');

const NAME_MAX = 128;
const QUERY_MAX = 500;

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such saved search');
  e.code = 'NOT_FOUND';
  throw e;
}

function cleanName(value) {
  return String(value == null ? '' : value).trim().slice(0, NAME_MAX);
}

function cleanQuery(value) {
  return String(value == null ? '' : value).trim().slice(0, QUERY_MAX);
}

// The reader's saved searches, newest first.
async function list(userId) {
  return db.all(
    'SELECT id, name, query, created_at AS createdAt, updated_at AS updatedAt'
    + ' FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    [userId]
  );
}

// One saved search, and only the owner's.
async function get(userId, id) {
  const row = await db.get(
    'SELECT id, name, query, created_at AS createdAt, updated_at AS updatedAt'
    + ' FROM saved_searches WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  if (!row) notFound();
  return row;
}

async function create(userId, input) {
  const name = cleanName(input && input.name);
  const query = cleanQuery(input && input.query);
  if (!name) bad('a saved search needs a name');
  if (!query) bad('a saved search needs a query');

  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO saved_searches (id, user_id, name, query, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, name, query, ts, ts]
  );
  return get(userId, id);
}

// Rename, or change what is searched for. The owner is in the WHERE clause,
// so somebody else's saved search is not found rather than changed.
async function update(userId, id, input) {
  const current = await get(userId, id);
  const name = input && input.name !== undefined ? cleanName(input.name) : current.name;
  const query = input && input.query !== undefined ? cleanQuery(input.query) : current.query;
  if (!name) bad('a saved search needs a name');
  if (!query) bad('a saved search needs a query');

  const ts = now();
  await db.run(
    'UPDATE saved_searches SET name = ?, query = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [name, query, ts, id, userId]
  );
  return get(userId, id);
}

async function remove(userId, id) {
  const info = await db.run('DELETE FROM saved_searches WHERE id = ? AND user_id = ?', [id, userId]);
  if (!info.changes) notFound();
  return { ok: true, id };
}

module.exports = { list, get, create, update, remove };
