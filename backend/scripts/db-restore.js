#!/usr/bin/env node
'use strict';

// Restore a database from a backup taken by scripts/db-backup.js.
//
// The default is to verify, not to write. A restore replaces the whole
// database, and a restore that starts because someone was in a hurry is how an
// instance loses its data twice: once to whatever broke it, and once to the
// mistake made while fixing it.
//
//   node scripts/db-restore.js <file.sql>            verify the dump
//   node scripts/db-restore.js <file.sql> --apply    restore it, after asking
//
// The restore is refused unless the dump was produced by this tool: the file
// has to carry the header and the table set it wrote, because a file that is
// not a Trycord dump would restore a shape the application does not expect.
//
// The password never reaches argv - it is read from the environment or from .env
// by this process, so `ps` cannot see it and a shell history cannot leak it.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function target() {
  const env = readEnv(ENV);
  return {
    client: process.env.DB_CLIENT || env.DB_CLIENT,
    host: process.env.DB_HOST || env.DB_HOST,
    port: Number(process.env.DB_PORT || env.DB_PORT || 3306),
    name: process.env.DB_NAME || env.DB_NAME,
    user: process.env.DB_USER || env.DB_USER,
    password: process.env.DB_PASSWORD || env.DB_PASSWORD,
  };
}

// What the file claims to be, read from the dump itself rather than from its
// name.
function inspect(file) {
  const text = fs.readFileSync(file, 'utf8');
  const header = /^-- Trycord database backup/.test(text);
  const database = (text.match(/^-- database: (.+)$/m) || [])[1] || null;
  const taken = (text.match(/^-- taken: (.+)$/m) || [])[1] || null;
  const tables = (text.match(/^DROP TABLE IF EXISTS/gm) || []).length;
  const inserts = (text.match(/^INSERT INTO/gm) || []).length;
  return { header, database, taken, tables, inserts, bytes: fs.statSync(file).size };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(String(answer || '').trim()); });
  });
}

(async () => {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!file) {
    console.error('\n  usage: node scripts/db-restore.js <file.sql> [--apply]\n');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error('\n  there is no file at ' + file + '\n');
    process.exit(2);
  }

  const t = target();
  if (t.client !== 'mysql') {
    console.error('\n  refusing to run: DB_CLIENT is "' + t.client + '", not "mysql".\n');
    process.exit(2);
  }

  const info = inspect(file);
  console.log('\n  file      ' + file);
  console.log('  from      ' + (info.taken || 'an unknown moment'));
  console.log('  database  ' + (info.database || 'unknown'));
  console.log('  tables    ' + info.tables);
  console.log('  inserts   ' + info.inserts);
  console.log('  size      ' + (info.bytes / 1048576).toFixed(1) + 'M');

  if (!info.header) {
    console.error('\n  refusing to restore: this file does not carry a Trycord backup header.\n');
    process.exit(2);
  }
  if (!info.tables) {
    console.error('\n  refusing to restore: the file holds no tables.\n');
    process.exit(2);
  }
  if (info.database && t.name && info.database !== t.name) {
    console.error('\n  refusing to restore: this dump is of "' + info.database
      + '" and this instance holds "' + t.name + '".\n');
    process.exit(2);
  }

  if (!apply) {
    console.log('\n  the file is sound. Add --apply to restore it.\n');
    process.exit(0);
  }

  const answer = await ask('  this REPLACES the database "' + t.name + '" on ' + t.host
    + '. Type the database name to continue: ');
  if (answer !== t.name) {
    console.log('\n  not restored. The name did not match.\n');
    process.exit(1);
  }

  console.log('\n  restoring…');
  const sql = fs.readFileSync(file, 'utf8');
  const conn = await mysql.createConnection({
    host: t.host, port: t.port, user: t.user, password: t.password, database: t.name,
    multipleStatements: true, connectTimeout: 15000,
  });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    await conn.query(sql);
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
    const [rows] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = "BASE TABLE"',
      [t.name]);
    console.log('  restored. the database now holds ' + rows[0].n + ' tables.\n');
  } catch (e) {
    console.error('\n  the restore failed: ' + e.message);
    console.error('  the database may be partly restored. Check it before using it.\n');
    process.exit(1);
  } finally {
    await conn.end().catch(() => {});
  }
})();
