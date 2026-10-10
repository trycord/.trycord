// Communities and the structure inside them: the community itself, who belongs to it,
// the channels, the categories they sit in, and the roles that say what a member may do.
//
// The two permission override tables are here rather than in a permissions module
// because they are schema. A category override and a channel override are columns and
// rows; permissions.js reads them.

module.exports = (engine) => [

  `CREATE TABLE IF NOT EXISTS servers (
      id              VARCHAR(64) PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      owner_id        VARCHAR(64) NOT NULL,
      join_code       VARCHAR(64) UNIQUE NOT NULL,
      is_public       INTEGER NOT NULL DEFAULT 0,
      is_discoverable INTEGER NOT NULL DEFAULT 1,
      -- Community identity media, served from the authenticated media route
      -- like a user avatar. Nullable: most communities never set one.
      icon_url        VARCHAR(512),
      banner_url      VARCHAR(512),
      created_at      VARCHAR(64) NOT NULL,
      enforcement_state VARCHAR(16),
      enforcement_reason TEXT,
      enforcement_updated_at VARCHAR(64),
      -- Human-readable URL segment. Backfilled from name at boot and unique, so
      -- a community can be linked as /c/my-community rather than by UUID.
      -- Users deliberately have no slug: the username already serves that role.
      slug          VARCHAR(64),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS server_members (
      id        VARCHAR(64) PRIMARY KEY,
      user_id   VARCHAR(64) NOT NULL,
      server_id VARCHAR(64) NOT NULL,
      nickname  TEXT,
      joined_at VARCHAR(64) NOT NULL,
      timeout_expires_at VARCHAR(64),
      UNIQUE (user_id, server_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS server_membership_events (
      id         VARCHAR(64) PRIMARY KEY,
      server_id  VARCHAR(64) NOT NULL,
      user_id    VARCHAR(64) NOT NULL,
      kind       VARCHAR(16) NOT NULL,
      reason     VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
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
      color       VARCHAR(16),
      position    INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL,
      is_default  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (server_id, name),
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

  `CREATE TABLE IF NOT EXISTS server_bans (
      id         VARCHAR(64) PRIMARY KEY,
      server_id  VARCHAR(64) NOT NULL,
      user_id    VARCHAR(64) NOT NULL,
      actor_id   VARCHAR(64) NOT NULL,
      reason     TEXT,
      expires_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      UNIQUE (server_id, user_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id)
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS channels (
      id          VARCHAR(64) PRIMARY KEY,
      server_id   VARCHAR(64) NOT NULL,
      category_id VARCHAR(64),
      name        VARCHAR(64) NOT NULL,
      -- Unique within its community, so /c/community/channel/general resolves
      -- without carrying the community id in the path.
      slug        VARCHAR(64),
      topic       TEXT,
      type        VARCHAR(16) NOT NULL DEFAULT 'text',
      position    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS category_permission_overrides (
         category_id VARCHAR(64) NOT NULL,
         permission  VARCHAR(64) NOT NULL,
         effect      VARCHAR(8) NOT NULL,
         PRIMARY KEY (category_id, permission),
         FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
       )${engine}`,

  `CREATE TABLE IF NOT EXISTS channel_permission_overrides (
         channel_id VARCHAR(64) NOT NULL,
         permission VARCHAR(64) NOT NULL,
         effect     VARCHAR(8) NOT NULL,
         PRIMARY KEY (channel_id, permission),
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
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

  `CREATE TABLE IF NOT EXISTS server_media (
      id         VARCHAR(64) PRIMARY KEY,
      server_id  VARCHAR(64) NOT NULL,
      kind       VARCHAR(16) NOT NULL,
      filename   VARCHAR(255) NOT NULL,
      mime       VARCHAR(64) NOT NULL,
      size       INTEGER NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,
];
