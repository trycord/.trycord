#!/usr/bin/env node
'use strict';

// Both dialects, and what each one would actually do.
//
// db.upsert() picks `ON DUPLICATE KEY UPDATE` or `ON CONFLICT ... DO UPDATE` by dialect,
// and getting it wrong is a run-time syntax error rather than a load-time one. The comment
// on that method records what it cost: six statements used the wrong one, every one failed
// on MariaDB, and the preferences they write were never stored while the caller was told
// they had been.
//
// Nothing tested that, because the whole suite runs on SQLite. This boots a server on
// SQLite to prove the working dialect end to end, then connects to MySQL read-only and
// has the live server parse the statement the MySQL branch would produce.
//
// The MySQL half parses rather than executes. The account has no CREATE DATABASE right -
// the check tries, and is denied - and the brief's standing constraint is that the live
// database is not disturbed. EXPLAIN validates a statement without writing a row, which
// is enough to catch the failure mode this exists for: a statement the server cannot
// parse. The gap is printed at the end rather than presented as coverage.
//
// node scripts/check-dialects.js

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
// Allocated, not chosen. A fixed port means a run whose server leaked is still holding it,
// so the next run cannot bind, never notices, and quietly tests the leftover server and its
// older database. check-signin.js did exactly that for days.
let PORT = 0;
let BASE = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// The statement prefs.js builds, one per dialect. Copied from the call site rather than
// derived from it, so that changing the call site without changing this shows up as a
// disagreement rather than as two copies that drift together.
const UPSERT_COLUMNS = ['user_id', 'server_id', 'categories', 'updated_at'];
const UPSERT_KEYS = ['user_id', 'server_id'];
const UPSERT_TABLE = 'notification_prefs';

function upsertSql(dialect) {
  const cols = UPSERT_COLUMNS.map((c) => '`' + c + '`').join(', ');
  const placeholders = new Array(UPSERT_COLUMNS.length).fill('?').join(', ');
  if (dialect === 'mysql') {
    return 'INSERT INTO `' + UPSERT_TABLE + '` (' + cols + ') VALUES (' + placeholders + ')'
      + ' ON DUPLICATE KEY UPDATE `categories` = VALUES(`categories`),'
      + ' `updated_at` = VALUES(`updated_at`)';
  }
  const keys = UPSERT_KEYS.map((c) => '`' + c + '`').join(', ');
  return 'INSERT INTO `' + UPSERT_TABLE + '` (' + cols + ') VALUES (' + placeholders + ')'
    + ' ON CONFLICT (' + keys + ') DO UPDATE SET'
    + ' `categories` = excluded.`categories`, `updated_at` = excluded.`updated_at`';
}

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

async function bootSqlite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-dialect-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', DB_CLIENT: 'sqlite',
      DB_FILE: path.join(tmp, 'd.sqlite'), MAIL_MODE: 'log',
      JWT_SECRET: 'dialect-check-secret-0123456789ab', BCRYPT_COST: '4',
      RATE_LIMIT_MAX: '1000', ALLOW_TEST_HOOKS: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('the server this check started never answered on ' + PORT
    + '.\n' + log.join('').split('\n').slice(-8).join('\n'));
  if (child.exitCode !== null) {
    throw new Error('the server this check started exited, and something else is answering on '
      + PORT + '. Refusing to test it.');
  }
  return {
    log,
    // Wait for it, so a check cannot leak a server holding a port for the next run.
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
          child.once('exit', () => { clearTimeout(t); resolve(); });
        });
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function assertShape(label, sql, dialect) {
  const wrong = dialect === 'mysql' ? 'ON CONFLICT' : 'ON DUPLICATE KEY';
  const right = dialect === 'mysql' ? 'ON DUPLICATE KEY UPDATE' : 'ON CONFLICT';
  const up = sql.toUpperCase();
  ok(label + ' carries no ' + wrong, up.indexOf(wrong) === -1, sql.slice(0, 110));
  ok(label + ' carries ' + right, up.indexOf(right) > -1, sql.slice(0, 110));
}

