// Versioned migrations.
//
// The schema this application applies at boot is idempotent by construction:
// every statement is "create it if it is not there" or "add the column if it is
// missing". That is what makes it safe to run on every start, and it is why
// this file exists alongside it rather than replacing it.
//
// Idempotence is enough for a schema. It is not enough for everything a schema
// change can involve:
//
//   - A data transformation that must not run twice. Backfilling a column from
//     another one is harmless twice; converting a value, or consuming rows into
//     a new table, is not.
//   - Knowing what a database has actually had applied to it. "The column is
//     there" does not tell an operator whether the backfill that goes with it
//     ran, or whether it failed halfway.
//   - Refusing to run against a database a newer build wrote to. A rollback to
//     an older build against a newer schema is the situation where a missing
//     ledger is most dangerous.
//
// So the ledger is the record: one row per migration, applied or failed, with
// when and how long it took. A migration runs once. A failed one is recorded
// as failed and blocks the ones after it until somebody resolves it, because
// running a later migration over a half-applied earlier one is how data gets
// lost.
//
// The rules this module enforces:
//
//   1. Migrations run in ascending version order, one at a time.
//   2. A migration that has been applied is never applied again.
//   3. A failed migration blocks the ones after it.
//   4. A database whose ledger is ahead of this build's is refused, not
//      "migrated downwards".
//   5. Every applied migration is verified by its own check before its row is
//      written, and the whole schema is checked again at the end.
//   6. A migration runs inside a transaction where the engine supports one for
//      what it does. DDL is not transactional on MySQL, so a migration that
//      creates tables says so and is written to be safely re-runnable instead.

'use strict';

// The tables the schema declares.
//
// Required lazily: the schema module requires this one to run the migrations,
// so requiring it here at load time would close a cycle and leave one of the
// two holding a half-built export.
function tableNames() {
  return require('./schema').tableNames();
}

// The ledger.
//
// `version` is the primary key, so a migration cannot be recorded twice even
// if two processes try. `status` is 'applied' or 'failed'; a failed row is a
// record of an attempt, not of a completed change.
//
// The identifiers are quoted because some of them are words the engines use
// for something else: `status` and `tables` are both keywords in MySQL, and a
// query that works on SQLite and fails on MySQL is exactly the kind of
// difference this project has been bitten by before.
const LEDGER_DDL = [
  'CREATE TABLE IF NOT EXISTS schema_migrations ('
  + ' `version`     INTEGER PRIMARY KEY,'
  + ' `name`        VARCHAR(128) NOT NULL,'
  + ' `status`      VARCHAR(32) NOT NULL,'
  + ' `applied_at`  VARCHAR(64) NOT NULL,'
  + ' `duration_ms` INTEGER NOT NULL,'
  + ' `detail`      TEXT'
  + ')',
];

