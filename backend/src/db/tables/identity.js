// Accounts: who someone is, how they prove it, and how a session ends.
//
// The first table in any schema and the one most foreign keys point at.
//
// Split out of schema.js, which held all forty-nine CREATE TABLE statements inside one
// function. The answer to "where is the data model" was a file too long to hold in your
// head, and the answer to any question about it was "scroll".

module.exports = (engine) => [

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
      email_verified_at VARCHAR(64),
      enforcement_state VARCHAR(16),
      enforcement_expires_at VARCHAR(64),
      enforcement_reason TEXT,
      enforcement_updated_at VARCHAR(64),
      bio TEXT,
      avatar_url VARCHAR(512),
      banner_url VARCHAR(512),
      status_text VARCHAR(128),
      -- Server-controlled bot identity. Was reachable only through the
      -- migration lists, so a freshly created database had the column added by
      -- the first boot's ALTER rather than by the schema itself. publicUser()
      -- reads it unconditionally, so it belongs in the canonical DDL.
      is_bot INTEGER NOT NULL DEFAULT 0,
      -- Second factor. totp_secret is AES-256-GCM encrypted at rest under a
      -- key derived from JWT_SECRET, not hashed: verification needs the
      -- original secret, and a plaintext column would make a database backup
      -- a 2FA bypass for every account in it.
      totp_secret TEXT,
      totp_enabled_at VARCHAR(64),
      -- Login throttling. Reset only on a successful password check, never on
      -- an attempt, so interleaving guesses with the real password cannot hold
      -- the counter at zero.
      login_fail_count INTEGER NOT NULL DEFAULT 0,
      login_locked_until VARCHAR(64),
      -- Bumped to revoke every outstanding session at once. A counter rather
      -- than a timestamp because JWT iat has one-second resolution. See
      -- invalidateSessions in routes/auth.js.
      session_version INTEGER NOT NULL DEFAULT 0
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS admins (
      user_id VARCHAR(64) PRIMARY KEY,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti        VARCHAR(128) PRIMARY KEY,
      expires_at VARCHAR(64) NOT NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS user_sessions (
    jti          VARCHAR(128) PRIMARY KEY,
    user_id      VARCHAR(64) NOT NULL,
    label        VARCHAR(128),
    user_agent   VARCHAR(512),
    ip           VARCHAR(64),
    created_at   VARCHAR(64) NOT NULL,
    last_seen_at VARCHAR(64) NOT NULL,
    revoked_at   VARCHAR(64),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

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

  `CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    id         VARCHAR(64) PRIMARY KEY,
    user_id    VARCHAR(64) NOT NULL,
    code_hash  VARCHAR(64) NOT NULL,
    used_at    VARCHAR(64),
    created_at VARCHAR(64) NOT NULL
  )${engine}`,

  `CREATE TABLE IF NOT EXISTS totp_used_steps (
    id      VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    step    INTEGER NOT NULL,
    used_at VARCHAR(64) NOT NULL
  )${engine}`,

  `CREATE TABLE IF NOT EXISTS profile_media (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      kind       VARCHAR(16) NOT NULL,
      filename   VARCHAR(255) NOT NULL,
      mime       VARCHAR(64) NOT NULL,
      size       INTEGER NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS account_deletion_requests (
      id              VARCHAR(64) PRIMARY KEY,
      user_id         VARCHAR(64) NOT NULL,
      status          VARCHAR(32) NOT NULL,
      -- Always 'GDPR'. Set by the server when the user asks, never chosen by
      -- an administrator, so the queue cannot be padded with ordinary
      -- moderation work.
      request_type    VARCHAR(32) NOT NULL DEFAULT 'GDPR',
      reason          TEXT,
      requested_at    VARCHAR(64) NOT NULL,
      reviewed_at     VARCHAR(64),
      reviewed_by     VARCHAR(64),
      processed_at    VARCHAR(64),
      cancelled_at    VARCHAR(64),
      anonymised_at   VARCHAR(64),
      UNIQUE (user_id, status),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,
];
