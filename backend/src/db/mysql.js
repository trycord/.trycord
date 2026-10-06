// MySQL adapter (production profile) over mysql2 with connection pooling.
// One pooled connection per transaction; plain pool queries otherwise.
const mysql = require('mysql2/promise');

function wrap(executor) {
  return {
    dialect: 'mysql',
    async get(sql, params = []) {
      const [rows] = await executor.execute(sql, params);
      return rows[0] || undefined;
    },
    async all(sql, params = []) {
      const [rows] = await executor.execute(sql, params);
      return rows;
    },
    async run(sql, params = []) {
      const [res] = await executor.execute(sql, params);
      return { changes: res.affectedRows, lastID: res.insertId };
    },
    async exec(sql) {
      await executor.query(sql);
    },
  };
}

async function connect(cfg) {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.name,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit,
    // ISO-ish timestamps stay strings; we store ISO text ourselves.
    dateStrings: true,
  });
  // Verify connectivity before the server claims to be up.
  const probe = await pool.getConnection();
  try {
    await probe.query('SELECT 1');
  } finally {
    probe.release();
  }

  return {
    dialect: 'mysql',
    ...wrap(pool),
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(wrap(conn));
        await conn.commit();
        return out;
      } catch (e) {
        try { await conn.rollback(); } catch { /* already rolled back */ }
        throw e;
      } finally {
        conn.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { connect };
