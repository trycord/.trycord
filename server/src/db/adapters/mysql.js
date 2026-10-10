// MySQL/MariaDB adapter. mysql2/promise with a small pool, and the same promise surface
// the SQLite adapter exposes.
//
// The dialect differences live here rather than at the call sites. There are two the
// services cannot avoid writing, because neither has a shared syntax:
//
//   INSERT OR IGNORE INTO t ...            SQLite only; MySQL says INSERT IGNORE
//   ... ON CONFLICT(c) DO UPDATE SET a=e.a  SQLite only; MySQL says ON DUPLICATE KEY UPDATE
//
// Getting either wrong is not a syntax error a test on one engine catches. It is a 500
// that only appears on the other, which is how the legacy backend shipped it: its
// INSERT OR IGNORE calls work on SQLite and fail on MySQL.

async function connect(cfg) {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (e) {
    throw new Error('mysql2 is not installed — run npm install in the server package');
  }

  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: cfg.pool,
    queueLimit: 0,
    // Timestamps are stored as VARCHAR in this schema, so the driver must not convert
    // them into JS Dates and shift them.
    dateStrings: true,
    supportBigNumbers: true,
  });

  const dialect = 'mysql';

  function bind(sql, params) {
    if (!params) return [sql, []];
    return [sql, Array.isArray(params) ? params : [params]];
  }

  function runnable(sql) {
    let out = sql;
    // INSERT OR IGNORE is SQLite; MySQL drops the OR.
    out = out.replace(/^INSERT OR IGNORE\b/i, 'INSERT IGNORE');
    // SQLite's upsert speaks ON CONFLICT ... DO UPDATE SET with `excluded.col`; MySQL
    // speaks ON DUPLICATE KEY UPDATE with VALUES(col). Both express the same thing.
    out = out.replace(
      /\bON CONFLICT\s*\([^)]*\)\s+DO UPDATE SET\s+([\s\S]*)$/i,
      (_all, sets) => 'ON DUPLICATE KEY UPDATE ' + sets.replace(/\bexcluded\.(\w+)/gi, 'VALUES($1)')
    );
    return out;
  }

  const api = {
    dialect,
    async get(sql, params) {
      const [q, p] = bind(runnable(sql), params);
      const [rows] = await pool.query(q, p);
      return rows[0] || null;
    },
    async all(sql, params) {
      const [q, p] = bind(runnable(sql), params);
      const [rows] = await pool.query(q, p);
      return rows;
    },
    async run(sql, params) {
      const [q, p] = bind(runnable(sql), params);
      const [r] = await pool.query(q, p);
      return { changes: r.affectedRows, lastID: r.insertId };
    },

    async transaction(fn) {
      // A transaction needs one physical connection throughout, and mysql2 will not
      // hand the same one back from a pool between statements.
      const c = await pool.getConnection();
      await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
      try {
        await c.query('BEGIN');
        const tx = {
          dialect,
          get: async (sql, p) => { const [q, a] = bind(runnable(sql), p); const [rows] = await c.query(q, a); return rows[0] || null; },
          all: async (sql, p) => { const [q, a] = bind(runnable(sql), p); const [rows] = await c.query(q, a); return rows; },
          run: async (sql, p) => { const [q, a] = bind(runnable(sql), p); const [r] = await c.query(q, a); return { changes: r.affectedRows, lastID: r.insertId }; },
        };
        const out = await fn(tx);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* already gone */ }
        throw e;
      } finally {
        c.release();
      }
    },

    async close() { await pool.end(); },
  };

  // Fail fast on a bad connection rather than at the first query.
  await pool.query('SELECT 1');
  return api;
}

module.exports = { connect };
