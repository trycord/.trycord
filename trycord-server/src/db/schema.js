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
      created_at    VARCHAR(64) NOT NULL
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
  ];
}

// Legacy SQLite migrations.
const LEGACY_ALTERS = [
  'ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE servers ADD COLUMN is_discoverable INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE channels ADD COLUMN category_id VARCHAR(64) REFERENCES categories(id) ON DELETE SET NULL',
];

// Existing MySQL databases may already have created_at stored as TEXT.
// Convert those columns before creating the indexes.
const MYSQL_ALTERS = [
  'ALTER TABLE users MODIFY COLUMN created_at VARCHAR(64) NOT NULL',
  'ALTER TABLE servers MODIFY COLUMN created_at VARCHAR(64) NOT NULL',
  'ALTER TABLE server_members MODIFY COLUMN joined_at VARCHAR(64) NOT NULL',
  'ALTER TABLE messages MODIFY COLUMN created_at VARCHAR(64) NOT NULL',
  'ALTER TABLE invites MODIFY COLUMN created_at VARCHAR(64) NOT NULL',
  'ALTER TABLE invites MODIFY COLUMN expires_at VARCHAR(64) NULL',
  'ALTER TABLE revoked_tokens MODIFY COLUMN expires_at VARCHAR(64) NOT NULL',
];

const INDEXES = [
  'CREATE INDEX idx_members_server ON server_members(server_id)',
  'CREATE INDEX idx_roles_server ON roles(server_id)',
  'CREATE INDEX idx_member_roles_lookup ON member_roles(server_id, user_id)',
  'CREATE INDEX idx_channels_server ON channels(server_id)',
  'CREATE INDEX idx_messages_channel ON messages(channel_id, created_at)',
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
];

function isDuplicateObjectError(e) {
  const msg = String((e && e.message) || '');

  return (
    /duplicate column/i.test(msg) ||
    /duplicate key name/i.test(msg) ||
    e.code === 'ER_DUP_FIELDNAME' ||
    e.code === 'ER_DUP_KEYNAME'
  );
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

  // SQLite-only legacy migrations.
  if (dialect === 'sqlite') {
    for (const sql of LEGACY_ALTERS) {
      try {
        await conn.exec(sql);
      } catch (e) {
        if (!isDuplicateObjectError(e)) {
          throw e;
        }
      }
    }
  }

  // MySQL compatibility migrations.
  //
  // These MUST run before idx_messages_channel is created because
  // messages.created_at was historically TEXT.
  if (dialect === 'mysql') {
    for (const sql of MYSQL_ALTERS) {
      try {
        await conn.exec(sql);
      } catch (e) {
        // Ignore harmless "already correct" cases where supported.
        // Do NOT suppress actual schema errors.
        if (
          !/no change|already exists|duplicate column/i.test(
            String((e && e.message) || '')
          )
        ) {
          throw e;
        }
      }
    }
  }

  // Create indexes after all column types have been normalized.
  for (const idx of INDEXES) {
    const sql =
      dialect === 'sqlite'
        ? idx.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS')
        : idx;

    try {
      await conn.exec(sql);
    } catch (e) {
      if (!isDuplicateObjectError(e)) {
        throw e;
      }
    }
  }
}

module.exports = {
  tables,
  applySchema,
};