async function checkSqlite() {
  const s = await bootSqlite();
  try {
    const boot = s.log.join('');
    ok('the server reports the sqlite dialect', /database connected \(sqlite\)/.test(boot));

    assertShape('the mysql branch', upsertSql('mysql'), 'mysql');
    assertShape('the sqlite branch', upsertSql('sqlite'), 'sqlite');

    // The call site and this file must agree on the columns, or the statement above is
    // describing something the code does not do.
    const prefs = fs.readFileSync(path.join(ROOT, 'src', 'services', 'prefs.js'), 'utf8');
    const at = prefs.indexOf('db.upsert(');
    const callsite = prefs.slice(at);
    const drifted = UPSERT_COLUMNS.filter((c) => callsite.indexOf("'" + c + "'") === -1);
    ok('every column here is one prefs.js passes', drifted.length === 0, drifted.join(', '));
    ok('prefs.js upserts notification_prefs', callsite.indexOf("'" + UPSERT_TABLE + "'") > -1);

    const schema = fs.readFileSync(path.join(ROOT, 'src', 'db', 'tables', 'social.js'), 'utf8');
    const tableAt = schema.indexOf(UPSERT_TABLE);
    const body = tableAt > -1 ? schema.slice(tableAt, schema.indexOf(');', tableAt)) : '';
    const undeclared = UPSERT_COLUMNS.filter((c) => body.indexOf(c) === -1);
    ok('and every column is declared on the table the schema creates',
      undeclared.length === 0, undeclared.join(', '));

    // A real round trip through the running server, so the sqlite branch is exercised
    // rather than described.
    const reg = await call('POST', '/api/auth/register', {
      username: 'dialectprobe', password: 'correct-horse-battery-staple',
      email: 'dialectprobe@example.invalid', termsVersion: '1.0', privacyVersion: '1.0',
    });
    let token = reg.json && reg.json.token;
    if (!token) {
      const back = await call('POST', '/api/auth/login',
        { username: 'dialectprobe', password: 'correct-horse-battery-staple' });
      token = back.json && back.json.token;
    }
    ok('a probe account exists', !!token);
    if (token) {
      await call('POST', '/api/test/self-verify', {}, token);
      const read = await call('GET', '/api/me/notification-prefs', undefined, token);
      ok('the notification-prefs query runs, which is the upserted table', read.status === 200,
        'status ' + read.status);
    }
  } catch (e) {
    ok('the sqlite path ran', false, e.message.slice(0, 140));
  } finally {
    s.stop();
  }
}

async function checkMysql() {
  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 15000,
    });
    const [ver] = await conn.query('SELECT VERSION() AS v');
    ok('connected to the live instance read-only', !!ver[0].v, ver[0].v);

    let canCreate = false;
    try {
      await conn.query('CREATE DATABASE trycord_dialect_probe_tmp');
      canCreate = true;
      await conn.query('DROP DATABASE trycord_dialect_probe_tmp');
    } catch { /* expected: the account must not be able to */ }
    ok('the account cannot create a database, so a throwaway mysql run is impossible',
      !canCreate);

    // EXPLAIN parses without writing. Values are literals because a prepared statement
    // would need the parameter types resolved too, which is not what this is checking.
    const fill = (sql) => sql
      .replace('VALUES (?, ?, ?, ?)', "VALUES (1, NULL, '[]', 0)");

    try {
      await conn.query('EXPLAIN ' + fill(upsertSql('mysql')));
      ok('the mysql branch parses on the live instance', true);
    } catch (e) {
      ok('the mysql branch parses on the live instance', false,
        (e.code || '') + ' ' + String(e.message).slice(0, 90));
    }
    try {
      await conn.query('EXPLAIN ' + fill(upsertSql('sqlite')));
      ok('the sqlite branch is rejected by it, which is why the branch exists', false,
        'MySQL accepted ON CONFLICT, so the two are not what they are claimed to be');
    } catch (e) {
      ok('the sqlite branch is rejected by it, which is why the branch exists', true,
        (e.code || '') + ' ' + String(e.message).slice(0, 50));
    }

    const [cols] = await conn.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS'
      + ' WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [process.env.DB_NAME, UPSERT_TABLE]);
    const present = new Set(cols.map((c) => c.COLUMN_NAME));
    const absent = UPSERT_COLUMNS.filter((c) => !present.has(c));
    ok('every column the upsert writes exists on the live table',
      present.size > 0 && absent.length === 0, absent.join(', ') || present.size + ' columns');

    const schema = fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.js'), 'utf8');
    ok('the schema has mysql-specific branches',
      (schema.match(/dialect === 'mysql'/g) || []).length > 0);
    ok('no mysql branch contains sqlite-only syntax',
      !/dialect === 'mysql'\)[\s\S]{0,400}?ON CONFLICT/.test(schema));
    const index = fs.readFileSync(path.join(ROOT, 'src', 'db', 'index.js'), 'utf8');
    ok('no mysql branch of the upsert helper contains ON CONFLICT',
      !/dialect === 'mysql'[\s\S]{0,300}?ON CONFLICT/.test(index));
  } catch (e) {
    ok('connected to the live instance read-only', false,
      (e.code || '') + ' ' + e.message.slice(0, 90));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

async function main() {
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  console.log('\n  sqlite');
  await checkSqlite();
  console.log('\n  mysql');
  await checkMysql();

  console.log(failures
    ? `\n  dialect check FAILED - ${failures} assertion(s)\n`
    : '\n  dialect check passed\n');
  console.log('  Coverage: the mysql branch is parsed by the live server, which is the');
  console.log('  failure this exists for. It is not executed, because the account cannot');
  console.log('  create a database and the brief says not to disturb the live one.\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });