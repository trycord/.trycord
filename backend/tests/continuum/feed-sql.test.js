'use strict';

// The feed's SQL.
//
// `cursor` is a reserved word in MySQL and MariaDB, and the feed's query for
// its cursor was written without quotes. On those engines it was a syntax
// error, so the feed failed on every pass - once every two seconds - and the
// table of jobs filled with the same failure. On SQLite the same query works
// happily, and the test database is SQLite, so a test that ran the feed
// would not have caught it.
//
// So this reads the source. It is not the nicest kind of test, but it is the
// one that can see the difference between the two engines.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FEED = path.join(__dirname, '..', '..', 'src', 'services', 'continuum', 'feed.js');

test('the feed quotes the column names MySQL reserves', () => {
  const source = fs.readFileSync(FEED, 'utf8');

  // The words MySQL and MariaDB keep for themselves. A column with one of
  // them in its name has to be quoted in every statement that names it.
  const reserved = ['cursor', 'interval', 'key', 'order', 'group', 'rank', 'rows'];

  // The statements that name a column. The strings that are not SQL - the
  // column list of an upsert, for one - are not SQL and are not checked
  // here; the module that builds them quotes them itself.
  const statements = (source.match(/'(?:[^'\\]|\\.)*'/g) || [])
    .filter((text) => /^\s*(select|insert|update|delete)\b/i.test(text));

  for (const word of reserved) {
    for (const statement of statements) {
      // A word inside backticks is quoted, and so is one that is part of a
      // longer name - `cursor` in `feed_cursor` is not the reserved word.
      const bare = new RegExp('(^|[^`A-Za-z0-9_])' + word + '([^`A-Za-z0-9_]|$)', 'i');
      if (!bare.test(statement)) continue;
      assert.fail('the statement ' + statement
        + ' uses ' + word + ' without backticks. MySQL and MariaDB keep that '
        + 'word for themselves, and the statement is a syntax error there.');
    }
  }
});

test('the feed writes its cursor through the quoted upsert', () => {
  // The upsert builds the column list itself, so the quoting is in the
  // database module rather than here. This checks the module does it.
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'db', 'index.js'), 'utf8');
  assert.match(source, /newRef: \(column\) =>[\s\S]{0,120}VALUES\(\\\`\$\{column\}\\\`\)/,
    'the value of a column is written back without backticks around the column '
    + 'name, and a column called cursor is a syntax error on MySQL');
});
