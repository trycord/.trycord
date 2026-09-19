// Portable schema: one definition, valid for SQLite and MySQL (InnoDB/utf8mb4).
// Rules followed throughout (MySQL compatibility):
//   - VARCHAR (not TEXT) for primary keys, unique keys, and indexed columns
//   - no DEFAULT on TEXT columns
//   - explicit FOREIGN KEY table constraints (inline REFERENCES are ignored by MySQL)
//   - timestamps stored as ISO-8601 TEXT, generated in JS (no datetime()/NOW() in SQL)
function tables(engine) {
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id            VARCHAR(64) PRIMARY KEY,
      username      VARCHAR(64) UNIQUE NOT NULL,
      display_name  TEXT,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS servers (
      id              VARCHAR(64) PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      owner_id        VARCHAR(64) NOT NULL,
      join_code       VARCHAR(64) UNIQUE NOT NULL,
      is_public       INTEGER NOT NULL DEFAULT 0,
      is_discoverable INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS categories (
      id        VARCHAR(64) PRIMARY KEY,
      server_id VARCHAR(64) NOT NULL,
      name      VARCHAR(64) NOT NULL,
      position  INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS roles (
      id          VARCHAR(64) PRIMARY KEY,
      server_id   VARCHAR(64) NOT NULL,
      name        VARCHAR(64) NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL,
      is_default  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (server_id, name),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS server_members (
      id        VARCHAR(64) PRIMARY KEY,
      user_id   VARCHAR(64) NOT NULL,
      server_id VARCHAR(64) NOT NULL,
      nickname  TEXT,
      joined_at TEXT NOT NULL,
      UNIQUE (user_id, server_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS member_roles (
      server_id VARCHAR(64) NOT NULL,
      user_id   VARCHAR(64) NOT NULL,
      role_id   VARCHAR(64) NOT NULL,
      PRIMARY KEY (server_id, user_id, role_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS channels (
      id          VARCHAR(64) PRIMARY KEY,
      server_id   VARCHAR(64) NOT NULL,
      category_id VARCHAR(64),
      name        VARCHAR(64) NOT NULL,
      topic       TEXT,
      type        VARCHAR(16) NOT NULL DEFAULT 'text',
      position    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS messages (
      id         VARCHAR(64) PRIMARY KEY,
      channel_id VARCHAR(64) NOT NULL,
      author_id  VARCHAR(64) NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS invites (
      id         VARCHAR(64) PRIMARY KEY,
      code       VARCHAR(32) UNIQUE NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      creator_id VARCHAR(64) NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      max_uses   INTEGER,
      uses       INTEGER NOT NULL DEFAULT 0,
      revoked    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti        VARCHAR(128) PRIMARY KEY,
      expires_at TEXT NOT NULL
    )${engine}`,
  ];
}

// ALTERs for SQLite databases created before these columns existed.
// (MySQL deployments always get the full schema above.)
const LEGACY_ALTERS = [
  'ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE servers ADD COLUMN is_discoverable INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE channels ADD COLUMN category_id VARCHAR(64) REFERENCES categories(id) ON DELETE SET NULL',
];

const INDEXES = [
  'CREATE INDEX idx_members_server ON server_members(server_id)',
  'CREATE INDEX idx_roles_server ON roles(server_id)',
  'CREATE INDEX idx_member_roles_lookup ON member_roles(server_id, user_id)',
  'CREATE INDEX idx_channels_server ON channels(server_id)',
  'CREATE INDEX idx_messages_channel ON messages(channel_id, created_at)',
  'CREATE INDEX idx_invites_server ON invites(server_id)',
];

function isDuplicateObjectError(e) {
  const msg = String((e && e.message) || '');
  return /duplicate column/i.test(msg) || /duplicate key name/i.test(msg) || e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_DUP_KEYNAME';
}

async function applySchema(conn) {
  const dialect = conn.dialect;
  const engine = dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
  for (const ddl of tables(engine)) {
    await conn.exec(ddl);
  }
  if (dialect === 'sqlite') {
    for (const sql of LEGACY_ALTERS) {
      try {
        await conn.exec(sql);
      } catch (e) {
        if (!isDuplicateObjectError(e)) throw e;
      }
    }
  }
  for (const idx of INDEXES) {
    const sql = dialect === 'sqlite' ? idx.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS') : idx;
    try {
      await conn.exec(sql);
    } catch (e) {
      if (!isDuplicateObjectError(e)) throw e;
    }
  }
}

module.exports = { tables, applySchema };
