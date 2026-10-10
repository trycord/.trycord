// The SQLite adapter. better-sqlite3 is synchronous, so the promise-based surface the
// rest of the server uses is a thin async wrapper.

const path = require('path');
const fs = require('fs');

async function connect(cfg) {
  fs.mkdirSync(path.dirname(cfg.file), { recursive: true });

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    throw new Error('better-sqlite3 is not installed — run npm install in the server package');
  }

  const raw = new Database(cfg.file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const dialect = 'sqlite';

  return {
    dialect,

    async get(sql, params) { return raw.prepare(sql).get(...toArray(params)) || null; },
    async all(sql, params) { return raw.prepare(sql).all(...toArray(params)); },
    async run(sql, params) {
      const r = raw.prepare(sql).run(...toArray(params));
      return { changes: r.changes, lastID: r.lastInsertRowid };
    },

    async transaction(fn) {
      // better-sqlite3 transactions are synchronous, so the callback's promises are
      // awaited inside a plain begin/commit pair.
      raw.prepare('BEGIN').run();
      const tx = {
        dialect,
        get: (sql, p) => raw.prepare(sql).get(...toArray(p)) || null,
        all: (sql, p) => raw.prepare(sql).all(...toArray(p)),
        run: (sql, p) => {
          const r = raw.prepare(sql).run(...toArray(p));
          return { changes: r.changes, lastID: r.lastInsertRowid };
        },
      };
      try {
        const out = await fn(tx);
        raw.prepare('COMMIT').run();
        return out;
      } catch (e) {
        try { raw.prepare('ROLLBACK').run(); } catch { /* already gone */ }
        throw e;
      }
    },

    async close() { raw.close(); },
  };
}

// better-sqlite3 wants positional arguments, not an array.
function toArray(params) {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}

module.exports = { connect };
