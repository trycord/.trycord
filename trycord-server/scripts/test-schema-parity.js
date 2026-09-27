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

const key = (t, c) => t + '.' + c;
const keys = (list) => list.map(([t, c]) => key(t, c));

const legacy = keys(MIGRATIONS.LEGACY_ALTERS);
const mysql = new Set([...keys(MIGRATIONS.MYSQL_MODIFY), ...keys(MIGRATIONS.MYSQL_ADD)]);

ok('migration lists are exported', !!MIGRATIONS.LEGACY_ALTERS && !!MIGRATIONS.MYSQL_ADD && !!MIGRATIONS.MYSQL_MODIFY, 'missing export');
ok('LEGACY_ALTERS is non-empty', legacy.length > 0, String(legacy.length));
ok('MYSQL_ADD is non-empty', MIGRATIONS.MYSQL_ADD.length > 0, String(MIGRATIONS.MYSQL_ADD.length));

// The invariant that was broken.
const missing = legacy.filter((k) => !mysql.has(k));
ok('every SQLite migration column is also reachable on MySQL',
  missing.length === 0,
  missing.length ? 'missing from MySQL path: ' + missing.join(', ') : '');

ok('no duplicate columns within LEGACY_ALTERS',
  new Set(legacy).size === legacy.length,
  'duplicates: ' + legacy.filter((k, i) => legacy.indexOf(k) !== i).join(', '));
ok('no duplicate columns within MYSQL_ADD',
  new Set(keys(MIGRATIONS.MYSQL_ADD)).size === MIGRATIONS.MYSQL_ADD.length,
  'duplicates: ' + keys(MIGRATIONS.MYSQL_ADD).filter((k, i) => keys(MIGRATIONS.MYSQL_ADD).indexOf(k) !== i).join(', '));

// A MODIFY and an ADD for the same column would be contradictory: the MODIFY
// path throws if the column does not exist, so an ADD for the same column can
// never be reached.
const modified = new Set(keys(MIGRATIONS.MYSQL_MODIFY));
const both = keys(MIGRATIONS.MYSQL_ADD).filter((k) => modified.has(k));
ok('no column is both MODIFYed and ADDed on the MySQL path',
  both.length === 0,
  both.length ? 'in both lists: ' + both.join(', ') : '');

// The specific columns that caused the reported outage, pinned explicitly so
// the test names the regression rather than only reporting a count.
for (const k of ['messages.seq', 'messages.client_nonce', 'dm_messages.seq', 'dm_messages.client_nonce', 'roles.self_assign']) {
  ok('MySQL path adds ' + k, mysql.has(k), 'not present');
}

// The base DDL is the third expression of the schema; a column that exists in
// the CREATE TABLE but in neither migration list cannot be added to an old
// database at all.
const { tables } = require('../src/db/schema');
const ddl = tables('').join('\n');
const declared = new Set();
for (const m of ddl.matchAll(/^\s{4,}([a-z_]+)\s+(INTEGER|VARCHAR|TEXT|BLOB|TINYINT)/gm)) {
  // Column names only: skip constraint keywords that also appear in that shape.
  if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CONSTRAINT', 'KEY'].includes(m[1].toUpperCase())) continue;
  declared.add(m[1]);
}
const migrationOnly = legacy
  .map((k) => k.split('.')[1])
  .filter((col) => !declared.has(col));
ok('every migrated column also exists in the base DDL',
  migrationOnly.length === 0,
  migrationOnly.length ? 'in migrations but not in CREATE TABLE: ' + [...new Set(migrationOnly)].join(', ') : '');

console.log('\nschema-parity: ' + pass + ' passed, ' + fail + ' failed');
assert.ok(true);
process.exit(fail ? 1 : 0);
