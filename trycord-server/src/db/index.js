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

  /**
   * Insert a row, or update it if the key already exists.
   *
   * @param {string} table
   * @param {string[]} columns
   * @param {Array}    values
   * @param {string[]} keyColumns  columns whose combination identifies the row
   * @param {Object<string,string>} setColumns  column -> SQL expression for the
   *        update branch, written by the caller because MySQL and SQLite spell
   *        the same expression differently.
   *
   * This exists because `ON CONFLICT ... DO UPDATE` is SQLite-only and
   * `ON DUPLICATE KEY UPDATE` is MySQL-only, and writing the wrong one is a
   * syntax error at run time rather than at load time. Six statements did that:
   * session recording, all four privacy/preference upserts, and token marking.
   * On MariaDB every one of them failed, so the preferences they write were
   * never stored and the caller was told they had been.
   *
   * The alternative - sending SQLite syntax and retrying on error - cannot work:
   * MySQL quotes the rejected statement back inside the error message, so a parse
   * error trivially reads like a duplicate-key conflict.
   */
  async upsert(table, columns, values, keyColumns, setColumns) {
    const placeholders = columns.map(() => '?').join(', ');
    const quoted = columns.map((c) => '`' + c + '`').join(', ');
    const keys = keyColumns.map((c) => '`' + c + '`').join(', ');
    const mysql = conn && conn.dialect === 'mysql';
    const sql = mysql
      ? `INSERT INTO \`${table}\` (${quoted}) VALUES (${placeholders})`
        + ` ON DUPLICATE KEY UPDATE `
        + Object.entries(setColumns).map(([c, e]) => `\`${c}\` = ${e}`).join(', ')
      : `INSERT INTO \`${table}\` (${quoted}) VALUES (${placeholders})`
        + ` ON CONFLICT (${keys}) DO UPDATE SET `
        + Object.entries(setColumns).map(([c, e]) => `\`${c}\` = ${e}`).join(', ');
    return active().run(sql, values);
  },
  get: (...args) => active().get(...args),
  all: (...args) => active().all(...args),
  run: (...args) => active().run(...args),
  exec: (...args) => active().exec(...args),
  transaction: (fn) => active().transaction(fn),
  close: () => (conn ? conn.close() : Promise.resolve()),
};
