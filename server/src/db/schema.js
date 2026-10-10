// The schema. Applies the table definitions and the migrations that bring an existing
// database up to date.
//
// The DDL is imported from the legacy package rather than copied, because it is the data
// contract the live rows depend on. Two copies of a schema drift, and the one that drifts
// loses data.

const path = require('path');
const LEGACY = path.join(__dirname, '..', '..', '..', 'backend', 'src', 'db');

// ALTERs that bring an older database up to date. Introspection-driven: each one asks
// the database whether it is needed, so a fresh database and an old one converge on the
// same shape without either doing work it does not need to.
const ALTERS = [
  ['servers', 'is_public', 'ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0'],
  ['servers', 'is_discoverable', 'ALTER TABLE servers ADD COLUMN is_discoverable INTEGER NOT NULL DEFAULT 1'],
  ['servers', 'icon_url', 'ALTER TABLE servers ADD COLUMN icon_url VARCHAR(512)'],
  ['servers', 'banner_url', 'ALTER TABLE servers ADD COLUMN banner_url VARCHAR(512)'],
  ['channels', 'category_id', 'ALTER TABLE channels ADD COLUMN category_id VARCHAR(64)'],
  ['users', 'terms_version', 'ALTER TABLE users ADD COLUMN terms_version VARCHAR(16)'],
  ['users', 'privacy_version', 'ALTER TABLE users ADD COLUMN privacy_version VARCHAR(16)'],
  ['users', 'terms_accepted_at', 'ALTER TABLE users ADD COLUMN terms_accepted_at VARCHAR(64)'],
  ['users', 'password_changed_at', 'ALTER TABLE users ADD COLUMN password_changed_at VARCHAR(64)'],
  ['users', 'sessions_invalidated_at', 'ALTER TABLE users ADD COLUMN sessions_invalidated_at VARCHAR(64)'],
  ['users', 'email_verified_at', 'ALTER TABLE users ADD COLUMN email_verified_at VARCHAR(64)'],
];

function describeTable(conn, table) {
  return conn.dialect === 'mysql' ? `SHOW COLUMNS FROM \`${table}\`` : `PRAGMA table_info(${table})`;
}

function columnNameOf(conn, col) {
  return conn.dialect === 'mysql' ? col.Field : col.name;
}

function engineSuffixFor(conn) {
  return conn.dialect === 'mysql'
    ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    : '';
}

async function apply(conn) {
  const statements = require(path.join(LEGACY, 'tables'))(engineSuffixFor(conn));

  for (const ddl of statements) {
    if (!ddl || !ddl.trim()) continue;
    // CREATE TABLE IF NOT EXISTS is a no-op on an existing database, so an instance that
    // already has its tables is left exactly as it is.
    try {
      await conn.run(ddl);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/already exists|duplicate/i.test(msg)) continue;
      throw e;
    }
  }

  for (const [table, column, ddl] of ALTERS) {
    let present = false;
    try {
      const cols = await conn.all(describeTable(conn, table));
      present = cols.some((c) => columnNameOf(conn, c) === column);
    } catch {
      continue;
    }
    if (present) continue;
    try {
      await conn.run(ddl);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/duplicate|already exists/i.test(msg)) continue;
      throw e;
    }
  }

  // Declared indexes, kept apart from the tables because a table module owns its shape
  // while an index is a performance decision that outlives it.
  try {
    const legacy = require(path.join(LEGACY, 'schema.js'));
    if (typeof legacy.declaredIndexes === 'function') {
      for (const sql of legacy.declaredIndexes(conn.dialect)) {
        try { await conn.run(sql); } catch { /* an index that already exists is fine */ }
      }
    }
  } catch { /* the legacy schema module is not required to be present */ }
}

module.exports = { apply };
