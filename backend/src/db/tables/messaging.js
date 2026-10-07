// Messages and everything attached to one: embeds, files, pins, reactions, mutes.
//
// Direct conversations are here too rather than in a module of their own. They are the
// same shape - participants, messages, ordering - and they were ever separate only
// because they began as a simpler version of the same idea.

module.exports = (engine) => [

  `CREATE TABLE IF NOT EXISTS messages (
         id         VARCHAR(64) PRIMARY KEY,
         channel_id VARCHAR(64) NOT NULL,
         author_id  VARCHAR(64) NOT NULL,
         content    TEXT NOT NULL,
         created_at VARCHAR(64) NOT NULL,
         edited_at  VARCHAR(64),
         seq        INTEGER,
         client_nonce VARCHAR(64),
         -- Set on a reply to the id of the message the thread hangs from, NULL
         -- on an ordinary message. Deliberately not a self-reference: the root
         -- is simply the message nobody replied to, so a thread cannot point at
         -- itself and no second table is needed.
         thread_root_id VARCHAR(64),
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
         FOREIGN KEY (author_id) REFERENCES users(id)
       )${engine}`,

  `CREATE TABLE IF NOT EXISTS message_embeds (
      id          VARCHAR(64) PRIMARY KEY,
      message_id  VARCHAR(64),
      dm_conversation_id VARCHAR(64),
      dm_message_id      VARCHAR(64),
      url         VARCHAR(512) NOT NULL,
      site_name   VARCHAR(255),
      title       VARCHAR(512),
      description TEXT,
      image_url   VARCHAR(512),
      video_url   VARCHAR(512),
      kind        VARCHAR(32),
      status      VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (dm_conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (dm_message_id) REFERENCES dm_messages(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS attachments (
      id          VARCHAR(64) PRIMARY KEY,
      message_id  VARCHAR(64),
      -- Nullable, and carrying a conversation instead of a channel for a direct
      -- message. It was NOT NULL with a foreign key to channels, which made an
      -- attachment in a DM impossible to represent at all: there is no channel
      -- row to point at. Relaxing it changes nothing for existing rows, and a
      -- NULL foreign key satisfies the constraint in both engines - so a channel
      -- attachment and a direct one live in one table rather than two.
      channel_id  VARCHAR(64),
      dm_conversation_id VARCHAR(64),
      dm_message_id      VARCHAR(64),
      uploader_id VARCHAR(64) NOT NULL,
      filename    VARCHAR(255) NOT NULL,
      mime        VARCHAR(64) NOT NULL,
      size        INTEGER NOT NULL DEFAULT 0,
      url         VARCHAR(512) NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (dm_conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (dm_message_id) REFERENCES dm_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (uploader_id) REFERENCES users(id)
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS pinned_messages (
      message_id VARCHAR(64) PRIMARY KEY,
      channel_id VARCHAR(64) NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      pinned_by  VARCHAR(64) NOT NULL,
      pinned_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS reactions (
      message_id VARCHAR(64) NOT NULL,
      user_id    VARCHAR(64) NOT NULL,
      emoji      VARCHAR(32) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS muted_channels (
      user_id    VARCHAR(64) NOT NULL,
      channel_id VARCHAR(64) NOT NULL,
      muted_at   VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    )${engine}`,

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
         seq             INTEGER,
         client_nonce    VARCHAR(64),
         thread_root_id  VARCHAR(64),
         FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
         FOREIGN KEY (author_id) REFERENCES users(id)
       )${engine}`,

  `CREATE TABLE IF NOT EXISTS webhooks (
      id          VARCHAR(64) PRIMARY KEY,
      server_id   VARCHAR(64) NOT NULL,
      channel_id  VARCHAR(64),
      direction   VARCHAR(16) NOT NULL DEFAULT 'outgoing',
      name        VARCHAR(64) NOT NULL,
      url         VARCHAR(512),
      secret_hash VARCHAR(255) NOT NULL,
      created_by  VARCHAR(64) NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      use_count   INTEGER NOT NULL DEFAULT 0,
      last_used_at VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id          VARCHAR(64) PRIMARY KEY,
      webhook_id  VARCHAR(64) NOT NULL,
      event_type  VARCHAR(64) NOT NULL,
      payload     TEXT,
      status      VARCHAR(32) NOT NULL,
      status_code INTEGER,
      error       TEXT,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS bot_applications (
      id            VARCHAR(64) PRIMARY KEY,
      owner_user_id VARCHAR(64) NOT NULL,
      server_id     VARCHAR(64) NOT NULL,
      name          VARCHAR(64) NOT NULL,
      description   VARCHAR(500),
      icon_url      VARCHAR(512),
      -- 'active' while the application may post; 'disabled' while an
      -- administrator has switched it off without deleting its commands.
      status        VARCHAR(16) NOT NULL DEFAULT 'active',
      token_hash    VARCHAR(255) NOT NULL,
      created_at    VARCHAR(64) NOT NULL,
      updated_at    VARCHAR(64) NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS bot_commands (
      id             VARCHAR(64) PRIMARY KEY,
      application_id VARCHAR(64) NOT NULL,
      name           VARCHAR(32) NOT NULL,
      description    VARCHAR(255),
      response       TEXT NOT NULL,
      options        TEXT,
      created_at     VARCHAR(64) NOT NULL,
      updated_at     VARCHAR(64) NOT NULL,
      UNIQUE (application_id, name),
      FOREIGN KEY (application_id) REFERENCES bot_applications(id) ON DELETE CASCADE
    )${engine}`,
];
