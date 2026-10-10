// The database layer. One connection, one query API, and the only place SQL dialect
// is spoken.
//
// Everything above this module calls db.get / db.all / db.run / db.transaction and
// never learns which engine is underneath. The adapters inside ./adapters hold the
// differences; this module holds the contract.

const config = require('../config');

let conn = null;

async function connect() {
  if (conn) return conn;

  if (config.db.client === 'sqlite') {
    const adapter = require('./adapters/sqlite');
    conn = await adapter.connect(config.db);
  } else {
    const adapter = require('./adapters/mysql');
    conn = await adapter.connect(config.db);
  }

  await require('./schema').apply(conn);
  return conn;
}

function active() {
  if (!conn) throw new Error('database not connected — call db.connect() during startup');
  return conn;
}

const db = {
  connect,

  get dialect() { return active().dialect; },

  /** One row, or null. */
  get(sql, params) { return active().get(sql, params); },

  /** Every row. */
  all(sql, params) { return active().all(sql, params); },

  /** INSERT/UPDATE/DELETE. Resolves to { changes, lastID }. */
  run(sql, params) { return active().run(sql, params); },

  /**
   * Run fn inside a transaction. The object handed to fn has the same get/all/run
   * surface, so a service can be written once against either.
   */
  async transaction(fn) {
    const c = active();
    return c.transaction(fn);
  },

  async close() {
    if (!conn) return;
    const c = conn;
    conn = null;
    await c.close();
  },
};

module.exports = db;
