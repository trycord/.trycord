// The declared schema, checked against the two engines it has to run on.
//
// SQLite is permissive about what it accepts. MySQL is not: a column called
// `key` or `trigger` is a reserved word there, and the statement fails at the
// moment the schema is applied - which is the moment an instance tries to
// start. SQLite happily accepts both, so a schema that only ever ran against
// SQLite looks fine until the day it meets MySQL.
//
// These are the checks that catch it before that day. They are static, they
// run in milliseconds, and they are the only place the difference between the
// two engines is written down.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TABLES_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'tables');

// MySQL's reserved words. A column or table with one of these names has to
// be quoted with backticks, which both engines accept.
//
// The list is MySQL 8.0's, plus the MariaDB additions that matter here. It is
// deliberately the reserved list only: a word that is a non-reserved keyword
// (`status`, `version`, `value`, `condition`, `action`, `tables`) is legal
// unquoted, and quoting it would be noise.
const RESERVED = new Set([
  'ACCESSIBLE', 'ADD', 'ALL', 'ALTER', 'ANALYZE', 'AND', 'AS', 'ASC',
  'ASENSITIVE', 'BEFORE', 'BETWEEN', 'BIGINT', 'BINARY', 'BLOB', 'BOTH', 'BY',
  'CALL', 'CASCADE', 'CASE', 'CHANGE', 'CHAR', 'CHARACTER', 'CHECK', 'COLLATE',
  'COLUMN', 'CONDITION', 'CONNECTION', 'CONSTRAINT', 'CONTINUE', 'CONVERT',
  'CREATE', 'CROSS', 'CUBE', 'CUME_DIST', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'CURRENT_USER', 'CURSOR', 'DATABASE', 'DATABASES',
  'DAY_HOUR', 'DAY_MICROSECOND', 'DAY_MINUTE', 'DAY_SECOND', 'DEC', 'DECIMAL',
  'DECLARE', 'DEFAULT', 'DELAYED', 'DELETE', 'DENSE_RANK', 'DESC', 'DESCRIBE',
  'DETERMINISTIC', 'DISTINCT', 'DISTINCTROW', 'DIV', 'DOUBLE', 'DROP', 'DUAL',
  'EACH', 'ELSE', 'ELSEIF', 'EMPTY', 'ENCLOSED', 'ESCAPED', 'EXCEPT', 'EXISTS',
  'EXIT', 'EXPLAIN', 'FALSE', 'FETCH', 'FIRST_VALUE', 'FLOAT', 'FLOAT4',
  'FLOAT8', 'FOR', 'FORCE', 'FOREIGN', 'FROM', 'FULLTEXT', 'FUNCTION',
  'GENERATED', 'GET', 'GRANT', 'GROUP', 'GROUPING', 'GROUPS', 'HAVING',
  'HIGH_PRIORITY', 'HOUR_MICROSECOND', 'HOUR_MINUTE', 'HOUR_SECOND', 'IF',
  'IGNORE', 'IN', 'INDEX', 'INFILE', 'INNER', 'INOUT', 'INSENSITIVE', 'INSERT',
  'INT', 'INT1', 'INT2', 'INT3', 'INT4', 'INT8', 'INTEGER', 'INTERVAL', 'INTO',
  'IO_AFTER_GTIDS', 'IO_BEFORE_GTIDS', 'IS', 'ITERATE', 'JOIN', 'JSON_TABLE',
  'KEY', 'KEYS', 'KILL', 'LAG', 'LAST_VALUE', 'LEAD', 'LEADING', 'LEAVE', 'LEFT',
  'LIKE', 'LIMIT', 'LINEAR', 'LINES', 'LOAD', 'LOCALTIME', 'LOCALTIMESTAMP',
  'LOCK', 'LONG', 'LONGBLOB', 'LONGTEXT', 'LOOP', 'LOW_PRIORITY', 'MASTER_BIND',
  'MASTER_SSL_VERIFY_SERVER_CERT', 'MATCH', 'MAXVALUE', 'MEDIUMBLOB',
  'MEDIUMINT', 'MEDIUMTEXT', 'MIDDLEINT', 'MINUTE_MICROSECOND', 'MINUTE_SECOND',
  'MOD', 'MODIFIES', 'NATURAL', 'NOT', 'NO_WRITE_TO_BINLOG', 'NTH_VALUE',
  'NTILE', 'NULL', 'NUMERIC', 'OF', 'ON', 'OPTIMIZE', 'OPTIMIZER_COSTS',
  'OPTION', 'OPTIONALLY', 'OR', 'ORDER', 'OUT', 'OUTER', 'OUTFILE', 'OVER',
  'PARTITION', 'PERCENT_RANK', 'PRECISION', 'PRIMARY', 'PROCEDURE', 'PURGE',
  'RANGE', 'RANK', 'READ', 'READS', 'READ_WRITE', 'REAL', 'RECURSIVE',
  'REFERENCES', 'REGEXP', 'RELEASE', 'RENAME', 'REPEAT', 'REPLACE', 'REQUIRE',
  'RESIGNAL', 'RESTRICT', 'RETURN', 'REVOKE', 'RIGHT', 'RLIKE', 'ROW', 'ROWS',
  'ROW_NUMBER', 'SCHEMA', 'SCHEMAS', 'SECOND_MICROSECOND', 'SELECT',
  'SENSITIVE', 'SEPARATOR', 'SET', 'SHOW', 'SIGNAL', 'SMALLINT', 'SPATIAL',
  'SPECIFIC', 'SQL', 'SQLEXCEPTION', 'SQLSTATE', 'SQLWARNING',
  'SQL_BIG_RESULT', 'SQL_CALC_FOUND_ROWS', 'SQL_SMALL_RESULT', 'SSL',
  'STARTING', 'STORED', 'STRAIGHT_JOIN', 'SYSTEM', 'TABLE', 'TERMINATED',
  'THEN', 'TINYBLOB', 'TINYINT', 'TINYTEXT', 'TO', 'TRAILING', 'TRIGGER',
  'TRUE', 'UNDO', 'UNION', 'UNIQUE', 'UNLOCK', 'UNSIGNED', 'UPDATE', 'USAGE',
  'USE', 'USING', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'VALUES', 'VARBINARY',
  'VARCHAR', 'VARCHARACTER', 'VARYING', 'VIRTUAL', 'WHEN', 'WHERE', 'WHILE',
  'WINDOW', 'WITH', 'WRITE', 'XOR', 'YEAR_MONTH', 'ZEROFILL',
]);

