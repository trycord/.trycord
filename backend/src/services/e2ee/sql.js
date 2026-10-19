// The two dialects spell an upsert differently.
//
// SQLite writes ON CONFLICT (...) DO UPDATE SET column = excluded.column,
// MySQL writes ON DUPLICATE KEY UPDATE column = VALUES(column). Writing the
// wrong one is a syntax error at run time rather than at load time, and a
// syntax error in a transaction is a failed write, so the statement is built
// here once and used everywhere.
//
// The db facade has an upsert of its own, but it runs outside a caller's
// transaction, and the writes that need to be atomic here are several rows
// at a time.

'use strict';

const db = require('../../db');

/**
 * An upsert statement for the live dialect.
 *
 * @param {string} table
 * @param {string[]} columns
 * @param {string[]} keyColumns
 * @param {Object<string,string>} setColumns  column -> expression
 * @returns {string}
 */
function upsert(table, columns, keyColumns, setColumns) {
  const placeholders = columns.map(() => '?').join(', ');
  const quoted = columns.map((c) => '`' + c + '`').join(', ');
  if (db.dialect === 'mysql') {
    const sets = Object.entries(setColumns)
      .map(([column, expression]) => '`' + column + '` = ' + expression)
      .join(', ');
    return 'INSERT INTO `' + table + '` (' + quoted + ') VALUES (' + placeholders + ')'
      + ' ON DUPLICATE KEY UPDATE ' + sets;
  }
  const keys = keyColumns.map((c) => '`' + c + '`').join(', ');
  const sets = Object.entries(setColumns)
    .map(([column, expression]) => '`' + column + '` = ' + expression)
    .join(', ');
  return 'INSERT INTO `' + table + '` (' + quoted + ') VALUES (' + placeholders + ')'
    + ' ON CONFLICT (' + keys + ') DO UPDATE SET ' + sets;
}

/** The expression a dialect uses for the value that was proposed. */
function proposed(column) {
  return db.dialect === 'mysql' ? 'VALUES(`' + column + '`)' : 'excluded.`' + column + '`';
}

module.exports = { upsert, proposed };