// The migrations.
//
// A migration is:
//   version      a positive integer, ascending, never reused
//   name         what it does, in words an operator would use
//   up           the work; receives the connection
//   precheck     optional; throws if the database is not in a state this
//                migration may safely act on
//   verify       optional; throws if the work did not have its intended effect
//   transactional true when the work is safe to run inside one transaction
//
// `up` receives the raw connection, not the db facade, because a migration is
// the one place that legitimately needs to run statements the facade does not
// wrap. Everything else in the application goes through the facade.
const MIGRATIONS = [
  {
    version: 1,
    name: '3.0.0 core schema',
    // The core tables are created by the baseline schema pass, which runs
    // first and is idempotent. This migration records that the baseline is
    // present, and verifies it.
    //
    // Not transactional: MySQL commits DDL implicitly, so a transaction around
    // it would promise an atomicity the engine does not give. The statements
    // are all "create if not there", so re-running is safe.
    transactional: false,
    async up(conn) {
      // Nothing to do: the baseline schema pass owns the DDL. Recording the
      // migration is the point - it is the first entry in the ledger, and it
      // is what makes every later migration's ordering unambiguous.
    },
    async verify(conn) {
      await assertTablesExist(conn, tableNames());
    },
  },
  {
    version: 2,
    name: '3.0.0 schema fingerprint',
    // A record of what this build believes the schema to be, so an instance
    // can be asked "does my database match this build" and get an answer that
    // names the difference rather than a yes or a no.
    //
    // One row, written in a transaction: it is a single statement, so it is
    // atomic on both engines.
    transactional: true,
    async up(conn) {
      await conn.exec(
        'CREATE TABLE IF NOT EXISTS schema_fingerprint ('
        + ' `id`          INTEGER PRIMARY KEY,'
        + ' `version`     VARCHAR(32) NOT NULL,'
        + ' `recorded_at` VARCHAR(64) NOT NULL,'
        + ' `tables`      TEXT NOT NULL'
        + ')',
      );
      const list = tableNames().sort();
      await conn.run(
        'DELETE FROM schema_fingerprint WHERE `id` = ?', [1],
      );
      await conn.run(
        'INSERT INTO schema_fingerprint (`id`, `version`, `recorded_at`, `tables`) VALUES (?, ?, ?, ?)',
        [1, String(require('../version').VERSION), new Date().toISOString(), list.join(',')],
      );
    },
    async verify(conn) {
      const row = await conn.get('SELECT `version`, `tables` FROM schema_fingerprint WHERE `id` = ?', [1]);
      if (!row) throw new Error('the schema fingerprint was not written');
      const recorded = String(row.tables || '').split(',').filter(Boolean).sort();
      const missing = tableNames().filter((t) => !recorded.includes(t));
      if (missing.length) {
        throw new Error('the schema fingerprint is missing tables this build declares: ' + missing.join(', '));
      }
    },
  },
  {
    version: 3,
    name: '3.0.0 community onboarding',
    // The tables the community onboarding needs.
    //
    // They are created by the baseline schema pass as well, because the
    // baseline is idempotent and a fresh database should have them without
    // running anything else. This migration is for the database that already
    // existed: the baseline's CREATE TABLE IF NOT EXISTS is a no-op there, so
    // the tables have to be created by a statement that knows the difference.
    //
    // Not transactional: MySQL commits DDL implicitly, so a transaction
    // around it would promise an atomicity the engine does not give. Every
    // statement is "create if not there", so re-running is safe.
    transactional: false,
    async up(conn) {
      const tables = require('./tables');
      // The engine suffix is the dialect's: MySQL wants it and SQLite would
      // refuse it. The baseline schema works the same way.
      const engine = conn.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
      for (const statement of tables(engine)) {
        if (/community_onboarding/.test(statement)) await conn.exec(statement);
      }
    },
    async verify(conn) {
      for (const name of [
        'community_onboarding',
        'community_onboarding_questions',
        'community_onboarding_answers',
      ]) {
        if (!(await tableExists(conn, name))) {
          throw new Error('the onboarding table is missing: ' + name);
        }
      }
    },
  },
  {
    version: 4,
    name: '3.7.0 group conversations',
    // A conversation of more than two people is a group, and a group has a
    // name.
    //
    // The members were always in `dm_members`, so the table could hold a
    // group and nothing could create one. The name is the one thing that is
    // missing, and it is a column.
    //
    // The column is added, and the existing rows keep their null name: a
    // one-to-one conversation has no name, and the pair key is its identity.
    //
    // Not transactional: MySQL commits DDL implicitly, so a transaction
    // around it would promise an atomicity the engine does not give. The
    // statement is written so that re-running it is safe.
    transactional: false,
    async up(conn) {
      const columns = await tableColumns(conn, 'dm_conversations');
      if (columns.includes('name')) return;
      await conn.exec('ALTER TABLE dm_conversations ADD COLUMN name VARCHAR(255) NULL');
    },
    async verify(conn) {
      const columns = await tableColumns(conn, 'dm_conversations');
      if (!columns.includes('name')) {
        throw new Error('the conversation name column is missing');
      }
    },
  },
  {
    version: 5,
    name: '4.3.0 community moderation',
    // Slow mode on a channel, and the words a community refuses.
    //
    // The baseline creates both for a fresh database; this is for the
    // database that already existed, where the baseline's CREATE TABLE IF NOT
    // EXISTS is a no-op.
    //
    // Not transactional: MySQL commits DDL implicitly, so a transaction
    // around it would promise an atomicity the engine does not give. Every
    // statement is safe to run twice.
    transactional: false,
    async up(conn) {
      const tables = require('./tables');
      const engine = conn.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
      for (const statement of tables(engine)) {
        if (/blocked_terms/.test(statement)) await conn.exec(statement);
      }
      const columns = await tableColumns(conn, 'channels');
      if (!columns.includes('slow_mode')) {
        await conn.exec('ALTER TABLE channels ADD COLUMN slow_mode INTEGER NOT NULL DEFAULT 0');
      }
    },
    async verify(conn) {
      const columns = await tableColumns(conn, 'channels');
      if (!columns.includes('slow_mode')) {
        throw new Error('the slow mode column is missing');
      }
      if (!(await tableExists(conn, 'blocked_terms'))) {
        throw new Error('the blocked terms table is missing');
      }
    },
  },
  {
    version: 6,
    name: '4.3.0 member notes',
    // The notes a community's moderators keep about the people in it.
    //
    // The baseline creates the table for a fresh database; this is for the
    // database that already existed, where the baseline's CREATE TABLE IF NOT
    // EXISTS is a no-op.
    //
    // Not transactional: MySQL commits DDL implicitly, so a transaction
    // around it would promise an atomicity the engine does not give. The
    // statement is safe to run twice.
    transactional: false,
    async up(conn) {
      const tables = require('./tables');
      const engine = conn.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
      for (const statement of tables(engine)) {
        if (/member_notes/.test(statement)) await conn.exec(statement);
      }
    },
    async verify(conn) {
      if (!(await tableExists(conn, 'member_notes'))) {
        throw new Error('the member notes table is missing');
      }
    },
  },
];