/** Every CREATE TABLE statement the schema declares. */
function statements() {
  const tables = require(path.join(TABLES_DIR, 'index.js'));
  return tables(' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
}

/**
 * The DDL with its comments removed.
 *
 * A comment can contain a comma - "one for a person, two for a bot" - and
 * splitting on commas without taking the comments out first cuts a column
 * definition in half and makes the fragment look like a column of its own.
 */
function withoutComments(statement) {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** The body of a CREATE TABLE, split into its top-level parts. */
function parts(statement) {
  const clean = withoutComments(statement);
  const open = clean.indexOf('(');
  const close = clean.lastIndexOf(')');
  if (open === -1 || close === -1) return [];
  const body = clean.slice(open + 1, close);
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The name of a table, from its statement. */
function tableName(statement) {
  const m = /CREATE TABLE IF NOT EXISTS\s+([`"]?\w+[`"]?)/i.exec(statement);
  return m ? m[1].replace(/[`"]/g, '') : null;
}

test('the declared schema is portable', async (t) => {
  await t.test('no column uses a MySQL reserved word unquoted', () => {
    const problems = [];
    for (const statement of statements()) {
      const table = tableName(statement);
      for (const part of parts(statement)) {
        const upper = part.toUpperCase();
        // A table-level constraint is not a column.
        if (/^(PRIMARY|FOREIGN|UNIQUE|KEY|CONSTRAINT|CHECK|INDEX)\b/.test(upper)) continue;
        const m = /^([`"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s+[A-Z]/.exec(part);
        if (!m) continue;
        if (m[1]) continue; // quoted: legal
        if (RESERVED.has(m[2].toUpperCase())) {
          problems.push(table + '.' + m[2] + ' is a MySQL reserved word and must be quoted');
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('every table has a primary key', () => {
    const problems = [];
    for (const statement of statements()) {
      const table = tableName(statement);
      // A primary key may be an id, or a natural key - a membership table is
      // keyed by the member, a token table by the token. What matters is that
      // there is one.
      if (!/PRIMARY\s+KEY/i.test(statement)) {
        problems.push(table + ' has no primary key');
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('every table name is unique', () => {
    const names = statements().map(tableName).filter(Boolean);
    const seen = new Set();
    const duplicates = [];
    for (const name of names) {
      if (seen.has(name)) duplicates.push(name);
      seen.add(name);
    }
    assert.deepEqual(duplicates, [], 'duplicate table names: ' + duplicates.join(', '));
  });

  await t.test('every foreign key points at a table this schema declares', () => {
    const names = new Set(statements().map(tableName).filter(Boolean));
    const problems = [];
    for (const statement of statements()) {
      const table = tableName(statement);
      const re = /FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+(\w+)\s*\(/gi;
      let m;
      while ((m = re.exec(statement)) !== null) {
        if (!names.has(m[1])) {
          problems.push(table + ' references ' + m[1] + ', which is not declared');
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('a table is declared after every table it points at', () => {
    // MySQL checks a referenced table when the referencing one is created, so a
    // table that points at one declared later cannot be created. SQLite does
    // not check at DDL time, which is why a fresh MySQL database failed with
    // errno 150 while every SQLite instance was perfectly happy.
    //
    // The declaration order is the order the tables are created in, so this is
    // the order the check has to be made in.
    const declared = [];
    const problems = [];
    for (const statement of statements()) {
      const table = tableName(statement);
      const re = /FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+(\w+)\s*\(/gi;
      let m;
      while ((m = re.exec(statement)) !== null) {
        if (m[1] === table) continue; // a self-reference
        if (!declared.includes(m[1])) {
          problems.push(table + ' is declared before ' + m[1] + ', which it points at');
        }
      }
      declared.push(table);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('every table module is readable and exports the same shape', () => {
    const files = fs.readdirSync(TABLES_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js');
    for (const file of files) {
      const module = require(path.join(TABLES_DIR, file));
      assert.equal(typeof module, 'function',
        file + ' must export a function that takes the engine suffix');
      const produced = module(' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      assert.ok(Array.isArray(produced), file + ' must return an array of statements');
      for (const statement of produced) {
        assert.equal(typeof statement, 'string', file + ' must return strings');
        assert.ok(tableName(statement), file + ' produced a statement with no table name: ' + statement.slice(0, 80));
      }
    }
  });
});
