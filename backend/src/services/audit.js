// Append-only moderation audit with a tamper-evident hash chain.
//
// Every entry commits to the entry before it and to its own content. Editing
// or removing a row breaks the chain, which `verify()` reports by entry id.
// This is not a substitute for database access controls; it is the difference
// between an audit trail an operator can trust and a table anyone with write
// access can quietly rewrite.
//
// Writes are serialised in-process. This deployment runs one API process; the
// chain therefore has one writer. If that ever changes, the chain needs a
// database-level lock or a sequence, not a second writer racing this one.
const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');

let writeQueue = Promise.resolve();

function canonical(entry) {
  return JSON.stringify([
    entry.id,
    entry.actor_id || '',
    entry.action || '',
    entry.target_type || '',
    entry.target_id || '',
    entry.reason || '',
    entry.report_id || '',
    entry.case_id || '',
    entry.server_id || '',
    entry.metadata || '',
    entry.created_at || '',
  ]);
}

function hashEntry(previous, entry) {
  return crypto.createHash('sha256')
    .update(String(previous || ''))
    .update('\n')
    .update(canonical(entry))
    .digest('hex');
}

function shapeInput(actorId, action, targetType, targetId, reason, options) {
  const opts = options && typeof options === 'object' ? options : {};
  // Backwards compatibility: the sixth argument used to be a report id.
  const reportId = typeof options === 'string' ? options : (opts.reportId || null);
  return {
    id: uuid(),
    actor_id: actorId,
    action,
    target_type: targetType || null,
    target_id: targetId || null,
    reason: reason ? String(reason).slice(0, 4000) : null,
    report_id: reportId || null,
    case_id: opts.caseId || null,
    server_id: opts.serverId || null,
    metadata: opts.metadata == null ? null
      : (typeof opts.metadata === 'string' ? opts.metadata : JSON.stringify(opts.metadata)),
    created_at: now(),
  };
}

async function insertEntry(entry, previous, conn = db) {
  const previousHash = previous ? previous.entry_hash || '' : '';
  const entryHash = hashEntry(previousHash, entry);
  await conn.run(
    `INSERT INTO audit_logs
       (id, actor_id, action, target_type, target_id, reason, report_id, case_id,
        server_id, metadata, previous_hash, entry_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.actor_id, entry.action, entry.target_type, entry.target_id,
      entry.reason, entry.report_id, entry.case_id, entry.server_id, entry.metadata,
      previousHash || null, entryHash, entry.created_at]
  );
  return { ...entry, previous_hash: previousHash || null, entry_hash: entryHash };
}

async function lastEntry(conn = db) {
  return conn.get(
    'SELECT id, entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1'
  );
}

/**
 * Record one audit entry.
 *
 * Returns the row as written. Existing callers pass a report id as the sixth
 * argument; newer ones pass `{ reportId, caseId, serverId, metadata }`.
 */
async function record(actorId, action, targetType, targetId, reason, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const conn = opts.conn || db;
  const entry = shapeInput(actorId, action, targetType, targetId, reason, options);
  const run = writeQueue.then(async () => {
    const previous = await lastEntry(conn);
    return insertEntry(entry, previous, conn);
  });
  // Keep the queue alive even when this write fails, so one bad entry does
  // not deadlock every audit write after it.
  writeQueue = run.catch(() => {});
  return run;
}

async function verify() {
  const rows = await db.all(
    'SELECT * FROM audit_logs ORDER BY created_at ASC, id ASC'
  );
  let previous = '';
  let checked = 0;
  let legacy = 0;
  let chainStarted = false;
  for (const row of rows) {
    if (!row.entry_hash) {
      // Unhashed rows can only legitimately predate the chain. Once a hashed
      // row exists, a later unhashed row is an insertion that bypassed the
      // audit writer and is reported as a break.
      if (chainStarted) {
        return {
          valid: false, checked, legacy,
          brokenAt: row.id,
          reason: 'an audit entry after the chain started has no hash',
        };
      }
      legacy++;
      continue;
    }
    chainStarted = true;
    const expected = hashEntry(previous, row);
    if (row.previous_hash && row.previous_hash !== previous) {
      return {
        valid: false, checked, legacy,
        brokenAt: row.id,
        reason: 'the entry does not link to the previous entry',
      };
    }
    if (expected !== row.entry_hash) {
      return {
        valid: false, checked, legacy,
        brokenAt: row.id,
        reason: 'the entry content does not match its hash',
      };
    }
    previous = row.entry_hash;
    checked++;
  }
  return { valid: true, checked, legacy, brokenAt: null, reason: null };
}

// Rebuild the chain over existing rows. Used by the migration that introduced
// the chain, and by an operator repair action only when the database is known
// to be uncompromised. It never deletes an entry.
async function rechain(conn = db) {
  const rows = await conn.all('SELECT * FROM audit_logs ORDER BY created_at ASC, id ASC');
  let previous = '';
  for (const row of rows) {
    const entryHash = hashEntry(previous, row);
    await conn.run(
      'UPDATE audit_logs SET previous_hash = ?, entry_hash = ? WHERE id = ?',
      [previous || null, entryHash, row.id]
    );
    previous = entryHash;
  }
  return { checked: rows.length };
}

module.exports = { record, verify, rechain, hashEntry, canonical };
