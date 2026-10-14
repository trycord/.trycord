// One active connection, shared query API, transactions, and where that
// connection came from.
//
//   const db = require('./db');   // or '../db' - no side effects on require
//   await db.connect();           // resolves config, connects, applies the schema
//   await db.get('SELECT * FROM users WHERE id = ?', [id]);
//   await db.transaction(async (t) => { ... t.run(...) ... });
//
// ./config owns the precedence: an administrator's saved override, then the
// environment, then nothing. Boot walks that list and takes the first
// configuration that actually connects, so a saved value that has become
// unreachable falls back to the one it replaced rather than stopping the
// instance. Which one won, and which ones failed, is reported through status() -
// an administrator whose saved configuration stopped working is told about it,
// not quietly rescued.
const dbConfig = require('./config');
const { applySchema } = require('./schema');

let conn = null;
let source = null;
let openedAt = null;
let failures = [];
// The configuration the live connection was opened with. Kept so the interface can
// say what the process is actually using, rather than what it was asked to use.
let activeConfig = null;

function active() {
  if (!conn) throw new Error('database not connected — call db.connect() during startup first');
  return conn;
}

// Open one connection and bring its schema up to date. Separate from connect()
// because a live apply needs exactly this and nothing else.
async function open(cfg) {
  const next = cfg.client === 'sqlite'
    ? await require('./sqlite').connect(cfg.file)
    : await require('./mysql').connect(cfg);
  await applySchema(next);
  return next;
}

async function connect() {
  if (conn) return conn;
  const tried = dbConfig.candidates();
  if (!tried.length) {
    const problem = dbConfig.environmentProblem();
    throw new Error(
      (problem ? problem + '\n' : '')
      + 'No database is configured. Set DB_CLIENT and its connection settings in the environment '
      + 'for the first start, or save a configuration from the administration panel.'
    );
  }

  failures = [];
  let lastError = null;
  for (const candidate of tried) {
    try {
      conn = await open(candidate.config);
      source = candidate.source;
      activeConfig = candidate.config;
      openedAt = new Date().toISOString();
      return conn;
    } catch (e) {
      lastError = e;
      failures.push({ source: candidate.source, error: e.message });
      console.error('[warn] database configuration "' + candidate.source + '" did not connect: ' + e.message);
    }
  }
  conn = null;
  throw lastError;
}

// Open the resolved configuration and swap it in as the live connection.
//
// The replacement is fully connected and migrated before conn is replaced, so a
// failure here leaves the running connection exactly as it was - that is the
// rollback. The outgoing connection is closed after a brief grace period so
// queries already in flight finish on it rather than being cut off.
//
// Only the highest-precedence candidate is tried: an explicit "apply now" is a
// request to use that configuration, so a failure to reach it is reported rather
// than silently replaced by the fallback.
async function reconnect() {
  const tried = dbConfig.candidates();
  if (!tried.length) return { ok: false, error: 'No database is configured.' };
  const candidate = tried[0];
  let next;
  try {
    next = await open(candidate.config);
  } catch (e) {
    failures = [{ source: candidate.source, error: e.message }];
    return { ok: false, error: e.message };
  }
  const previous = conn;
  conn = next;
  source = candidate.source;
  activeConfig = candidate.config;
  openedAt = new Date().toISOString();
  failures = [];
  if (previous && previous !== next) {
    const timer = setTimeout(() => { try { previous.close(); } catch { /* already gone */ } }, 500);
    if (timer.unref) timer.unref();
  }
  return { ok: true, dialect: next.dialect, source };
}

// What the connection actually is right now, for the administration panel.
function status() {
  return {
    connected: !!conn,
    dialect: conn ? conn.dialect : null,
    source,
    config: dbConfig.mask(activeConfig),
    openedAt,
    failures: failures.slice(),
  };
}

module.exports = {
  connect,
  reconnect,
  status,
  // The live connection's configuration, unmasked. Server-side only: it carries the
  // password and must never be serialised into a response.
  liveConfig: () => activeConfig,
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
   * @param {string}   table
   * @param {string[]} columns
   * @param {Array}    values
   * @param {string[]} keyColumns  columns whose combination identifies the row
   * @param {Object<string,string>} setColumns  column -> SQL expression for the
   *        update branch, written by the caller because MySQL and SQLite spell
   *        the same expression differently
   *
   * `ON CONFLICT DO UPDATE` is SQLite-only, `ON DUPLICATE KEY UPDATE` is
   * MySQL-only, and writing the wrong one is a run-time syntax error rather than
   * a load-time one. Six statements did that - session recording, the four
   * privacy/preference upserts, token marking - and on MariaDB every one failed,
   * so the preferences they write were never stored while the caller was told
   * they had been.
   *
   * The tempting alternative, sending SQLite syntax and retrying on error, can't
   * work: MySQL quotes the rejected statement back inside the error message, so a
   * parse error reads exactly like a duplicate-key conflict.
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
  /**
   * How one dialect spells "the value I just inserted, in a column I am not naming".
   *
   * MySQL writes `VALUES(column)` in an ON DUPLICATE KEY UPDATE branch and SQLite writes
   * `excluded.column` in an ON CONFLICT one. Three services were each carrying their own
   * copy of this one-liner, and when the sessions service was split out of privacy it was
   * left behind - so recordSession threw on every login, inside a `.catch()` that logs and
   * carries on, and sessions silently stopped being recorded at all.
   *
   * It belongs here because this is the module that knows the dialect in the first place.
   */
  newRef: (column) => (conn && conn.dialect === 'mysql'
    ? `VALUES(${column})`
    : `excluded.${column}`),
  get: (...args) => active().get(...args),
  all: (...args) => active().all(...args),
  run: (...args) => active().run(...args),
  exec: (...args) => active().exec(...args),
  transaction: (fn) => active().transaction(fn),
  // Closing clears the reference rather than leaving a handle to a shut connection
  // behind, so a caller that closes and connects again gets a real new connection
  // instead of a dead one.
  close: async () => {
    const closing = conn;
    conn = null;
    source = null;
    activeConfig = null;
    openedAt = null;
    if (closing) await closing.close();
  },
};
