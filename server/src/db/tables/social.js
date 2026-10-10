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
];
