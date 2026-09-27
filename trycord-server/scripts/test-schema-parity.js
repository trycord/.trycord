// Guards the invariant that let a real outage through: the SQLite and MySQL
// migration lists are two hand-maintained expressions of the same schema, and
// nothing checked that they agreed.
//
// LEGACY_ALTERS only runs when dialect === 'sqlite'. MYSQL_ADD/MYSQL_MODIFY
// only run on MySQL. A column added to one and not the other is invisible on
// the developer's SQLite database and fatal on production: the columns were
// never created (CREATE TABLE IF NOT EXISTS is a no-op on an existing table)
// and the unconditional backfill then failed with
//   Unknown column 'seq' in 'where clause'
//
// This test is pure and needs no database.
const assert = require('assert');
const { MIGRATIONS } = require('../src/db/schema');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

// The invariant that was broken, in BOTH directions.
//
// The two lists are not symmetric by design. MYSQL_MODIFY is
// engine-specific: it retypes columns that were TEXT in an old MySQL schema
// and SQLite has nothing to fix. But everything that ADDS a missing column
// must exist on both engines, because `CREATE TABLE IF NOT EXISTS` is a no-op
// against an existing database on either one.
//
// Checking only LEGACY -> MySQL is what let the original outage through, and
// then checking only that direction again let the inverse through: servers
// icon_url/banner_url were added to MYSQL_ADD only, so SQLite - which runs
// LEGACY_ALTERS alone - never created them and every server read failed with
// "no such column: s.icon_url".
const key = (t, c) => t + '.' + c;
const keys = (list) => list.map(([t, c]) => key(t, c));

// The base DDL is the third expression of the schema; a column that exists in
// the CREATE TABLE but in neither migration list cannot be added to an old
// database at all. Parsed up front because the MODIFY check below needs it.
const { tables } = require('../src/db/schema');
const ddl = tables('').join('\n');
const declared = new Set();
for (const m of ddl.matchAll(/^\s{4,}([a-z_]+)\s+(INTEGER|VARCHAR|TEXT|BLOB|TINYINT)/gm)) {
  // Column names only: skip constraint keywords that also appear in that shape.
  if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CONSTRAINT', 'KEY'].includes(m[1].toUpperCase())) continue;
  declared.add(m[1]);
}
function colExistsInDdl(col) {
  return declared.has(col.split('.')[1]);
}

const legacy = new Set(keys(MIGRATIONS.LEGACY_ALTERS));
const mysqlAdd = new Set(keys(MIGRATIONS.MYSQL_ADD));
const mysqlModify = new Set(keys(MIGRATIONS.MYSQL_MODIFY));
const mysql = new Set([...mysqlAdd, ...mysqlModify]);

ok('migration lists are exported', !!MIGRATIONS.LEGACY_ALTERS && !!MIGRATIONS.MYSQL_ADD && !!MIGRATIONS.MYSQL_MODIFY, 'missing export');
ok('LEGACY_ALTERS is non-empty', legacy.size > 0, String(legacy.size));
ok('MYSQL_ADD is non-empty', mysqlAdd.size > 0, String(mysqlAdd.size));

// 1. Anything SQLite adds must be reachable on MySQL.
const missingOnMysql = keys(MIGRATIONS.LEGACY_ALTERS).filter((k) => !mysql.has(k));
ok('every SQLite migration column is also reachable on MySQL',
  missingOnMysql.length === 0,
  missingOnMysql.length ? 'missing from MySQL path: ' + missingOnMysql.join(', ') : '');

// 2. Anything MySQL ADDS must also be added on SQLite. This is the direction
//    the previous version of this test did not check.
const missingOnSqlite = [...mysqlAdd].filter((k) => !legacy.has(k));
ok('every column MySQL adds is also added on SQLite',
  missingOnSqlite.length === 0,
  missingOnSqlite.length ? 'missing from the SQLite path: ' + missingOnSqlite.join(', ') : '');

// MYSQL_MODIFY is deliberately exempt from (2) - it only retypes columns that
// already exist. Assert that exemption still holds so it cannot quietly grow.
const modifyNotInDdl = keys(MIGRATIONS.MYSQL_MODIFY).filter((col) => !colExistsInDdl(col));
ok('every MYSQL_MODIFY column exists in the base DDL',
  modifyNotInDdl.length === 0,
  modifyNotInDdl.length ? 'MODIFY-only columns: ' + modifyNotInDdl.join(', ') : '');

ok('no duplicate columns within LEGACY_ALTERS',
  legacy.size === MIGRATIONS.LEGACY_ALTERS.length,
  'duplicates: ' + keys(MIGRATIONS.LEGACY_ALTERS).filter((k, i) => keys(MIGRATIONS.LEGACY_ALTERS).indexOf(k) !== i).join(', '));
ok('no duplicate columns within MYSQL_ADD',
  mysqlAdd.size === MIGRATIONS.MYSQL_ADD.length,
  'duplicates: ' + keys(MIGRATIONS.MYSQL_ADD).filter((k, i) => keys(MIGRATIONS.MYSQL_ADD).indexOf(k) !== i).join(', '));
ok('no duplicate columns within MYSQL_MODIFY',
  mysqlModify.size === MIGRATIONS.MYSQL_MODIFY.length,
  'duplicates: ' + keys(MIGRATIONS.MYSQL_MODIFY).filter((k, i) => keys(MIGRATIONS.MYSQL_MODIFY).indexOf(k) !== i).join(', '));

// A MODIFY and an ADD for the same column would be contradictory: the MODIFY
// path throws if the column does not exist, so an ADD for the same column can
// never be reached.
const both = [...mysqlAdd].filter((k) => mysqlModify.has(k));
ok('no column is both MODIFYed and ADDed on the MySQL path',
  both.length === 0,
  both.length ? 'in both lists: ' + both.join(', ') : '');

// The specific columns that caused the reported outage, pinned explicitly so
// the test names the regression rather than only reporting a count.
for (const k of ['messages.seq', 'messages.client_nonce', 'dm_messages.seq', 'dm_messages.client_nonce', 'servers.icon_url', 'servers.banner_url']) {
  ok('MySQL path adds ' + k, mysqlAdd.has(k), 'not present');
  ok('SQLite path adds ' + k, legacy.has(k), 'not present');
}

// The base DDL is checked above; this is the remaining direction: a column
// present only in a migration and not in the CREATE TABLE would mean a fresh
// database does not have it until the first boot's ALTER.
const migrationOnly = keys(MIGRATIONS.LEGACY_ALTERS)
  .map((k) => k.split('.')[1])
  .filter((col) => !declared.has(col));
ok('every migrated column also exists in the base DDL',
  migrationOnly.length === 0,
  migrationOnly.length ? 'in migrations but not in CREATE TABLE: ' + [...new Set(migrationOnly)].join(', ') : '');

console.log('\nschema-parity: ' + pass + ' passed, ' + fail + ' failed');
assert.ok(true);
process.exit(fail ? 1 : 0);
