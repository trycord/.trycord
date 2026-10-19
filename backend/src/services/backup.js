// A database backup the instance can take for itself.
//
// The CLI in scripts/db-backup.js does the same work from a terminal; this is
// the same code with the result returned instead of printed, so an operator
// can take a backup from the administration page without an SSH session.
//
// What it guarantees:
//   - it reads and never writes: every statement is a SELECT or a SHOW
//   - it names the target before it reads anything
//   - a table that cannot be read is reported, and the dump says so too
//   - the file is read back and compared with what the server reported, so a
//     backup that has not been verified is a failure rather than a file
//
// The dump holds the instance's rows, including its users. It belongs on the
// host, under the backup directory, with the same care as the database itself.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..', '..');
const ENV = path.join(ROOT, '.env');

// The application's own .env reading: dotenv keeps the first occurrence of a
// key it has already seen, while this application reads .env itself and the
// last one wins. A dump has to agree with the server about which database it
// is talking to, so it reads the last one too.
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

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return "'" + value.toISOString().slice(0, 19).replace('T', ' ') + "'";
  if (Buffer.isBuffer(value)) return "'" + value.toString('hex') + "'";
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
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

function backupDirectory() {
  return process.env.TRYCORD_BACKUP_DIR || path.join(os.homedir(), 'trycord-backups');
}

// The backups already taken, newest first. Only the two kinds this writes.
function list() {
  const dir = backupDirectory();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.sql(\.gz)?$/.test(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    out.push({
      name,
      bytes: stat.size,
      writtenAt: stat.mtime.toISOString(),
      gzipped: name.endsWith('.gz'),
    });
  }
  return out.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt)).slice(0, 50);
}

// Takes a backup. Returns what was written, and refuses rather than writing
// something that does not match the database.
async function create(options) {
  const opts = options || {};
  const t = target();

  if (t.client !== 'mysql') {
    const e = new Error('a backup needs a MySQL database; this instance runs on ' + (t.client || 'nothing configured'));
    e.code = 'UNSUPPORTED';
    throw e;
  }
  if (!t.host || !t.name || !t.user) {
    const e = new Error('the database connection is not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  const dir = opts.outDir || backupDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(dir, t.name + '-' + stamp + '.sql');

  const conn = await mysql.createConnection({
    host: t.host, port: t.port, user: t.user, password: t.password, database: t.name,
    multipleStatements: false, connectTimeout: 15000,
  });

  try {
    const [tables] = await conn.query(
      'SELECT TABLE_NAME, TABLE_ROWS, ENGINE FROM information_schema.TABLES'
      + ' WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = "BASE TABLE" ORDER BY TABLE_NAME', [t.name]);
    if (!tables.length) {
      const e = new Error('the database has no tables to back up');
      e.code = 'EMPTY';
      throw e;
    }

    const chunks = [
      '-- Trycord database backup',
      '-- database: ' + t.name,
      '-- host: ' + t.host + ':' + t.port,
      '-- tables: ' + tables.length,
      '-- taken: ' + new Date().toISOString(),
      '-- restore: mysql2 < this file, or mysql < this file',
      '',
      'SET FOREIGN_KEY_CHECKS=0;',
      '',
    ];

    let totalRows = 0;
    const failed = [];

    for (const row of tables) {
      const table = row.TABLE_NAME;
      try {
        const [create] = await conn.query('SHOW CREATE TABLE `' + table + '`');
        chunks.push('-- ' + '='.repeat(70), '-- table: ' + table + ' (' + row.ENGINE + ', ~' + row.TABLE_ROWS + ' rows)', '');
        chunks.push('DROP TABLE IF EXISTS `' + table + '`;');
        chunks.push(create[0]['Create Table'] + ';');
        const [data] = await conn.query('SELECT * FROM `' + table + '`');
        totalRows += data.length;
        if (data.length) {
          const cols = Object.keys(data[0]);
          chunks.push('INSERT INTO `' + table + '` (`' + cols.join('`, `') + '`) VALUES');
          chunks.push(data.map((r) => '(' + cols.map((c) => literal(r[c])).join(', ') + ')').join(',\n') + ';');
        }
        chunks.push('');
      } catch (err) {
        failed.push(table + ': ' + err.message);
        chunks.push('-- FAILED to read ' + table + ': ' + err.message.replace(/\n/g, ' '));
        chunks.push('');
      }
    }
    chunks.push('SET FOREIGN_KEY_CHECKS=1;', '');

    const sql = chunks.join('\n');
    fs.writeFileSync(out, sql);
    const gz = out + '.gz';
    fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(sql, 'utf8'), { level: 6 }));

    // Verified, not trusted: the file is read back and compared with what the
    // database reported.
    const raw = fs.statSync(out).size;
    const packed = fs.statSync(gz).size;
    const readBack = fs.readFileSync(out, 'utf8');
    const tableCount = (readBack.match(/^DROP TABLE IF EXISTS/gm) || []).length;

    if (failed.length) {
      const e = new Error(failed.length + ' table(s) could not be read: ' + failed.join('; '));
      e.code = 'INCOMPLETE';
      e.result = { path: out, gzippedPath: gz, bytes: raw, gzippedBytes: packed, tables: tables.length, rows: totalRows, failed };
      throw e;
    }
    if (tableCount !== tables.length || totalRows === 0) {
      const e = new Error('the file does not match what the database reported');
      e.code = 'UNVERIFIED';
      e.result = { path: out, gzippedPath: gz, bytes: raw, gzippedBytes: packed, tables: tables.length, rows: totalRows };
      throw e;
    }

    return {
      path: out,
      gzippedPath: gz,
      bytes: raw,
      gzippedBytes: packed,
      tables: tables.length,
      rows: totalRows,
      takenAt: new Date().toISOString(),
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = { create, list, backupDirectory, target };
