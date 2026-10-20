// The reader's own recent searches.
//
// A short list of the queries this reader ran, newest first. It is their
// data and nobody else's: the reader sees their own list, clears it when they
// want to, and it goes with the account.
//
// The list is bounded. Every query that is recorded pushes the oldest one out
// once the list is at its limit, so the table does not grow with the number
// of searches a reader has ever run.

const db = require('../db');
const { now, uuid } = require('../clock');
const settings = require('./settings');

const QUERY_MAX = 500;
const DEFAULT_LIMIT = 25;

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such search in the history');
  e.code = 'NOT_FOUND';
  throw e;
}

// How many entries the reader keeps. A setting, so an operator can decide
// how much of this their instance holds.
function limit() {
  const value = Number(settings.read('search.historyLimit', DEFAULT_LIMIT));
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), 200);
}

// Record a query.
//
// The same query twice in a row moves to the top rather than taking a second
// place: the list is a record of what was searched for, not of how often.
async function record(userId, rawQuery) {
  const query = String(rawQuery == null ? '' : rawQuery).trim().slice(0, QUERY_MAX);
  if (!query) return null;

  const ts = now();
  const newest = await db.get(
    'SELECT id FROM search_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [userId]
  );
  if (newest) {
    const row = await db.get('SELECT query FROM search_history WHERE id = ? AND user_id = ?', [newest.id, userId]);
    if (row && row.query === query) {
      await db.run('UPDATE search_history SET created_at = ? WHERE id = ?', [ts, newest.id]);
      return query;
    }
  }

  const id = uuid();
  await db.run(
    'INSERT INTO search_history (id, user_id, query, created_at) VALUES (?, ?, ?, ?)',
    [id, userId, query, ts]
  );
  await trim(userId);
  return query;
}

// Keep the list at its limit: the oldest entries go when there are too many.
async function trim(userId) {
  const cap = limit();
  const rows = await db.all(
    'SELECT id FROM search_history WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    [userId]
  );
  if (rows.length <= cap) return 0;
  const stale = rows.slice(cap).map((r) => r.id);
  for (const id of stale) {
    await db.run('DELETE FROM search_history WHERE id = ? AND user_id = ?', [id, userId]);
  }
  return stale.length;
}

// The reader's history, newest first.
async function list(userId) {
  return db.all(
    'SELECT id, query, created_at AS createdAt FROM search_history'
    + ' WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [userId, limit()]
  );
}

// Forget everything. The reader's own list, and theirs alone to clear.
async function clear(userId) {
  const info = await db.run('DELETE FROM search_history WHERE user_id = ?', [userId]);
  return { ok: true, removed: info.changes || 0 };
}

async function remove(userId, id) {
  const info = await db.run('DELETE FROM search_history WHERE id = ? AND user_id = ?', [id, userId]);
  if (!info.changes) notFound();
  return { ok: true, id };
}

module.exports = { record, list, clear, remove };
