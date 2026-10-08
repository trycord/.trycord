#!/usr/bin/env node
'use strict';

// Dump the live database to SQL, using the project's own driver.
//
// mysqldump is not installed here and the credentials live in .env, so this reads them the
// same way the server does and asks MySQL for the schema and rows itself. What comes out is
// plain SQL, readable by any MySQL client, which is the point: the backup has to be usable
// by something other than this script.
//
//   node scripts/dump-data.js [out.sql]
//
// Nothing is written until the whole dump is in memory, so a failure part way through leaves
// no half file that looks like a backup.

const fs = require('fs');
const path = require('path');

require('dotenv').config({ quiet: true });

const out = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'dump.sql');

async function main() {
  if (process.env.DB_CLIENT !== 'mysql') {
    console.error('  DB_CLIENT is ' + process.env.DB_CLIENT + ', not mysql. Refusing: this'
      + ' script exists because the real data is in MySQL and a silent no-op would read as'
      + ' a successful backup.');
    process.exitCode = 1;
    return;
  }
  const mysql = require('mysql2/promise');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? {} : undefined,
    multipleStatements: false,
  });

  const q = (sql) => db.query(sql);
  const [versionRows] = await q('SELECT VERSION() AS v');
  const version = versionRows[0].v;

  const [tables] = await q(
    'SELECT TABLE_NAME AS t, TABLE_ROWS AS rows_est, ENGINE AS e, TABLE_COLLATION AS c'
    + ' FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME'
  );
  const names = tables.map((r) => r.t);

  const parts = [];
  const push = (s) => parts.push(s);
  push('-- Trycord data dump');
  push('-- database: ' + process.env.DB_NAME);
  push('-- server:   ' + version);
  push('-- tables:   ' + names.length);
  push('-- taken:    ' + new Date().toISOString());
  push('');
  push('SET NAMES utf8mb4;');
  push('SET FOREIGN_KEY_CHECKS=0;');
  push('SET @OLD_SQL_MODE=@@SQL_MODE;');
  push("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';");
  push('');

  const inventory = [];
  let rowTotal = 0;

  for (const name of names) {
    const [create] = await q('SHOW CREATE TABLE `' + name + '`');
    push('-- ----------------------------------------------------------');
    push('-- ' + name);
    push('-- ----------------------------------------------------------');
    push('DROP TABLE IF EXISTS `' + name + '`;');
    push(create[0]['Create Table'] + ';');
    push('');

    const [rows] = await q('SELECT * FROM `' + name + '`');
    inventory.push({ table: name, rows: rows.length });
    rowTotal += rows.length;
    if (!rows.length) continue;

    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => '`' + c + '`').join(', ');
    // One multi-row INSERT per 200 rows: large enough to be quick, small enough that a
    // single enormous statement cannot blow past max_allowed_packet.
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values = slice.map((r) => '(' + cols.map((c) => lit(r[c])).join(', ') + ')');
      push('INSERT INTO `' + name + '` (' + colList + ') VALUES');
      push(values.join(',\n') + ';');
    }
    push('');
  }

  push('SET FOREIGN_KEY_CHECKS=1;');
  push('SET SQL_MODE=@OLD_SQL_MODE;');
  push('');
  push('-- row inventory');
  for (const row of inventory) {
    push('--   ' + row.table.padEnd(28) + String(row.rows).padStart(6));
  }
  push('--');
  push('-- total rows: ' + rowTotal);
  push('');

  const sql = parts.join('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sql);
  await db.end();

  const bytes = fs.statSync(out).size;
  console.log('  tables       : ' + names.length);
  console.log('  rows         : ' + rowTotal);
  console.log('  written      : ' + out + '  (' + Math.round(bytes / 1024) + ' KB)');
  console.log('  inventory    :');
  for (const row of inventory) {
    console.log('    ' + row.table.padEnd(28) + String(row.rows).padStart(6));
  }
}

// A value as SQL text. Everything goes through here, so this is the single place where a
// quote, a backslash or a NUL byte in real data could break the dump.
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  if (v instanceof Date) {
    return "'" + v.toISOString().slice(0, 19).replace('T', ' ') + "'";
  }
  const s = String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\x1a/g, '\\Z');
  return "'" + s + "'";
}

main().catch((e) => {
  console.error('  dump failed: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});