// The data a reader owns, and where it goes when the account goes.
//
// Every table here is keyed by the account that owns it and cascades with
// it, so an account that is deleted outright takes its rows with it.
//
// The erasure workflow anonymises an account rather than deleting the row,
// so this module is the other half of that: it is the sweep that takes a
// reader's own rows away once the erasure has been processed. The erasure
// request is the record of the erasure, so it is what the sweep reads.
//
// The sweep is a background job that queues the next pass, so it keeps
// running without anybody watching it.

const db = require('../db');

// The tables that hold a reader's own rows, and the order they are emptied
// in: the items of a collection before the collection itself, so the order
// does not depend on the engine enforcing the foreign key.
const TABLES = [
  'message_templates',
  'saved_searches',
  'search_history',
  'channel_read_cursors',
  'reader_locale_settings',
];

const SWEEP_KIND = 'reader_data_sweep';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Take a reader's own rows away.
 *
 * @param {string} userId
 * @returns {Promise<object>} how many rows were removed from each table
 */
async function purgeReaderData(userId) {
  if (!userId) return {};
  const removed = {};

  const items = await db.run(
    'DELETE FROM saved_collection_items WHERE collection_id IN'
    + ' (SELECT id FROM saved_collections WHERE user_id = ?)',
    [userId]
  );
  removed.saved_collection_items = items.changes || 0;

  const collections = await db.run('DELETE FROM saved_collections WHERE user_id = ?', [userId]);
  removed.saved_collections = collections.changes || 0;

  for (const table of TABLES) {
    const info = await db.run('DELETE FROM ' + table + ' WHERE user_id = ?', [userId]);
    removed[table] = info.changes || 0;
  }
  return removed;
}

/**
 * Take away the reader data of every account whose erasure has been
 * processed.
 *
 * @returns {Promise<object>} what was taken away
 */
async function sweepErasedAccounts() {
  const rows = await db.all(
    "SELECT DISTINCT user_id FROM account_deletion_requests WHERE status = 'DELETED'"
  );
  const removed = {};
  let accounts = 0;
  for (const row of rows) {
    const gone = await purgeReaderData(row.user_id);
    accounts += 1;
    for (const [table, count] of Object.entries(gone)) {
      removed[table] = (removed[table] || 0) + count;
    }
  }
  return { accounts, removed };
}

// Register the sweep and queue its first pass.
//
// The job is registered once per process; the queue row is written when the
// job system may not have started yet, which is harmless: a queued job waits
// for a worker.
function registerSweep() {
  const jobs = require('./jobs');
  try {
    jobs.register(SWEEP_KIND, async () => {
      const result = await sweepErasedAccounts();
      await jobs.enqueue(SWEEP_KIND, {}, { runAfterMs: SWEEP_INTERVAL_MS, maxAttempts: 3 });
      return result;
    }, { concurrency: 1, maxAttempts: 3, backoffMs: 5000 });
  } catch (e) {
    // Another instance of this process already registered it. Nothing to do
    // here: the sweep that is registered will run.
    if (/already registered/.test(String(e && e.message))) return;
    throw e;
  }

  setImmediate(() => {
    jobs.enqueue(SWEEP_KIND, {}, { runAfterMs: SWEEP_INTERVAL_MS, maxAttempts: 3 })
      .catch((e) => {
        console.warn('[reader-data] could not queue the erasure sweep: ' + (e && e.message));
      });
  });
}

registerSweep();

module.exports = {
  purgeReaderData, sweepErasedAccounts, registerSweep, TABLES, SWEEP_KIND, SWEEP_INTERVAL_MS,
};