// The version this build knows about.
const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

function nowIso() {
  return new Date().toISOString();
}

async function ensureLedger(conn) {
  for (const ddl of LEDGER_DDL) await conn.exec(ddl);
}

async function readLedger(conn) {
  const rows = await conn.all(
    'SELECT `version`, `name`, `status`, `applied_at`, `duration_ms`, `detail`'
    + ' FROM schema_migrations ORDER BY `version` ASC',
  );
  return rows.map((r) => ({
    version: Number(r.version),
    name: r.name,
    status: r.status,
    appliedAt: r.applied_at,
    durationMs: Number(r.duration_ms || 0),
    detail: r.detail || null,
  }));
}

// The columns a table has.
//
// A migration that adds a column has to know whether it is already there:
// "add the column if it is missing" is the only statement that is safe to
// run twice, and this build's migrations may be run more than once.
async function tableColumns(conn, name) {
  try {
    if (conn.dialect === 'mysql') {
      const rows = await conn.all(
        'SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS '
        + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [name]
      );
      return (rows || []).map((row) => String(row.name));
    }
    const rows = await conn.all('PRAGMA table_info(' + name + ')');
    return (rows || []).map((row) => String(row.name));
  } catch {
    return [];
  }
}

async function tableExists(conn, name) {
  const dialect = conn.dialect;
  if (dialect === 'mysql') {
    const row = await conn.get(
      'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [name],
    );
    return parseInt(row && row.n, 10) > 0;
  }
  const row = await conn.get(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return parseInt(row && row.n, 10) > 0;
}

/**
 * Every table the schema declares is really there.
 *
 * This is the check that catches a migration that reported success and did not
 * do its work, and it names the missing table rather than failing somewhere
 * later with a query error.
 */
async function assertTablesExist(conn, names) {
  const missing = [];
  for (const name of names) {
    if (!await tableExists(conn, name)) missing.push(name);
  }
  if (missing.length) {
    throw new Error('these tables the schema declares are missing: ' + missing.join(', '));
  }
  return true;
}

/**
 * Run the migrations this database has not had.
 *
 * @param {object} conn
 * @param {object} [options]
 * @param {function} [options.log]  receives a line per event
 * @param {boolean} [options.force]  retry a migration that is recorded as failed
 * @returns {Promise<object>} a summary of what happened
 */
async function run(conn, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const force = options.force === true;

  await ensureLedger(conn);
  const ledger = await readLedger(conn);

  // A database a newer build wrote to. Running this build's migrations over it
  // would not bring it back - it would move it sideways. The refusal is the
  // whole point of the ledger.
  //
  // Only APPLIED migrations count. A failed one is an attempt that did not
  // finish, and the database is not newer because of it - it is in exactly the
  // state the failure needs to be resolved from.
  const newest = ledger
    .filter((r) => r.status === 'applied')
    .reduce((max, r) => Math.max(max, r.version), 0);
  if (newest > LATEST_VERSION) {
    throw new Error(
      'this database has been migrated to version ' + newest
      + ', which is newer than this build knows about (' + LATEST_VERSION + '). '
      + 'Deploy a matching build, or restore a backup taken before that migration.'
    );
  }

  // A failed migration blocks the ones after it. Running a later migration
  // over a half-applied earlier one is how rows get lost.
  const failed = ledger.filter((r) => r.status === 'failed');
  if (failed.length && !force) {
    const last = failed[failed.length - 1];
    throw new Error(
      'migration ' + last.version + ' (' + last.name + ') failed and has not been resolved. '
      + 'Nothing after it will run. Fix the cause and run the migration again with --retry.'
    );
  }

  const appliedVersions = new Set(
    ledger.filter((r) => r.status === 'applied').map((r) => r.version),
  );

  const applied = [];
  const skipped = [];

  for (const migration of MIGRATIONS.slice().sort((a, b) => a.version - b.version)) {
    if (appliedVersions.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    if (failed.some((f) => f.version === migration.version) && !force) {
      // Already reported above; nothing to do here.
      continue;
    }

    const started = Date.now();
    const detail = (message) => log('[migrate] ' + migration.version + ' ' + migration.name + ': ' + message);

    if (typeof migration.precheck === 'function') {
      try {
        await migration.precheck(conn);
      } catch (e) {
        await recordFailure(conn, migration, started, e);
        throw new Error(
          'migration ' + migration.version + ' (' + migration.name + ') cannot run here: ' + e.message,
        );
      }
    }

    detail('applying');
    try {
      if (migration.transactional === true) {
        await conn.transaction(async (tx) => {
          await migration.up(tx);
          if (typeof migration.verify === 'function') await migration.verify(tx);
        });
      } else {
        await migration.up(conn);
        if (typeof migration.verify === 'function') await migration.verify(conn);
      }
    } catch (e) {
      await recordFailure(conn, migration, started, e);
      throw new Error(
        'migration ' + migration.version + ' (' + migration.name + ') failed: ' + e.message
      );
    }

    const duration = Date.now() - started;
    await conn.run(
      'DELETE FROM schema_migrations WHERE `version` = ?', [migration.version],
    );
    await conn.run(
      'INSERT INTO schema_migrations (`version`, `name`, `status`, `applied_at`, `duration_ms`, `detail`) VALUES (?, ?, ?, ?, ?, ?)',
      [migration.version, migration.name, 'applied', nowIso(), duration, null],
    );
    applied.push({ version: migration.version, name: migration.name, durationMs: duration });
    detail('applied in ' + duration + 'ms');
  }

  // The check that runs over the whole schema, whatever migrations did. A
  // database that says it is up to date but is missing a table is not up to
  // date, and this is where that is found.
  await assertTablesExist(conn, tableNames());

  return { applied, skipped, ledger: await readLedger(conn) };
}

async function recordFailure(conn, migration, started, error) {
  const duration = Date.now() - started;
  try {
    await conn.run('DELETE FROM schema_migrations WHERE `version` = ?', [migration.version]);
    await conn.run(
      'INSERT INTO schema_migrations (`version`, `name`, `status`, `applied_at`, `duration_ms`, `detail`) VALUES (?, ?, ?, ?, ?, ?)',
      [migration.version, migration.name, 'failed', nowIso(), duration, String(error.message || error).slice(0, 500)],
    );
  } catch {
    // The ledger write failed too. The migration failed either way, and the
    // error the caller sees is the migration's own.
  }
}

/** What this database has, and what is left to do. */
async function status(conn) {
  // The ledger table is created if it is not there, because asking the
  // question is not a reason to fail. `readOnly` skips even that, for the
  // path that must not touch the database at all.
  if (conn.readOnlyStatus !== true) await ensureLedger(conn);
  const ledger = await readLedger(conn);
  const applied = ledger.filter((r) => r.status === 'applied').map((r) => r.version);
  const pending = MIGRATIONS.filter((m) => !applied.includes(m.version)).map((m) => m.version);
  return {
    latestKnown: LATEST_VERSION,
    applied,
    pending,
    failed: ledger.filter((r) => r.status === 'failed'),
    ledger,
  };
}

// ---- schema drift ----------------------------------------------------------
//
// The tables being present is not the same as the tables being right. A
// column added to a table's declaration does not reach a database whose table
// already exists, because "CREATE TABLE IF NOT EXISTS" is a no-op there. The
// ALTER lists in schema.js cover the columns that have been added over the
// project's life, but a declaration that changes after a database was created
// is exactly the case they cannot see.
//
// So the declared schema is compared with the live one, column by column, and
// the difference is reported by name. This is a diagnostic: it says what does
// not match. It does not change anything - a migration does that, deliberately,
// with a record.

/** The columns a table declares, read from its DDL. */
function declaredColumns(ddl) {
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  if (open === -1 || close === -1) return [];
  const body = ddl.slice(open + 1, close);
  const columns = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      columns.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) columns.push(current.trim());

  const names = [];
  for (const part of columns) {
    const upper = part.toUpperCase();
    // A table-level constraint is not a column.
    if (/^(PRIMARY|FOREIGN|UNIQUE|KEY|CONSTRAINT|CHECK|INDEX)\b/.test(upper)) continue;
    const m = /^[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s/.exec(part);
    if (m) names.push(m[1]);
  }
  return names;
}

/** The columns a table actually has. */
async function actualColumns(conn, table) {
  if (conn.dialect === 'mysql') {
    const rows = await conn.all(
      'SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS'
      + ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );
    return rows.map((r) => String(r.name));
  }
  const rows = await conn.all('PRAGMA table_info(' + table + ')');
  return rows.map((r) => String(r.name));
}

/**
 * Compare the declared schema with the live one.
 *
 * @returns {Promise<{tables: object[], missing: object[], extra: object[]}>}
 *   `missing` is a column the build declares and the database does not have.
 *   `extra` is a column the database has and the build does not declare.
 */
async function drift(conn) {
  const ddl = require('./tables')('');
  const byTable = new Map();
  for (const statement of ddl) {
    const m = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
    if (!m) continue;
    byTable.set(m[1], declaredColumns(statement));
  }

  const missing = [];
  const extra = [];
  const tables = [];

  for (const [table, declared] of byTable) {
    if (!await tableExists(conn, table)) {
      tables.push({ table, present: false });
      continue;
    }
    tables.push({ table, present: true });
    const actual = await actualColumns(conn, table);
    const actualSet = new Set(actual.map((c) => c.toLowerCase()));
    const declaredSet = new Set(declared.map((c) => c.toLowerCase()));
    for (const column of declared) {
      if (!actualSet.has(column.toLowerCase())) {
        missing.push({ table, column });
      }
    }
    for (const column of actual) {
      if (!declaredSet.has(column.toLowerCase())) {
        extra.push({ table, column });
      }
    }
  }

  return { tables, missing, extra };
}

module.exports = {
  MIGRATIONS,
  LATEST_VERSION,
  run,
  status,
  ensureLedger,
  readLedger,
  assertTablesExist,
  tableExists,
};
