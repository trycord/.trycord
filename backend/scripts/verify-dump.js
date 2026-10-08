#!/usr/bin/env node
'use strict';

// Check a dump against the live database, without needing privileges the app account does
// not have.
//
// The obvious way to verify a backup is to restore it somewhere and compare. That needs
// CREATE DATABASE, which the application's MySQL account is correctly not granted - it is an
// application account, not an administrator. So this verifies the dump where it lies: it
// parses the file and checks that what is in it matches what the server holds.
//
// Three things, per table:
//
//   rows      the number of value tuples in the file against COUNT(*) on the server
//   columns   every tuple has exactly the columns the CREATE TABLE declares
//   values    the tuples parse back to the same values the server returns for that table
//
// A dump that is short a row, has a tuple with a missing column, or has mangled a value fails
// one of those. None of it requires a second database.
//
//   node scripts/verify-dump.js data/dump-20261008-154443.sql

const fs = require('fs');
const path = require('path');

require('dotenv').config({ quiet: true });

const dumpPath = process.argv[2];

// ── reading the dump ────────────────────────────────────────────────────────────────

function readDump(file) {
  const sql = fs.readFileSync(file, 'utf8');
  const tables = new Map();   // name -> { columns, tuples, ddl }

  // CREATE TABLE `x` ... ;   -- columns come from the parenthesised list
  const createRe = /CREATE TABLE `([^`]+)`\s*\(([\s\S]*?)\)\s*ENGINE=/g;
  for (const m of sql.matchAll(createRe)) {
    const name = m[1];
    const columns = [];
    let depth = 0;
    let line = '';
    const parts = [];
    for (const c of m[2]) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      line += c;
      if (c === ',' && depth === 0) { parts.push(line); line = ''; }
    }
    if (line.trim()) parts.push(line);
    for (const p of parts) {
      const t = p.trim();
      // A key clause (PRIMARY KEY (...), KEY x (...), CONSTRAINT ...) is not a column.
      if (/^(PRIMARY|UNIQUE|KEY|CONSTRAINT|FOREIGN|CHECK|INDEX|FULLTEXT|SPATIAL)\b/i.test(t)) continue;
      const cm = /^`([^`]+)`\s+/.exec(t);
      if (cm) columns.push(cm[1]);
    }
    tables.set(name, { columns, tuples: [], ddl: m[0] });
  }

  // INSERT INTO `x` (`a`, `b`) VALUES (...),(...);
  const insertRe = /INSERT INTO `([^`]+)`\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?);\s*\n/g;
  for (const m of sql.matchAll(insertRe)) {
    const name = m[1];
    const t = tables.get(name);
    if (!t) continue;
    const cols = m[2].split(',').map((s) => s.trim().replace(/^`|`$/g, ''));
    for (const tuple of splitTuples(m[3])) {
      t.tuples.push({ cols, values: parseTuple(tuple) });
    }
  }
  return tables;
}

/** Split "(a,b),(c,d)" into ["a,b", "c,d"], respecting quotes. */
function splitTuples(body) {
  const out = [];
  let depth = 0;
  let buf = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      buf += c;
      if (c === '\\') { buf += body[++i] || ''; continue; }
      if (c === quote) {
        if (body[i + 1] === quote) { buf += body[++i]; continue; }
        inStr = false;
      }
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; quote = c; buf += c; continue; }
    if (c === '(') { depth++; if (depth > 1) buf += c; continue; }
    if (c === ')') { depth--; if (depth === 0) { out.push(buf); buf = ''; } else buf += c; continue; }
    if (depth > 0) buf += c;
  }
  return out.filter((s) => s.trim());
}

/** "'a','b''c',NULL,123,X'ff'" -> ['a', "b'c", null, 123, Buffer] */
function parseTuple(s) {
  const out = [];
  let buf = '';
  let inStr = false;
  let quote = '';
  let hex = false;
  // Whether the value currently being read was ever quoted. Only an unquoted value has its
  // surrounding whitespace discarded: inside quotes a leading space is part of the string,
  // and a community called " Trycord" must come back with its space intact.
  let quoted = false;

  // Values stay as text. The server's own type decides how a value is compared, and it
  // knows things this parser cannot: `terms_version` is a DECIMAL and comes back as the
  // string "1.0", so turning the dump's 1.0 into the number 1 here is what made 29 tables
  // disagree with a server they agreed with byte for byte.
  const flush = () => {
    const raw = quoted ? buf : buf.trim();
    if (hex) { out.push(Buffer.from(raw, 'hex')); return; }
    if (/^NULL$/i.test(raw)) { out.push(null); return; }
    if (raw === '') { out.push(quoted ? '' : null); return; }
    out.push(raw);
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        const e = s[++i];
        buf += e === 'n' ? '\n' : e === 'r' ? '\r' : e === '0' ? '\0' : e === 'Z' ? '\x1a' : e;
        continue;
      }
      if (c === quote) {
        if (s[i + 1] === quote) { buf += quote; i++; continue; }
        inStr = false;
        continue;
      }
      buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      // X'hex' is a binary literal: the X is a marker, not part of the value.
      if (!quoted && /^[Xx]$/.test(buf.trim())) { hex = true; buf = ''; }
      // Whitespace between the comma and the opening quote is formatting, not content. It
      // was being appended to the buffer and so ended up on the front of every string, which
      // is what made all 29 tables report a mismatch on an otherwise perfect dump.
      else if (!quoted && buf.trim() === '') { buf = ''; }
      inStr = true;
      quote = c;
      quoted = true;
      continue;
    }
    if (c === ',') { flush(); buf = ''; hex = false; quoted = false; continue; }
    buf += c;
  }
  flush();
  return out;
}

// ── checking it ──────────────────────────────────────────────────────────────────────

/**
 * Whether a value in the dump is the same value as the one the server returned.
 *
 * The server's own type is the authority, because it knows that `terms_version` is a DECIMAL
 * and hands back the string "1.0" while the same value read as a number is 1. Comparing
 * "1.0" to "1" by string said they differed; comparing them as numbers says they are the
 * same, and comparing only as numbers would let "01" pass for 1 - which is why the type the
 * server reports decides which comparison is made rather than a guess about the column.
 */
function sameValue(live, dumped) {
  if (live === null || live === undefined) return dumped === null;
  if (dumped === null) return false;
  if (Buffer.isBuffer(live)) {
    return Buffer.isBuffer(dumped) && live.equals(dumped);
  }
  if (live instanceof Date) {
    return typeof dumped === 'string' && dumped.replace(' ', 'T') === live.toISOString();
  }
  if (typeof live === 'number') return Number(dumped) === live;
  if (typeof live === 'boolean') return Number(dumped) === (live ? 1 : 0);
  // A string on the server. Exact text is what is wanted, with one exception: MySQL returns
  // every DECIMAL as a string, so a DECIMAL 1.0 arrives as "1.0" and the dump writes 1.0.
  // Those are the same value written two ways, and treating them as different is how a
  // correct dump gets reported as broken.
  if (String(dumped) === String(live)) return true;
  if (/^-?\d+(\.\d+)?$/.test(String(dumped)) && /^-?\d+(\.\d+)?$/.test(String(live))) {
    return Number(dumped) === Number(live);
  }
  return false;
}

/** A stable sort key for a row, so both sides can be ordered the same way. */
function rowKey(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) return 'h' + v.toString('hex');
  return String(v);
}

async function main() {
  if (!dumpPath) {
    console.error('  usage: node scripts/verify-dump.js <dump.sql>');
    process.exitCode = 1;
    return;
  }
  if (process.env.DB_CLIENT !== 'mysql') {
    console.error('  DB_CLIENT is ' + process.env.DB_CLIENT + ', not mysql. The real data is'
      + ' in MySQL; refusing to report a pass against the wrong database.');
    process.exitCode = 1;
    return;
  }

  const dump = readDump(dumpPath);
  const mysql = require('mysql2/promise');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? {} : undefined,
  });

  const [tableRows] = await db.query(
    'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [process.env.DB_NAME]
  );
  const liveNames = tableRows.map((r) => r.t);

  const problems = [];
  let totalRows = 0;
  let totalValues = 0;

  console.log('  dump file          : ' + dumpPath);
  console.log('  tables on server   : ' + liveNames.length);
  console.log('  tables in dump     : ' + dump.size);
  console.log('');
  console.log('  ' + 'table'.padEnd(32) + 'server'.padStart(8) + 'dump'.padStart(8) + '  columns  values');
  console.log('  ' + '-'.repeat(74));

  for (const name of liveNames) {
    const [cnt] = await db.query('SELECT COUNT(*) AS c FROM `' + name + '`');
    const liveCount = Number(cnt[0].c);
    const t = dump.get(name);
    totalRows += liveCount;

    if (!t) {
      problems.push(name + ': in the server, not in the dump');
      console.log('  ' + name.slice(0, 32).padEnd(32) + String(liveCount).padStart(8) + '   --   MISSING');
      continue;
    }

    // Column agreement: the CREATE TABLE and the INSERT headers must describe the same thing.
    const ddlCols = t.columns;
    const headerCols = t.tuples.length ? t.tuples[0].cols : ddlCols;
    const colsOk = ddlCols.length === headerCols.length
      && ddlCols.every((c, i) => c === headerCols[i]);
    const widths = new Set(t.tuples.map((x) => x.values.length));
    const widthOk = widths.size === 0 || (widths.size === 1 && widths.has(headerCols.length));

    let valuesOk = true;
    let detail = '';
    if (liveCount && liveCount <= 200) {
      // Small enough to compare every value. This is the part that catches a dump that has
      // the right number of rows with the wrong contents. Rows are matched on the first
      // column rather than on position, because MySQL is under no obligation to hand back
      // rows in the order they were inserted.
      const [rows] = await db.query('SELECT * FROM `' + name + '`');
      // Keyed on every column, not the first. member_roles is keyed (server_id, user_id,
      // role_id) and dm_members on (conversation_id, user_id), so two rows in either share a
      // first column. Keying on one column put both under one entry, and the second row was
      // then compared against the first row's values - which reported a mismatch that was not
      // there.
      const sig = (vals) => vals.map(rowKey).join(' ');
      const liveSigs = new Map();
      for (const r of rows) {
        liveSigs.set(sig(headerCols.map((c) => r[c])), r);
      }
      const dumpSigs = new Set();
      for (const d of t.tuples) dumpSigs.add(sig(d.values));

      outer:
      for (const r of rows) {
        const s = sig(headerCols.map((c) => r[c]));
        if (!dumpSigs.has(s)) {
          valuesOk = false;
          detail = 'no dump row matching ' + headerCols.map((c, i) => c + '=' + rowKey(r[c])).join(', ');
          break;
        }
        const d = t.tuples.find((x) => sig(x.values) === s);
        if (!d) { valuesOk = false; detail = 'row not locatable'; break; }
        for (const c of headerCols) {
          if (!(c in r)) continue;
          const dumped = d.values[headerCols.indexOf(c)];
          if (!sameValue(r[c], dumped)) {
            valuesOk = false;
            detail = 'column ' + c + ' (server ' + JSON.stringify(r[c])
              + ', dump ' + JSON.stringify(dumped) + ')';
            break outer;
          }
        }
      }
      totalValues += rows.length;
    } else {
      detail = 'count only';
    }

    const countOk = t.tuples.length === liveCount;
    if (!countOk) problems.push(name + ': server has ' + liveCount + ' rows, dump has ' + t.tuples.length);
    if (!colsOk) problems.push(name + ': CREATE TABLE lists ' + ddlCols.length + ' columns, INSERT lists ' + headerCols.length);
    if (!widthOk) problems.push(name + ': tuples of differing widths ' + [...widths].join('/'));
    if (!valuesOk) problems.push(name + ': value mismatch at ' + detail);

    console.log('  ' + name.slice(0, 32).padEnd(32)
      + String(liveCount).padStart(8)
      + String(t.tuples.length).padStart(8)
      + '  ' + (colsOk && widthOk ? ' ok ' : ' BAD ')
      + '   ' + (valuesOk ? ' ok ' : ' BAD ' + detail));
  }

  const extra = [...dump.keys()].filter((t) => !liveNames.includes(t));
  for (const t of extra) problems.push(t + ': in the dump, not on the server');

  await db.end();

  console.log('');
  console.log('  rows on server     : ' + totalRows);
  console.log('  rows in dump       : ' + [...dump.values()].reduce((n, t) => n + t.tuples.length, 0));
  console.log('  rows value-compared: ' + totalValues + ' (tables of 200 rows or fewer)');
  console.log('');
  if (problems.length) {
    console.log('  PROBLEMS (' + problems.length + '):');
    for (const p of problems.slice(0, 30)) console.log('    ' + p);
    console.log('\n  backup NOT verified\n');
    process.exitCode = 1;
    return;
  }
  console.log('  backup verified - every table, every row count, every column and every'
    + ' comparable value matches the live database\n');
}

main().catch((e) => {
  console.error('  verify failed: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});