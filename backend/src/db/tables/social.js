// How accounts relate to each other, and the per-account settings that decide who is
// allowed to reach them.
//
// The three settings tables belong here because that is where a reader looks for them,
// not because they relate to friendships. That is exactly why they were moved out of
// services/privacy.js: a file named privacy that also owned revoking a session is a file
// nobody opens when they want to revoke one.

module.exports = (engine) => [

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

  `CREATE TABLE IF NOT EXISTS friendships (
      user_id    VARCHAR(64) NOT NULL,
      friend_id  VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

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

  `CREATE TABLE IF NOT EXISTS user_blocks (
    user_id    VARCHAR(64) NOT NULL,
    blocked_id VARCHAR(64) NOT NULL,
    reason     TEXT,
    created_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id, blocked_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id    VARCHAR(64) NOT NULL,
    server_id  VARCHAR(64),
    -- JSON object of category -> bool. Sparse on purpose: an absent key means
    -- the global default rather than false, so a new category is not silently
    -- muted for everyone who already has a row.
    categories TEXT,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id, server_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS privacy_settings (
    user_id         VARCHAR(64) PRIMARY KEY,
    -- Who may send this user a friend request.
    friend_requests VARCHAR(16) NOT NULL DEFAULT 'anyone',
    -- Who may open a DM with this user.
    dms             VARCHAR(16) NOT NULL DEFAULT 'anyone',
    -- Who may see this user's online state.
    presence        VARCHAR(16) NOT NULL DEFAULT 'everyone',
    -- Whether this user appears in user search.
    discoverable    INTEGER NOT NULL DEFAULT 1,
    updated_at      VARCHAR(64) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS wellbeing_settings (
    user_id        VARCHAR(64) PRIMARY KEY,
    dnd_enabled    INTEGER NOT NULL DEFAULT 0,
    quiet_hours_on INTEGER NOT NULL DEFAULT 0,
    quiet_start    INTEGER NOT NULL DEFAULT 1320,
    quiet_end      INTEGER NOT NULL DEFAULT 480,
    -- A user-level motion preference, distinct from the OS setting: it is
    -- applied as a class on <html> so CSS can honour it, and it is what a
    -- reader who has asked for reduced motion actually gets.
    reduced_motion INTEGER NOT NULL DEFAULT 0,
    updated_at     VARCHAR(64) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // The searches a reader has saved, and the searches they have run.
  //
  // Both belong to the reader and to nobody else: the list is answered from
  // the owner alone, so one reader's saved search is never in another's list.
  // They cascade with the account, because a saved search is the reader's
  // own record of what they were looking for.
  `CREATE TABLE IF NOT EXISTS saved_searches (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      name       VARCHAR(128) NOT NULL,
      query      TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // The reader's recent queries, newest first. Bounded by the service rather
  // than by the table: the row count per reader is capped, so the table does
  // not grow without limit.
  `CREATE TABLE IF NOT EXISTS search_history (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      query      TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // Where a reader has got to in a channel.
  //
  // The instance has no other record of what a member has read, so this is
  // the cursor the "is:unread" filter is answered from. A channel with no
  // cursor has not been read at all.
  `CREATE TABLE IF NOT EXISTS channel_read_cursors (
      user_id      VARCHAR(64) NOT NULL,
      channel_id   VARCHAR(64) NOT NULL,
      last_read_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    )${engine}`,

  // A named piece of text the reader inserts. Their own: a template is never
  // anybody else's business, and it goes with the account.
  `CREATE TABLE IF NOT EXISTS message_templates (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      name       VARCHAR(128) NOT NULL,
      body       TEXT NOT NULL,
      shortcut   VARCHAR(32),
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // A named collection of things a reader has saved: a message, a file or a
  // link.
  //
  // A collection belongs to one community, because sharing is with a
  // community: a private collection is visible to its owner alone, a shared
  // one to the members of the community it belongs to.
  `CREATE TABLE IF NOT EXISTS saved_collections (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      name       VARCHAR(128) NOT NULL,
      visibility VARCHAR(16) NOT NULL DEFAULT 'private',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  // What is in a collection.
  //
  // A reference, never a copy: a message stays where it is and keeps its own
  // permissions, so sharing a collection shares the list, not the content.
  `CREATE TABLE IF NOT EXISTS saved_collection_items (
      id            VARCHAR(64) PRIMARY KEY,
      collection_id VARCHAR(64) NOT NULL,
      item_type     VARCHAR(16) NOT NULL,
      item_id       VARCHAR(64) NOT NULL,
      item_ref      VARCHAR(512),
      title         VARCHAR(255),
      created_at    VARCHAR(64) NOT NULL,
      FOREIGN KEY (collection_id) REFERENCES saved_collections(id) ON DELETE CASCADE
    )${engine}`,

  // The locale a reader asked for. Empty means "no preference", in which case
  // the instance default and the browser's Accept-Language decide.
  `CREATE TABLE IF NOT EXISTS reader_locale_settings (
      user_id    VARCHAR(64) PRIMARY KEY,
      locale     VARCHAR(32) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,
];
