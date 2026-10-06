// SQLite adapter (local development profile) over better-sqlite3.
// The sync driver is wrapped in an async interface shared with MySQL.
// Transactions are serialized through a queue: one connection, no interleaving.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Prepared statements are reusable across calls with different bindings,
// so preparing the same SQL text on every request is pure overhead.
// Cache them (bounded, oldest-first eviction). Safe because the schema is
// fully applied at boot before any traffic, and DDL afterwards never runs.
const STMT_CACHE_MAX = 500;

function wrap(raw) {
  const cache = new Map();
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      if (cache.size >= STMT_CACHE_MAX) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(sql, s);
    }
    return s;
  }
  return {
    dialect: 'sqlite',
    async get(sql, params = []) {
      return stmt(sql).get(...params) || undefined;
    },
    async all(sql, params = []) {
      return stmt(sql).all(...params);
    },
    async run(sql, params = []) {
      const info = stmt(sql).run(...params);
      return { changes: info.changes, lastID: info.lastInsertRowid };
    },
    async exec(sql) {
      raw.exec(sql);
    },
  };
}

async function connect(file) {
  const dbPath = path.isAbsolute(file) ? file : path.join(__dirname, '..', '..', file);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  // Verify the file is a usable database.
  raw.prepare('SELECT 1').get();

  let tail = Promise.resolve();
  const conn = {
    dialect: 'sqlite',
    ...wrap(raw),
    transaction(fn) {
      const run = async () => {
        raw.exec('BEGIN');
        try {
          const out = await fn(wrap(raw));
          raw.exec('COMMIT');
          return out;
        } catch (e) {
          try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
          throw e;
        }
      };
      tail = tail.then(run, run);
      return tail;
    },
    async close() {
      raw.close();
    },
  };
  return conn;
}

module.exports = { connect };
