// The publication ledger.
//
// What this instance has already federated, and the state it was in when it
// was published.
//
// The relay publishes from the instance's own state rather than from a hook
// in every write path, so it has to know what it has already sent. One row
// per local source row - a community, a channel, a message, a reaction -
// keyed by the kind and the local id.
//
// The states:
//
//   pending  - the row has been claimed for publication but the event has not
//              been written yet. A crash here is not a lost publication: the
//              next pass takes it over.
//   live     - published. The fingerprint says what was published, and the
//              event id says which event it was.
//   withheld - decided against, and kept that way: what was not federable
//              when it was written is never federated later.
//   deleted  - the local row is gone and the deletion was relayed.
//
// The fingerprint is a hash of the state that was published. A different
// fingerprint means the row changed, and the change is what the next event
// carries.

const db = require('../../db');
const { now } = require('../../util');

async function find(sourceKind, sourceId) {
  return db.get(
    'SELECT * FROM continuum_publications WHERE source_kind = ? AND source_id = ?',
    [sourceKind, String(sourceId)]
  );
}

// Claim a source row for publication. True when this call created the row,
// false when one was already there - which is how two writers racing over
// the same message end up publishing it once.
async function claim(sourceKind, sourceId, fingerprint, context) {
  const stamp = now();
  const result = await db.run(
    'INSERT INTO continuum_publications '
    + '(source_kind, source_id, fingerprint, context, state, published_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      sourceKind, String(sourceId), fingerprint,
      context ? JSON.stringify(context) : null,
      'pending', stamp, stamp,
    ]
  );
  return !!(result && result.changes);
}

// What the ledger kept about the row, for the events that need it later.
function contextOf(row) {
  if (!row || !row.context) return {};
  try {
    const parsed = JSON.parse(row.context);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function markLive(sourceKind, sourceId, { fingerprint, kind, eventId }) {
  await db.run(
    'UPDATE continuum_publications SET fingerprint = ?, state = ?, last_kind = ?, last_event_id = ?, updated_at = ? '
    + 'WHERE source_kind = ? AND source_id = ?',
    [fingerprint, 'live', kind || null, eventId || null, now(), sourceKind, String(sourceId)]
  );
}

async function markWithheld(sourceKind, sourceId, fingerprint) {
  const stamp = now();
  await db.run(
    'INSERT INTO continuum_publications '
    + '(source_kind, source_id, fingerprint, state, published_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?)',
    [sourceKind, String(sourceId), fingerprint, 'withheld', stamp, stamp]
  );
}

async function markDeleted(sourceKind, sourceId) {
  await db.run(
    'UPDATE continuum_publications SET state = ?, updated_at = ? WHERE source_kind = ? AND source_id = ?',
    ['deleted', now(), sourceKind, String(sourceId)]
  );
}

// The publications a change sweep should look at: the live ones (their local
// row may have changed or gone) and the withheld ones (their rule may have
// changed - although a withheld row stays withheld, so the sweep only has to
// notice that it is still withheld).
//
// The sweep walks the ledger in publication order with a cursor, so a large
// ledger is worked through gradually instead of all at once.
async function listForSweep(sourceKind, { after, limit }) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (!after) {
    return db.all(
      'SELECT * FROM continuum_publications WHERE source_kind = ? AND state <> ? '
      + 'ORDER BY published_at ASC, source_id ASC LIMIT ' + cap,
      [sourceKind, 'deleted']
    );
  }
  const [publishedAt, sourceId] = String(after).split('|');
  return db.all(
    'SELECT * FROM continuum_publications WHERE source_kind = ? AND state <> ? '
    + 'AND (published_at > ? OR (published_at = ? AND source_id > ?)) '
    + 'ORDER BY published_at ASC, source_id ASC LIMIT ' + cap,
    [sourceKind, 'deleted', publishedAt, publishedAt, sourceId || '']
  );
}

// Has this source already been published in exactly this state?
async function isPublished(sourceKind, sourceId, fingerprint) {
  const row = await find(sourceKind, sourceId);
  return !!(row && row.state === 'live' && row.fingerprint === fingerprint && row.last_event_id);
}

module.exports = {
  find,
  claim,
  contextOf,
  markLive,
  markWithheld,
  markDeleted,
  listForSweep,
  isPublished,
};
