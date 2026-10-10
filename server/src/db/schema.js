// The schema. Applies the table definitions and the migrations that bring an existing
// database up to date.
//
// The table DDL is the data contract the live rows depend on. It lived in the legacy
// package while this one was being built; now that this package is the server, the tables
// live beside it. They are unchanged: an existing database must come out of a boot
// exactly as it went in.

const path = require('path');

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

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation ON dm_messages(conversation_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id, user_id)',
  'CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)',
];

const INDEXES_SETTINGS = [];

const SETTINGS_SCHEMA = [
  // `key` is a reserved word in MySQL, so the column name is quoted. SQLite accepts the
  // backtick form too.
  'CREATE TABLE IF NOT EXISTS instance_settings ('
  + ' `key` VARCHAR(128) PRIMARY KEY,'
  + ' value TEXT NOT NULL,'
  + ' updated_at VARCHAR(64) NOT NULL,'
  + ' updated_by VARCHAR(64)'
  + ')',
];

const VOICE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS voice_rooms (
     id         VARCHAR(64) PRIMARY KEY,
     channel_id VARCHAR(64) NOT NULL,
     server_id  VARCHAR(64) NOT NULL,
     created_at VARCHAR(64) NOT NULL,
     UNIQUE (channel_id)
   )`,
  `CREATE TABLE IF NOT EXISTS voice_participants (
     id         VARCHAR(64) PRIMARY KEY,
     room_id    VARCHAR(64) NOT NULL,
     channel_id VARCHAR(64) NOT NULL,
     user_id    VARCHAR(64) NOT NULL,
     session_id VARCHAR(128),
     joined_at  VARCHAR(64) NOT NULL,
     left_at    VARCHAR(64),
     muted      INTEGER NOT NULL DEFAULT 0,
     deafened   INTEGER NOT NULL DEFAULT 0,
     UNIQUE (channel_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS voice_speak_requests (
     id         VARCHAR(64) PRIMARY KEY,
     channel_id VARCHAR(64) NOT NULL,
     user_id    VARCHAR(64) NOT NULL,
     created_at VARCHAR(64) NOT NULL
   )`,
];

const INDEXES_VOICE = [
  'CREATE INDEX IF NOT EXISTS idx_voice_participants_room ON voice_participants(room_id)',
  'CREATE INDEX IF NOT EXISTS idx_voice_participants_live ON voice_participants(channel_id, left_at)',
  'CREATE INDEX IF NOT EXISTS idx_voice_rooms_server ON voice_rooms(server_id)',
];

function engineSuffixFor(conn) {
  return conn.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
}

function describeTable(conn, table) {
  return conn.dialect === 'mysql' ? `SHOW COLUMNS FROM \`${table}\`` : `PRAGMA table_info(${table})`;
}

function columnNameOf(conn, col) {
  return conn.dialect === 'mysql' ? col.Field : col.name;
}

async function apply(conn) {
  const statements = require('./tables')(engineSuffixFor(conn));

  // MySQL validates a foreign key against a table that already exists, and the table
  // definitions are ordered by concern rather than by dependency: message_embeds
  // references dm_conversations and dm_messages, both declared after it. SQLite does not
  // check at creation time, so this only ever failed on MySQL.
  //
  // Deferring the checks is what mysqldump does, and it is the only way a list ordered for
  // reading can be created in that order. The checks still run on every insert afterwards,
  // because this is session state, not a server setting.
  const deferFk = conn.dialect === 'mysql';
  if (deferFk) await conn.run('SET FOREIGN_KEY_CHECKS = 0');

  try {
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
    for (const ddl of SETTINGS_SCHEMA) {
      if (!ddl || !ddl.trim()) continue;
      try {
        await conn.run(ddl);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/already exists|duplicate/i.test(msg)) continue;
        throw e;
      }
    }
  } finally {
    if (deferFk) await conn.run('SET FOREIGN_KEY_CHECKS = 1');
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

  // An index is a performance decision that outlives the table it belongs to, so it is
  // kept separate from the DDL rather than declared inside it.
  for (const ddl of [...INDEXES, ...INDEXES_VOICE, ...INDEXES_SETTINGS]) {
    try { await conn.run(ddl); } catch { /* an index that already exists is fine */ }
  }
}

module.exports = { apply };
