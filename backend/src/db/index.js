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
//
// The order is deliberate. The baseline schema pass is idempotent and creates
// the tables; the versioned migrations run after it, because a migration that
// needs a table the baseline creates would otherwise run before the table
// exists. The runner records what it applied, refuses to run over a database a
// newer build wrote to, and stops at a migration that failed rather than
// running the ones after it.
//
// `apply: false` opens the connection and does nothing to the schema. It is
// for the read-only paths - asking what state a database is in, which must
// not change it.
async function open(cfg, { apply = true } = {}) {
  const next = cfg.client === 'sqlite'
    ? await require('./sqlite').connect(cfg.file)
    : await require('./mysql').connect(cfg);
  if (!apply) return next;
  await applySchema(next);
  await require('./migrations').run(next, {
    log: (line) => { if (process.env.TRYCORD_MIGRATION_LOG !== '0') console.log(line); },
  });
  return next;
}

// How much room the database has left for this process.
//
// A pool that is larger than the account's own connection limit is not a
// generous pool; it is a pool that will start failing claims at the worst
// moment. The limit is the server's, not this application's, so the only way
// to know it is to ask - once, at connect.
//
// The count is per database user, and this instance may run more than one
// process against the same account, so the pool is compared against the limit
// rather than against the limit minus one. A pool that is a comfortable
// fraction of the limit leaves room for the other processes and for the
// operator's own session.
async function checkConnectionHeadroom(conn, config) {
  if (!conn || conn.dialect !== 'mysql' || !config || !config.connectionLimit) return;
  try {
    const row = await conn.get("SHOW VARIABLES LIKE 'max_user_connections'");
    const limit = row && row.Value ? Number(row.Value) : null;
    if (!limit || !Number.isFinite(limit)) return;
    const pool = Number(config.connectionLimit);
    if (pool >= limit) {
      console.warn('[warn] the database connection pool is ' + pool
        + ' and the account "' + config.user + '" may open at most ' + limit
        + ' connections. A pool that reaches the account limit fails work rather'
        + ' than waiting for a connection. Lower DB_POOL, or raise the account'
        + " limit with 'GRANT MAX_USER_CONNECTIONS ON *.* TO '" + config.user + "'@'%';");
    } else if (pool > limit * 0.75) {
      console.warn('[warn] the database connection pool is ' + pool + ' of the '
        + limit + ' connections this account may open. One more process against'
        + ' the same account would not fit.');
    }
  } catch (e) {
    // Not being able to ask is not a reason to refuse to start.
  }
}

async function connect(options = {}) {
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
      conn = await open(candidate.config, options);
      source = candidate.source;
      activeConfig = candidate.config;
      openedAt = new Date().toISOString();
      await checkConnectionHeadroom(conn, candidate.config);
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
   *
   * The column is quoted: `cursor` is a reserved word in MySQL and MariaDB.
   */
  newRef: (column) => (conn && conn.dialect === 'mysql'
    ? `VALUES(\`${column}\`)`
    : `excluded.\`${column}\``),
  /**
   * Whether an error is a uniqueness refusal.
   *
   * One rule, in the module that knows the dialects, because the two engines
   * spell it differently and the code that has to answer it should not have
   * to know that. A caller that gets this right turns a race into the answer
   * it would have given anyway; a caller that gets it wrong answers "internal
   * error" for something that was never an error at all.
   *
   * @param {Error} error
   * @returns {boolean}
   */
  isUniqueViolation: (error) => {
    const message = String((error && error.message) || '');
    return /UNIQUE|unique|ER_DUP_ENTRY/i.test(message)
      || error.code === 'ER_DUP_ENTRY'
      || error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
  },
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
