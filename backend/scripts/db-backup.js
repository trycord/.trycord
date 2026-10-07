#!/usr/bin/env node
'use strict';

// Dump the live database. Read-only: every statement it issues is a SELECT or a SHOW.
//
// This exists because the alternative was doing this by hand, and a hand-typed dump is
// how the wrong database gets dumped. Two failures have already come from a harness
// quietly resolving to the live MySQL instance instead of the SQLite file the caller
// asked for - .env sets DB_CLIENT twice, the second occurrence wins, and anything that
// sets DB_FILE without also setting DB_CLIENT ends up talking to production. So:
//
//   - it refuses to run unless DB_CLIENT is resolved explicitly and reported
//   - it prints the target it connected to, before it reads anything
//   - it opens the connection read-only where the driver supports it
//   - it verifies the dump afterwards instead of trusting that it wrote one
//
// Usage:
//   node scripts/db-backup.js [--out <dir>]
//
// The password never reaches argv - it is read from the environment or from .env by this
// process, so `ps` cannot see it and a shell history cannot leak it.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');

// dotenv keeps the first occurrence of a key it has already seen; this application reads
// .env itself and the last one wins. Dumping has to agree with the server, so it reads
// the last one too.
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
    out[key] = value; // last wins
  }
  return out;
}

async function main() {
  // The repository lives under a root-owned directory on some hosts, so the default is
  // in the home directory rather than beside the code. This is also where the pre-rework
  // archives already are.
  const outDir = argValue('--out') || process.env.TRYCORD_BACKUP_DIR
    || path.join(os.homedir(), 'trycord-backups');

  const env = readEnv(ENV);
  const client = process.env.DB_CLIENT || env.DB_CLIENT;
  const host = process.env.DB_HOST || env.DB_HOST;
  const port = Number(process.env.DB_PORT || env.DB_PORT || 3306);
  const name = process.env.DB_NAME || env.DB_NAME;
  const user = process.env.DB_USER || env.DB_USER;
  const password = process.env.DB_PASSWORD || env.DB_PASSWORD;

  if (client !== 'mysql') {
    console.error(`\n  refusing to run: DB_CLIENT is "${client}", not "mysql".`);
    console.error('  This script only speaks MySQL. Point DB_CLIENT= mysql, or set it in the');
    console.error('  environment for one run, rather than editing .env.\n');
    process.exit(2);
  }
  if (!host || !name || !user) {
    console.error('\n  refusing to run: DB_HOST, DB_NAME and DB_USER are all required.\n');
    process.exit(2);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(outDir, `${name}-${stamp}.sql`);

  console.log(`\n  target   ${user}@${host}:${port}/${name}`);
  console.log(`  writing  ${out}`);

  const conn = await mysql.createConnection({
    host, port, user, password, database: name,
    // Belt and braces: a backup that cannot write cannot damage anything, but a mistaken
    // target is the failure this script exists to prevent.
    multipleStatements: false,
    connectTimeout: 15000,
  });

  let tables;
  try {
    const [rows] = await conn.query(
      'SELECT TABLE_NAME, TABLE_ROWS, ENGINE FROM information_schema.TABLES'
      + ' WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = "BASE TABLE" ORDER BY TABLE_NAME', [name]);
    tables = rows;
  } catch (e) {
    await conn.end().catch(() => {});
    console.error(`\n  could not list tables: ${e.message}\n`);
    process.exit(1);
  }

  if (!tables.length) {
    await conn.end().catch(() => {});
    console.error(`\n  ${name} has no base tables. Refusing to write an empty backup.\n`);
    process.exit(1);
  }

  const chunks = [
    `-- Trycord database backup`,
    `-- database: ${name}`,
    `-- host: ${host}:${port}`,
    `-- tables: ${tables.length}`,
    `-- taken: ${new Date().toISOString()}`,
    `-- restore: mysql2 < this file, or mysql < this file`,
    '',
    'SET FOREIGN_KEY_CHECKS=0;',
    '',
  ];

  let totalRows = 0;
  let failed = null;

  for (const t of tables) {
    const table = t.TABLE_NAME;
    try {
      const [create] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
      chunks.push(`-- ${'='.repeat(70)}`, `-- table: ${table} (${t.ENGINE}, ~${t.TABLE_ROWS} rows)`, '');
      chunks.push(`DROP TABLE IF EXISTS \`${table}\`;`);
      chunks.push(create[0]['Create Table'] + ';');

      const [data] = await conn.query(`SELECT * FROM \`${table}\``);
      totalRows += data.length;

      if (data.length) {
        const cols = Object.keys(data[0]);
        chunks.push('INSERT INTO `' + table + '` (`' + cols.join('`, `') + '`) VALUES');
        chunks.push(data.map((row) => '(' + cols
          .map((c) => literal(row[c]))
          .join(', ') + ')').join(',\n') + ';');
      }
      chunks.push('');
    } catch (e) {
      // One unreadable table must not silently produce a backup that is missing it.
      failed = failed || [];
      failed.push(`${table}: ${e.message}`);
      chunks.push(`-- FAILED to read ${table}: ${e.message.replace(/\n/g, ' ')}`);
      chunks.push('');
    }
  }

  chunks.push('SET FOREIGN_KEY_CHECKS=1;', '');

  try {
    await conn.end();
  } catch { /* the dump is already in memory */ }

  const sql = chunks.join('\n');
  fs.writeFileSync(out, sql);
  const gz = out + '.gz';
  fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(sql, 'utf8'), { level: 6 }));

  // Verify rather than trust. A backup that has not been read back is a hope.
  const raw = fs.statSync(out).size;
  const packed = fs.statSync(gz).size;
  const readBack = fs.readFileSync(out, 'utf8');
  const tableCount = (readBack.match(/^DROP TABLE IF EXISTS/gm) || []).length;

  console.log(`  tables   ${tables.length} declared, ${tableCount} in the file`);
  console.log(`  rows     ${totalRows}`);
  console.log(`  size     ${(raw / 1048576).toFixed(1)}M raw, ${(packed / 1048576).toFixed(1)}M gzipped`);

  if (failed) {
    console.error(`\n  ${failed.length} table(s) could not be read:`);
    for (const f of failed) console.error(`    ${f}`);
    console.error('  The dump is incomplete. Fix the above before relying on it.\n');
    process.exit(1);
  }
  if (tableCount !== tables.length || totalRows === 0) {
    console.error('\n  verification failed: the file does not match what the server reported.\n');
    process.exit(1);
  }
  console.log('  verified. Keep both files; the .gz is the copy to move off this machine.\n');
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

// A value as MySQL would accept it back. NULL, not the string "NULL"; strings escaped;
// binary as hex so an attachment blob survives the round trip.
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) {
    return "'" + v.toISOString().slice(0, 19).replace('T', ' ') + "'";
  }
  return "'" + String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(//g, '\\Z') + "'";
}

main().catch((e) => {
  console.error('\n  backup failed: ' + (e && e.message) + '\n');
  process.exit(1);
});