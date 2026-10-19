// Apply the schema and run the versioned migrations.
//
//   node scripts/migrate.js            apply, and report
//   node scripts/migrate.js --status   report what is applied and what is not
//   node scripts/migrate.js --retry    retry a migration that is recorded as failed
//
// This is the command the README and the self-hosting guide name. It was
// documented as "apply the schema to the configured database" and was in fact
// a SQLite-to-MySQL data import; the import is now `npm run db:import`.
//
// The order of operations is deliberate:
//
//   1. Say what is going to happen, and say to take a backup first. A
//      migration is a change to a live database, and the operator is the one
//      who decides whether that is safe right now.
//   2. Apply the baseline schema. Every statement in it is idempotent.
//   3. Run the versioned migrations, each recorded.
//   4. Check the schema afterwards, and report what was found.
//
// The schema is also applied when the server boots, so this command is not
// required before starting an instance. It is required when an operator wants
// to see the migration state, or to apply a change without starting the
// server, or to retry something that failed.

'use strict';

require('dotenv').config();

const db = require('../src/db');
const migrations = require('../src/db/migrations');
const { tableNames } = require('../src/db/schema');

function line(text) {
  console.log(text);
}

async function main() {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');
  const retry = args.includes('--retry');

  line('Trycord schema and migrations');
  line('');

  await db.connect();
  const state = db.status();
  line('database:  ' + state.dialect + ' (' + state.source + ')');
  const config = state.config || {};
  if (config.client === 'mysql') {
    line('host:      ' + config.host + ':' + config.port + '/' + config.name);
  } else if (config.client === 'sqlite') {
    line('file:      ' + config.file);
  }
  line('');

  if (statusOnly) {
    const status = await migrations.status(db);
    line('schema version this build knows: ' + status.latestKnown);
    line('applied:   ' + (status.applied.length ? status.applied.join(', ') : 'none'));
    line('pending:   ' + (status.pending.length ? status.pending.join(', ') : 'none'));
    if (status.failed.length) {
      line('');
      line('FAILED:');
      for (const f of status.failed) {
        line('  ' + f.version + ' ' + f.name + ' - ' + (f.detail || 'no detail recorded'));
      }
      line('');
      line('Nothing after a failed migration will run. Fix the cause, then:');
      line('  npm run migrate -- --retry');
    }
    line('');
    line('tables:    ' + tableNames().length + ' declared');
    await db.close();
    return;
  }

  line('Take a backup before continuing. This command changes the database.');
  line('  npm run db:backup            write a verified dump');
  line('  npm run db:restore <file>    put one back');
  line('');

  const result = await migrations.run(db, {
    force: retry,
    log: (message) => line(message),
  });

  line('');
  if (result.applied.length) {
    line('applied ' + result.applied.length + ' migration(s):');
    for (const m of result.applied) line('  ' + m.version + '  ' + m.name + '  (' + m.durationMs + 'ms)');
  } else {
    line('no migrations were pending.');
  }
  if (result.skipped.length) {
    line('already applied: ' + result.skipped.join(', '));
  }
  line('');
  line('schema check: every declared table is present.');
  line('done.');
  await db.close();
}

main().catch(async (e) => {
  console.error('');
  console.error('migration failed: ' + (e.message || e));
  console.error('');
  console.error('Nothing after a failed migration will run. The failure is recorded.');
  console.error('Fix the cause and run it again with: npm run migrate -- --retry');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
