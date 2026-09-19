// Database facade: validated configuration, one active adapter,
// shared query API, transactions. Replaces the old hardcoded SQLite handle.
//
//   const db = require('./db');   // or '../db' — no side effects on require
//   await db.connect();           // reads + validates env, verifies connectivity
//   await db.get('SELECT * FROM users WHERE id = ?', [id]);
//   await db.transaction(async (t) => { ... t.run(...) ... });
const { loadDbConfig } = require('./config');
const { applySchema } = require('./schema');

let conn = null;

function active() {
  if (!conn) throw new Error('database not connected — call db.connect() during startup first');
  return conn;
}

async function connect() {
  if (conn) return conn;
  const cfg = loadDbConfig();
  if (cfg.client === 'sqlite') {
    const sqlite = require('./sqlite');
    conn = await sqlite.connect(cfg.file);
  } else if (cfg.client === 'mysql') {
    const mysql = require('./mysql');
    conn = await mysql.connect(cfg);
  } else {
    throw new Error(`unsupported DB_CLIENT="${cfg.client}"`);
  }
  await applySchema(conn);
  return conn;
}

module.exports = {
  connect,
  get config() {
    return conn ? { dialect: conn.dialect } : null;
  },
  get dialect() {
    return conn ? conn.dialect : null;
  },
  // INSERT OR IGNORE (sqlite) vs INSERT IGNORE (mysql).
  get ignoreKeyword() {
    return conn && conn.dialect === 'mysql' ? 'IGNORE' : 'OR IGNORE';
  },
  get: (...args) => active().get(...args),
  all: (...args) => active().all(...args),
  run: (...args) => active().run(...args),
  exec: (...args) => active().exec(...args),
  transaction: (fn) => active().transaction(fn),
  close: () => (conn ? conn.close() : Promise.resolve()),
};
