// The two schema-change lists agree.
//
// A column that only one of them adds is a column one engine never gets.
// `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
// table, so the only thing that adds a column to an existing database is
// these two lists - and the code then reads the column, and the read fails
// with "Unknown column".
//
// That is not a hypothesis. The `federated` column was added to the base
// schema and to the community settings, and to neither of the two lists, so
// an instance that existed before 3.0 answered every community request with
// an error, while a fresh install was fine and every test - which all start
// from a fresh database - was green.
//
// The two lists must therefore say the same thing about the same columns.
// The type-normalisation entries are the one exception: `MYSQL_MODIFY` is
// about MySQL's own column types and has no SQLite counterpart, and
// `LEGACY_DROPS` is about a column being taken away, which only the SQLite
// path needed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const schema = require(path.join(__dirname, '..', '..', 'src', 'db', 'schema.js'));

const LISTS = schema.MIGRATIONS;

// The columns each list adds.
function columnsOf(list) {
  const out = new Map();
  for (const [table, column] of list) {
    const key = table + '.' + column;
    if (out.has(key)) continue;
    out.set(key, true);
  }
  return out;
}

test('the SQLite and MySQL change lists agree', async (t) => {
  const legacy = columnsOf(LISTS.LEGACY_ALTERS);
  const mysql = columnsOf(LISTS.MYSQL_ADD);

  await t.test('every column the SQLite list adds, the MySQL list adds too', () => {
    const missing = [...legacy.keys()].filter((key) => !mysql.has(key));
    assert.deepEqual(missing, [],
      'these columns are added on SQLite and never on MySQL, so an existing '
      + 'MySQL database never gets them:\n' + missing.join('\n'));
  });

  await t.test('every column the MySQL list adds, the SQLite list adds too', () => {
    const missing = [...mysql.keys()].filter((key) => !legacy.has(key));
    assert.deepEqual(missing, [],
      'these columns are added on MySQL and never on SQLite, so an existing '
      + 'SQLite database never gets them:\n' + missing.join('\n'));
  });

  await t.test('a column is not added twice in the same list', () => {
    for (const [name, list] of [['LEGACY_ALTERS', LISTS.LEGACY_ALTERS], ['MYSQL_ADD', LISTS.MYSQL_ADD]]) {
      const seen = new Set();
      const twice = [];
      for (const [table, column] of list) {
        const key = table + '.' + column;
        if (seen.has(key)) twice.push(key);
        seen.add(key);
      }
      assert.deepEqual(twice, [], name + ' adds these columns twice:\n' + twice.join('\n'));
    }
  });

  await t.test('every added column is in the base schema too', () => {
    // A column the change lists add but the base schema does not declare is
    // a column a fresh install does not have, which is the same fault the
    // other way round.
    const base = schema.tables(' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4').join('\n');
    // The block of DDL for each table, taken from its CREATE to the next one.
    const blocks = new Map();
    for (const chunk of base.split(/CREATE TABLE IF NOT EXISTS /)) {
      const name = /^(\w+)/.exec(chunk);
      if (!name) continue;
      blocks.set(name[1], chunk);
    }
    const missing = [];
    for (const [table, column] of LISTS.LEGACY_ALTERS) {
      const block = blocks.get(table);
      if (!block) { missing.push(table + '.' + column + ' (the table is not in the base schema)'); continue; }
      if (!new RegExp('(^|[\\s,(])`?' + column + '`?\\s', 'm').test(block)) {
        missing.push(table + '.' + column);
      }
    }
    assert.deepEqual(missing, [],
      'these columns are added to an existing database but are not in the base '
      + 'schema, so a fresh install does not have them:\n' + missing.join('\n'));
  });
});
