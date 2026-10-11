// A column has to be reachable on MySQL.
//
// SQLite reaches one through LEGACY_ALTERS. MySQL reaches one through MYSQL_ADD
// for an existing database, or through the base DDL for a fresh one. A column
// that is only in the SQLite list, and in neither of the MySQL routes, is added
// on the engine that has it and silently missing on the other.
//
// That is not hypothetical. approved_at went into LEGACY_ALTERS only. Production
// came up clean on MySQL with no such column, every registration wrote NULL
// into a column that did not exist, and the approval gate read a row it could
// not see.
//
// The comment in schema.js already promised this check existed. It did not.

const fs = require('fs');
const path = require('path');

const SCHEMA = path.join(__dirname, '..', 'src', 'db', 'schema.js');
const TABLES = path.join(__dirname, '..', 'src', 'db', 'tables');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

const src = fs.readFileSync(SCHEMA, 'utf8');

// The body of a top-level array constant, matched by bracket depth rather than by
// a pattern that stops at the first entry.
function bodyOf(name) {
  const at = src.indexOf('const ' + name + ' = [');
  if (at === -1) return null;
  const open = src.indexOf('[', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

function columnsOf(name) {
  const body = bodyOf(name);
  if (body === null) return null;
  const out = [];
  for (const m of body.matchAll(/\['([a-z_]+)',\s*'([a-z_]+)'/g)) out.push(m[1] + '.' + m[2]);
  return out;
}

// Every column the base DDL declares, so a fresh database has it whatever engine.
function baseColumns() {
  const out = new Set();
  for (const file of fs.readdirSync(TABLES).filter((f) => f.endsWith('.js'))) {
    const body = fs.readFileSync(path.join(TABLES, file), 'utf8');
    for (const table of body.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\)/g)) {
      const name = table[1];
      // Column lines carry a type, which is what separates them from a
      // constraint line like PRIMARY KEY (...) or FOREIGN KEY (...).
      for (const line of table[2].split('\n')) {
        const m = /^\s+(\w+)\s+(VARCHAR|TEXT|INTEGER|REAL|BLOB|NUMERIC|BOOLEAN)\b/i.exec(line);
        if (m) out.add(name + '.' + m[1]);
      }
    }
  }
  return out;
}

const sqliteOnly = columnsOf('LEGACY_ALTERS');
const mysqlAdd = new Set(columnsOf('MYSQL_ADD') || []);
const base = baseColumns();

ok('both migration lists were found',
  !!sqliteOnly && !!mysqlAdd,
  'LEGACY_ALTERS ' + (sqliteOnly ? sqliteOnly.length : 'missing')
  + ', MYSQL_ADD ' + mysqlAdd.size);
ok('the base DDL declares columns', base.size > 40, base.size + ' columns found');

const unreachable = (sqliteOnly || []).filter((k) => !mysqlAdd.has(k) && !base.has(k));
ok('every column the SQLite migration adds is reachable on MySQL',
  unreachable.length === 0, unreachable.join(', '));

// The same question the other way round, because a column MySQL adds and SQLite
// has no route to is the mirror of the same fault.
const sqliteSet = new Set(sqliteOnly || []);
const mysqlOnly = [...mysqlAdd].filter((k) => !sqliteSet.has(k) && !base.has(k));
ok('every column the MySQL migration adds is reachable on SQLite',
  mysqlOnly.length === 0, mysqlOnly.join(', '));

console.log('\n  ' + (sqliteOnly || []).length + ' SQLite migrations, '
  + mysqlAdd.size + ' MySQL migrations, ' + base.size + ' base columns');
console.log(`\n  schema parity check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
process.exit(failures ? 1 : 0);
