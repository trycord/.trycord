// MySQL/MariaDB adapter. mysql2/promise, with a small pool and the same promise
// surface the SQLite adapter exposes.

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
    // TIMESTAMPs are stored as VARCHAR in this schema, so the driver must not try to
    // convert them into JS Dates and shift them.
    dateStrings: true,
    supportBigNumbers: true,
  });

  const dialect = 'mysql';

  // A single connection is used for transactions; mysql2 needs the same physical
  // connection for BEGIN/COMMIT.
  async function txConn() {
    const c = await pool.getConnection();
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    return c;
  }

  function bind(sql, params) {
    // mysql2 uses ? placeholders and accepts an array; rewrite named :params if a
    // caller uses them, so services can be written once.
    if (!params) return [sql, []];
    const arr = Array.isArray(params) ? params : [params];
    let i = 0;
    const rewritten = sql.replace(/:\w+/g, () => '?');
    void i;
    return [rewritten, arr];
  }

  const plain = {
    dialect,
    async get(sql, params) {
      const [q, p] = bind(sql, params);
      const [rows] = await pool.query(q, p);
      return rows[0] || null;
    },
    async all(sql, params) {
      const [q, p] = bind(sql, params);
      const [rows] = await pool.query(q, p);
      return rows;
    },
    async run(sql, params) {
      const [q, p] = bind(sql, params);
      const [r] = await pool.query(q, p);
      return { changes: r.affectedRows, lastID: r.insertId };
    },

    async transaction(fn) {
      const c = await txConn();
      try {
        await c.query('BEGIN');
        const tx = {
          dialect,
          get: async (sql, p) => { const [q, a] = bind(sql, p); const [rows] = await c.query(q, a); return rows[0] || null; },
          all: async (sql, p) => { const [q, a] = bind(sql, p); const [rows] = await c.query(q, a); return rows; },
          run: async (sql, p) => {
            const [q, a] = bind(sql, p);
            const [r] = await c.query(q, a);
            return { changes: r.affectedRows, lastID: r.insertId };
          },
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

  // Fail fast and loudly on a bad connection rather than at the first query.
  await pool.query('SELECT 1');
  return plain;
}

module.exports = { connect };
