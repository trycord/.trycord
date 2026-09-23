// Portable schema: valid for SQLite and MySQL/InnoDB with utf8mb4.
//
// MySQL compatibility rules:
//   - VARCHAR for primary keys, unique keys, and indexed columns
//   - no DEFAULT on TEXT columns
//   - timestamps are stored as VARCHAR because they are indexed
//   - explicit FOREIGN KEY constraints
//
// IMPORTANT:
// messages.created_at MUST be VARCHAR rather than TEXT because
// idx_messages_channel indexes (channel_id, created_at).
function tables(engine) {
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id            VARCHAR(64) PRIMARY KEY,
      username      VARCHAR(64) UNIQUE NOT NULL,
      display_name  TEXT,
      password_hash TEXT NOT NULL,
      created_at    VARCHAR(64) NOT NULL,
      terms_version VARCHAR(16),
      privacy_version VARCHAR(16),
      terms_accepted_at VARCHAR(64),
      password_changed_at VARCHAR(64),
      sessions_invalidated_at VARCHAR(64),
      email VARCHAR(255) UNIQUE,
      email_verified_at VARCHAR(64)
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS servers (
      id              VARCHAR(64) PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      owner_id        VARCHAR(64) NOT NULL,
      join_code       VARCHAR(64) UNIQUE NOT NULL,
      is_public       INTEGER NOT NULL DEFAULT 0,
      is_discoverable INTEGER NOT NULL DEFAULT 1,
      created_at      VARCHAR(64) NOT NULL,
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
      joined_at VARCHAR(64) NOT NULL,
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
      created_at VARCHAR(64) NOT NULL,
      edited_at  VARCHAR(64),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS invites (
      id         VARCHAR(64) PRIMARY KEY,
      code       VARCHAR(32) UNIQUE NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      creator_id VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      expires_at VARCHAR(64),
      max_uses   INTEGER,
      uses       INTEGER NOT NULL DEFAULT 0,
      revoked    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti        VARCHAR(128) PRIMARY KEY,
      expires_at VARCHAR(64) NOT NULL
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS attachments (
      id          VARCHAR(64) PRIMARY KEY,
      message_id  VARCHAR(64),
      channel_id  VARCHAR(64) NOT NULL,
      uploader_id VARCHAR(64) NOT NULL,
      filename    VARCHAR(255) NOT NULL,
      mime        VARCHAR(64) NOT NULL,
      size        INTEGER NOT NULL DEFAULT 0,
      url         VARCHAR(512) NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (uploader_id) REFERENCES users(id)
    )${engine}`,

    // --- Direct messaging (Phase 2) ---
    // pair_key is the canonical "smaller-id:larger-id" for one-to-one chats
    // and UNIQUE, so Alice↔Bob always resolves to one conversation no matter
    // who opens it first. Group DMs stay possible later: they simply use a
    // NULL pair_key with 3+ dm_members rows.
    `CREATE TABLE IF NOT EXISTS dm_conversations (
      id         VARCHAR(64) PRIMARY KEY,
      pair_key   VARCHAR(129) UNIQUE,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS dm_members (
      conversation_id VARCHAR(64) NOT NULL,
      user_id         VARCHAR(64) NOT NULL,
      joined_at       VARCHAR(64) NOT NULL,
      last_read_at    VARCHAR(64),
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS dm_messages (
      id              VARCHAR(64) PRIMARY KEY,
      conversation_id VARCHAR(64) NOT NULL,
      author_id       VARCHAR(64) NOT NULL,
      content         TEXT NOT NULL,
      created_at      VARCHAR(64) NOT NULL,
      edited_at       VARCHAR(64),
      FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    )${engine}`,

    // --- Friendships (Phase 2) ---
    `CREATE TABLE IF NOT EXISTS friend_requests (
      id           VARCHAR(64) PRIMARY KEY,
      from_user_id VARCHAR(64) NOT NULL,
      to_user_id   VARCHAR(64) NOT NULL,
      status       VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at   VARCHAR(64) NOT NULL,
      updated_at   VARCHAR(64) NOT NULL,
      UNIQUE (from_user_id, to_user_id),
      FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

    // Stored both directions (a,b) + (b,a) so "my friends" is one lookup.
    `CREATE TABLE IF NOT EXISTS friendships (
      user_id    VARCHAR(64) NOT NULL,
      friend_id  VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

    // --- Notifications (Phase 2) ---
    `CREATE TABLE IF NOT EXISTS notifications (
      id           VARCHAR(64) PRIMARY KEY,
      user_id      VARCHAR(64) NOT NULL,
      type         VARCHAR(32) NOT NULL,
      actor_id     VARCHAR(64),
      reference_id VARCHAR(64),
      created_at   VARCHAR(64) NOT NULL,
      read_at      VARCHAR(64),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

    // --- Account recovery (single-use hashed tokens, expiring) ---
    `CREATE TABLE IF NOT EXISTS password_resets (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      token_hash VARCHAR(128) UNIQUE NOT NULL,
      expires_at VARCHAR(64) NOT NULL,
      used_at    VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS email_verifications (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      email      VARCHAR(255) NOT NULL,
      token_hash VARCHAR(128) UNIQUE NOT NULL,
      expires_at VARCHAR(64) NOT NULL,
      used_at    VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,
  ];
}

// Introspection-driven migrations.
//
// The old approach detected "duplicate column" by parsing driver error
// messages, which was fragile across SQLite/MySQL version pairings. These
// migrations ask the database what actually exists and only run each ALTER
// once the column is missing — idempotent by construction, and genuine
// schema problems still throw instead of being swallowed.
const LEGACY_ALTERS = [
  ['servers', 'is_public', 'ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0'],
  ['servers', 'is_discoverable', 'ALTER TABLE servers ADD COLUMN is_discoverable INTEGER NOT NULL DEFAULT 1'],
  ['channels', 'category_id', 'ALTER TABLE channels ADD COLUMN category_id VARCHAR(64) REFERENCES categories(id) ON DELETE SET NULL'],
  ['users', 'terms_version', 'ALTER TABLE users ADD COLUMN terms_version VARCHAR(16)'],
  ['users', 'privacy_version', 'ALTER TABLE users ADD COLUMN privacy_version VARCHAR(16)'],
  ['users', 'terms_accepted_at', 'ALTER TABLE users ADD COLUMN terms_accepted_at VARCHAR(64)'],
  ['users', 'password_changed_at', 'ALTER TABLE users ADD COLUMN password_changed_at VARCHAR(64)'],
  ['users', 'sessions_invalidated_at', 'ALTER TABLE users ADD COLUMN sessions_invalidated_at VARCHAR(64)'],
  // SQLite cannot ADD COLUMN ... UNIQUE. The email column is created without
  // the constraint here; uniqueness is enforced by a UNIQUE index below.
  ['users', 'email', 'ALTER TABLE users ADD COLUMN email VARCHAR(255)'],
  ['users', 'email_verified_at', 'ALTER TABLE users ADD COLUMN email_verified_at VARCHAR(64)'],
  ['messages', 'edited_at', 'ALTER TABLE messages ADD COLUMN edited_at VARCHAR(64)'],
  ['dm_messages', 'edited_at', 'ALTER TABLE dm_messages ADD COLUMN edited_at VARCHAR(64)'],
];

// Existing MySQL databases may already have these stored as TEXT. Convert
// before creating the indexes. MODIFY only runs while DATA_TYPE is still
// 'text'; once VARCHAR it is skipped, so this is naturally idempotent.
const MYSQL_MODIFY = [
  ['users', 'created_at', 'ALTER TABLE users MODIFY COLUMN created_at VARCHAR(64) NOT NULL'],
  ['servers', 'created_at', 'ALTER TABLE servers MODIFY COLUMN created_at VARCHAR(64) NOT NULL'],
  ['server_members', 'joined_at', 'ALTER TABLE server_members MODIFY COLUMN joined_at VARCHAR(64) NOT NULL'],
  ['messages', 'created_at', 'ALTER TABLE messages MODIFY COLUMN created_at VARCHAR(64) NOT NULL'],
  ['invites', 'created_at', 'ALTER TABLE invites MODIFY COLUMN created_at VARCHAR(64) NOT NULL'],
  ['invites', 'expires_at', 'ALTER TABLE invites MODIFY COLUMN expires_at VARCHAR(64) NULL'],
  ['revoked_tokens', 'expires_at', 'ALTER TABLE revoked_tokens MODIFY COLUMN expires_at VARCHAR(64) NOT NULL'],
  ['users', 'terms_version', 'ALTER TABLE users MODIFY COLUMN terms_version VARCHAR(16) NULL'],
  ['users', 'privacy_version', 'ALTER TABLE users MODIFY COLUMN privacy_version VARCHAR(16) NULL'],
  ['users', 'terms_accepted_at', 'ALTER TABLE users MODIFY COLUMN terms_accepted_at VARCHAR(64) NULL'],
  ['users', 'password_changed_at', 'ALTER TABLE users MODIFY COLUMN password_changed_at VARCHAR(64) NULL'],
  ['users', 'sessions_invalidated_at', 'ALTER TABLE users MODIFY COLUMN sessions_invalidated_at VARCHAR(64) NULL'],
  ['messages', 'edited_at', 'ALTER TABLE messages MODIFY COLUMN edited_at VARCHAR(64) NULL'],
  ['dm_messages', 'edited_at', 'ALTER TABLE dm_messages MODIFY COLUMN edited_at VARCHAR(64) NULL'],
];

const MYSQL_ADD = [
  ['users', 'email', 'ALTER TABLE users ADD COLUMN email VARCHAR(255) UNIQUE'],
];

const INDEXES = [
  'CREATE INDEX idx_members_server ON server_members(server_id)',
  'CREATE INDEX idx_roles_server ON roles(server_id)',
  'CREATE INDEX idx_member_roles_lookup ON member_roles(server_id, user_id)',
  'CREATE INDEX idx_channels_server ON channels(server_id)',
  'CREATE INDEX idx_messages_channel ON messages(channel_id, created_at)',
  // Backs ORDER BY created_at DESC scans that are not scoped to one
  // channel (the /api/activity feed). Write overhead is one narrow index.
  'CREATE INDEX idx_messages_created ON messages(created_at)',
  'CREATE INDEX idx_invites_server ON invites(server_id)',
  'CREATE INDEX idx_attachments_message ON attachments(message_id)',
  'CREATE INDEX idx_attachments_channel ON attachments(channel_id)',
  'CREATE INDEX idx_users_username ON users(username)',
  'CREATE INDEX idx_dm_members_user ON dm_members(user_id)',
  'CREATE INDEX idx_dm_messages_conv ON dm_messages(conversation_id, created_at)',
  'CREATE INDEX idx_friend_requests_to ON friend_requests(to_user_id, status)',
  'CREATE INDEX idx_friend_requests_from ON friend_requests(from_user_id, status)',
  'CREATE INDEX idx_friendships_user ON friendships(user_id)',
  'CREATE INDEX idx_notifications_user ON notifications(user_id, created_at)',
  'CREATE INDEX idx_password_resets_token ON password_resets(token_hash)',
  'CREATE INDEX idx_password_resets_user ON password_resets(user_id)',
  'CREATE INDEX idx_email_verifications_token ON email_verifications(token_hash)',
  'CREATE INDEX idx_users_email ON users(email)',
];

const MYSQL_COLUMN_SQL =
  'SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?';

async function sqliteColumn(conn, table, column) {
  const rows = await conn.all(`PRAGMA table_info(${table})`);
  return rows.find((r) => String(r.name) === column) || null;
}

async function mysqlColumn(conn, table, column) {
  const rows = await conn.all(MYSQL_COLUMN_SQL, [table, column]);
  return rows[0] ? { dataType: String(rows[0].DATA_TYPE || '').toLowerCase() } : null;
}

async function mysqlIndexExists(conn, table, index) {
  const rows = await conn.all(
    'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [table, index]
  );
  return parseInt(rows[0] && rows[0].n, 10) > 0;
}

async function applySchema(conn) {
  const dialect = conn.dialect;

  const engine =
    dialect === 'mysql'
      ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
      : '';

  // Create the base tables.
  for (const ddl of tables(engine)) {
    await conn.exec(ddl);
  }

  // SQLite legacy migrations: run only when the column does not exist.
  if (dialect === 'sqlite') {
    for (const [table, column, ddl] of LEGACY_ALTERS) {
      if (!(await sqliteColumn(conn, table, column))) {
        await conn.exec(ddl);
      }
    }
    // email uniqueness (SQLite can't express UNIQUE in ADD COLUMN). A plain
    // index also exists later in INDEXES; this is the actual constraint.
    await conn.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email)'
    );
  }

  // MySQL migrations. These MUST run before idx_messages_channel because
  // messages.created_at was historically TEXT.
  if (dialect === 'mysql') {
    for (const [table, column, ddl] of MYSQL_MODIFY) {
      const col = await mysqlColumn(conn, table, column);
      if (!col) {
        throw new Error(`schema: MySQL is missing ${table}.${column}; migration is unsafe`);
      }
      if (col.dataType === 'text') await conn.exec(ddl);
    }
    for (const [table, column, ddl] of MYSQL_ADD) {
      if (!(await mysqlColumn(conn, table, column))) {
        await conn.exec(ddl);
      }
    }
  }

  // Create indexes after all column types have been normalized.
  for (const idx of INDEXES) {
    if (dialect === 'sqlite') {
      await conn.exec(idx.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS'));
      continue;
    }
    const m = /INDEX (\w+) ON (\w+)/.exec(idx);
    if (!m || !(await mysqlIndexExists(conn, m[2], m[1]))) {
      await conn.exec(idx);
    }
  }
}

module.exports = {
  tables,
  applySchema,
};
