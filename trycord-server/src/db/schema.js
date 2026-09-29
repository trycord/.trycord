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

    `CREATE TABLE IF NOT EXISTS categories (
         id        VARCHAR(64) PRIMARY KEY,
         server_id VARCHAR(64) NOT NULL,
         name      VARCHAR(64) NOT NULL,
         position  INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

    // Per-category permission overrides. This is what makes a category more
    // than a visual wrapper: a category can deny a permission for everyone,
    // or grant it regardless of roles. Rows are sparse - an absent row means
    // "inherit", never "deny".
    `CREATE TABLE IF NOT EXISTS category_permission_overrides (
         category_id VARCHAR(64) NOT NULL,
         permission  VARCHAR(64) NOT NULL,
         effect      VARCHAR(8) NOT NULL,
         PRIMARY KEY (category_id, permission),
         FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
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

    // Community bans: persistent per-server ban state. A ban row blocks
    // (re)joining; expiry makes temporary bans self-lifting. Distinct from
    // platform enforcement (admins table) — this is community moderation.
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
      -- Unique within its community, so /c/community/channel/general resolves
      -- without carrying the community id in the path.
      slug        VARCHAR(64),
      topic       TEXT,
      type        VARCHAR(16) NOT NULL DEFAULT 'text',
      position    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    )${engine}`,

    // Per-channel overrides. Declared after channels: InnoDB resolves foreign
    // keys at CREATE time, so a table that references channels before channels
    // exists fails with errno 150 on a fresh MySQL database.
    `CREATE TABLE IF NOT EXISTS channel_permission_overrides (
         channel_id VARCHAR(64) NOT NULL,
         permission VARCHAR(64) NOT NULL,
         effect     VARCHAR(8) NOT NULL,
         PRIMARY KEY (channel_id, permission),
         FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
       )${engine}`,

    `CREATE TABLE IF NOT EXISTS messages (
         id         VARCHAR(64) PRIMARY KEY,
         channel_id VARCHAR(64) NOT NULL,
         author_id  VARCHAR(64) NOT NULL,
         content    TEXT NOT NULL,
         created_at VARCHAR(64) NOT NULL,
         edited_at  VARCHAR(64),
         seq        INTEGER,
         client_nonce VARCHAR(64),
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
         seq             INTEGER,
         client_nonce    VARCHAR(64),
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

    // --- Trust & Safety (platform administration, separate from server
    // moderation). Authority lives server-side in the admins table only;
    // there is no client-declared isAdmin flag anywhere.
    `CREATE TABLE IF NOT EXISTS admins (
      user_id VARCHAR(64) PRIMARY KEY,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

    // --- Profile media (avatars / banners). Files on disk keyed by id (pf-
    // prefixed); this row carries the exact sniffed mime for serving and the
    // ownership/kind trace for cleanup.
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

    `CREATE TABLE IF NOT EXISTS reports (
      id         VARCHAR(64) PRIMARY KEY,
      reporter_id VARCHAR(64) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id   VARCHAR(64) NOT NULL,
      reason      VARCHAR(255) NOT NULL,
      description TEXT,
      status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      assigned_admin_id VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      resolved_at VARCHAR(64),
      resolution  VARCHAR(16),
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_admin_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS moderation_actions (
      id         VARCHAR(64) PRIMARY KEY,
      actor_id   VARCHAR(64) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id  VARCHAR(64) NOT NULL,
      action_type VARCHAR(24) NOT NULL,
      reason     TEXT NOT NULL,
      expires_at VARCHAR(64),
      report_id  VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS appeals (
      id          VARCHAR(64) PRIMARY KEY,
      user_id     VARCHAR(64) NOT NULL,
      action_id   VARCHAR(64) NOT NULL,
      reason      TEXT NOT NULL,
      status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      reviewer_id VARCHAR(64),
      decision    VARCHAR(16),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (action_id) REFERENCES moderation_actions(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

    // Static page editor. One row per editable page, holding structured content
    // rather than HTML: an array of typed blocks, so an administrator cannot
    // inject script or arbitrary markup into a legal page. The original file in
    // public/ stays the fallback until a page is published, so an instance that
    // never uses the editor behaves exactly as before.
    `CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    id         VARCHAR(64) PRIMARY KEY,
    user_id    VARCHAR(64) NOT NULL,
    code_hash  VARCHAR(64) NOT NULL,
    used_at    VARCHAR(64),
    created_at VARCHAR(64) NOT NULL
  )${engine}`,

  // One time pad for TOTP steps. Without it a code observed in transit stays
  // valid for the rest of its 30 second window, which is long enough to relay.
  // Steps are only worth remembering for as long as they could be replayed.
  `CREATE TABLE IF NOT EXISTS totp_used_steps (
    id      VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    step    INTEGER NOT NULL,
    used_at VARCHAR(64) NOT NULL
  )${engine}`,

  `CREATE TABLE IF NOT EXISTS pages (
      id          VARCHAR(64) PRIMARY KEY,
      route       VARCHAR(64) NOT NULL UNIQUE,
      title       VARCHAR(128) NOT NULL,
      description VARCHAR(255),
      status      VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
      draft_body  TEXT,
      draft_author VARCHAR(64),
      draft_at    VARCHAR(64),
      published_body TEXT,
      published_author VARCHAR(64),
      published_at VARCHAR(64),
      legal       INTEGER NOT NULL DEFAULT 0,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (draft_author) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (published_author) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

    // Every save is kept, publish or not. Restoring a revision creates a new
    // revision rather than rewriting history, so an accidental publish is
    // recoverable and the sequence of decisions stays auditable.
    `CREATE TABLE IF NOT EXISTS page_revisions (
      id          VARCHAR(64) PRIMARY KEY,
      page_id     VARCHAR(64) NOT NULL,
      revision    INTEGER NOT NULL,
      body        TEXT NOT NULL,
      title       VARCHAR(128) NOT NULL,
      state       VARCHAR(16) NOT NULL,
      author_id   VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL,
      UNIQUE (page_id, revision),
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

    `CREATE TABLE IF NOT EXISTS audit_logs (
      id         VARCHAR(64) PRIMARY KEY,
      actor_id   VARCHAR(64) NOT NULL,
      action     VARCHAR(64) NOT NULL,
      target_type VARCHAR(32),
      target_id  VARCHAR(64),
      reason     TEXT,
      report_id  VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

    // Account deletion requests. The account is anonymised, not hard-deleted:
    // moderation and audit rows reference the actor and have to outlive them,
    // so the user row survives with the identity columns cleared. Deleting the
    // row instead would cascade the evidence away.
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

    // Channel engagement (message search/pins/reactions/mutes): one pin per
    // message, one reaction per (message, user, emoji), one mute per
    // (user, channel). Message rows cascade so deletes clean these up.
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

    // Instance-wide announcements. Deliberately NOT global/cross-instance:
    // these belong to this deployment only and are authored by platform
    // admins. `level` drives client emphasis; `active_at` is when it went
    // live; `expires_at` is an optional end (NULL = runs until retired), so
    // banners persist across restarts rather than living in memory.
    `CREATE TABLE IF NOT EXISTS announcements (
      id          VARCHAR(64) PRIMARY KEY,
      body        TEXT NOT NULL,
      level       VARCHAR(16) NOT NULL DEFAULT 'info',
      link_label  VARCHAR(64),
      link_href   VARCHAR(512),
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  VARCHAR(64) NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64),
      expires_at  VARCHAR(64),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
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
  // Community identity media. Mirrored in MYSQL_ADD - an ADDED column is
  // needed on BOTH engines, because CREATE TABLE IF NOT EXISTS is a no-op on
  // an existing database either way. Only the type-normalisation entries in
  // MYSQL_MODIFY are engine-specific.
  ['servers', 'icon_url', 'ALTER TABLE servers ADD COLUMN icon_url VARCHAR(512)'],
  ['servers', 'banner_url', 'ALTER TABLE servers ADD COLUMN banner_url VARCHAR(512)'],
  ['users', 'terms_version', 'ALTER TABLE users ADD COLUMN terms_version VARCHAR(16)'],
  ['users', 'privacy_version', 'ALTER TABLE users ADD COLUMN privacy_version VARCHAR(16)'],
  ['users', 'terms_accepted_at', 'ALTER TABLE users ADD COLUMN terms_accepted_at VARCHAR(64)'],
  ['users', 'password_changed_at', 'ALTER TABLE users ADD COLUMN password_changed_at VARCHAR(64)'],
  ['users', 'sessions_invalidated_at', 'ALTER TABLE users ADD COLUMN sessions_invalidated_at VARCHAR(64)'],
  // Self-assignable roles are gone: there is no self_assign column, no
  // self-role endpoint, and no role picker. Roles are assigned by authorised
  // community staff and nothing else. A database created before this still has
  // the column, so it is dropped below rather than left as dead state that a
  // future reader could mistake for a supported feature.
  // SQLite cannot ADD COLUMN ... UNIQUE. The email column is created without
  // the constraint here; uniqueness is enforced by a UNIQUE index below.
  ['users', 'email', 'ALTER TABLE users ADD COLUMN email VARCHAR(255)'],
  ['users', 'email_verified_at', 'ALTER TABLE users ADD COLUMN email_verified_at VARCHAR(64)'],
  ['messages', 'edited_at', 'ALTER TABLE messages ADD COLUMN edited_at VARCHAR(64)'],
  ['dm_messages', 'edited_at', 'ALTER TABLE dm_messages ADD COLUMN edited_at VARCHAR(64)'],
  // Canonical ordering + idempotency. `seq` is a per-channel (per-conversation
  // for DMs) monotonic counter and is the authoritative order. `client_nonce`
  // is a caller-supplied key that makes a retried POST collapse onto the
  // message the first attempt already persisted.
  ['messages', 'seq', 'ALTER TABLE messages ADD COLUMN seq INTEGER'],
  ['messages', 'client_nonce', 'ALTER TABLE messages ADD COLUMN client_nonce VARCHAR(64)'],
  ['dm_messages', 'seq', 'ALTER TABLE dm_messages ADD COLUMN seq INTEGER'],
  ['dm_messages', 'client_nonce', 'ALTER TABLE dm_messages ADD COLUMN client_nonce VARCHAR(64)'],
  // Trust & Safety: enforcement state mirrors the authoritative
  // moderation_actions records so the hot auth path is one users read.
  ['users', 'enforcement_state', 'ALTER TABLE users ADD COLUMN enforcement_state VARCHAR(16)'],
  ['users', 'enforcement_expires_at', 'ALTER TABLE users ADD COLUMN enforcement_expires_at VARCHAR(64)'],
  ['users', 'enforcement_reason', 'ALTER TABLE users ADD COLUMN enforcement_reason TEXT'],
  ['users', 'enforcement_updated_at', 'ALTER TABLE users ADD COLUMN enforcement_updated_at VARCHAR(64)'],
  ['servers', 'enforcement_state', 'ALTER TABLE servers ADD COLUMN enforcement_state VARCHAR(16)'],
  ['servers', 'enforcement_reason', 'ALTER TABLE servers ADD COLUMN enforcement_reason TEXT'],
  ['servers', 'enforcement_updated_at', 'ALTER TABLE servers ADD COLUMN enforcement_updated_at VARCHAR(64)'],
  // Profiles: public identity fields (Slice 2). NULL = not set.
  ['users', 'bio', 'ALTER TABLE users ADD COLUMN bio TEXT'],
  ['users', 'avatar_url', 'ALTER TABLE users ADD COLUMN avatar_url VARCHAR(512)'],
  ['users', 'banner_url', 'ALTER TABLE users ADD COLUMN banner_url VARCHAR(512)'],
  ['users', 'status_text', 'ALTER TABLE users ADD COLUMN status_text VARCHAR(128)'],
  // F1/F2 community overhaul: persisted role colors, bot identity, timeouts.
  ['users', 'is_bot', 'ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0'],
  ['roles', 'color', 'ALTER TABLE roles ADD COLUMN color VARCHAR(16)'],
  ['server_members', 'timeout_expires_at', 'ALTER TABLE server_members ADD COLUMN timeout_expires_at VARCHAR(64)'],
  // Second factor + login throttling. Mirrored in MYSQL_ADD.
  ['users', 'totp_secret', 'ALTER TABLE users ADD COLUMN totp_secret TEXT'],
  ['users', 'totp_enabled_at', 'ALTER TABLE users ADD COLUMN totp_enabled_at VARCHAR(64)'],
  ['users', 'login_fail_count', 'ALTER TABLE users ADD COLUMN login_fail_count INTEGER NOT NULL DEFAULT 0'],
  ['users', 'login_locked_until', 'ALTER TABLE users ADD COLUMN login_locked_until VARCHAR(64)'],
  ['users', 'session_version', 'ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0'],
  // Human-readable URL segments. Mirrored in MYSQL_ADD.
  ['servers', 'slug', 'ALTER TABLE servers ADD COLUMN slug VARCHAR(64)'],
  ['channels', 'slug', 'ALTER TABLE channels ADD COLUMN slug VARCHAR(64)'],
];

// Existing MySQL databases may already have these stored as TEXT. Convert
// before creating the indexes. MODIFY only runs while DATA_TYPE is still
// 'text'; once VARCHAR it is skipped, so this is naturally idempotent.
// Columns that used to exist and must not. Removing a feature is not complete
// while its column survives in an existing database: a reader of that schema
// would reasonably assume the feature is still supported.
//
// SQLite only learned ALTER TABLE ... DROP COLUMN in 3.35 (2021). Where the
// bundled SQLite is older the drop is skipped and the column is simply unused -
// it is never read or written, so this is inert, not a second code path. Both
// engines therefore treat a failure here as "already gone".
const LEGACY_DROPS = [
  ['roles', 'self_assign'],
];

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
  ['users', 'enforcement_state', 'ALTER TABLE users ADD COLUMN enforcement_state VARCHAR(16)'],
  ['users', 'enforcement_expires_at', 'ALTER TABLE users ADD COLUMN enforcement_expires_at VARCHAR(64)'],
  ['users', 'enforcement_reason', 'ALTER TABLE users ADD COLUMN enforcement_reason TEXT'],
  ['users', 'enforcement_updated_at', 'ALTER TABLE users ADD COLUMN enforcement_updated_at VARCHAR(64)'],
  ['servers', 'enforcement_state', 'ALTER TABLE servers ADD COLUMN enforcement_state VARCHAR(16)'],
  ['servers', 'enforcement_reason', 'ALTER TABLE servers ADD COLUMN enforcement_reason TEXT'],
  ['servers', 'enforcement_updated_at', 'ALTER TABLE servers ADD COLUMN enforcement_updated_at VARCHAR(64)'],
  ['users', 'bio', 'ALTER TABLE users ADD COLUMN bio TEXT'],
  ['users', 'avatar_url', 'ALTER TABLE users ADD COLUMN avatar_url VARCHAR(512)'],
  ['users', 'banner_url', 'ALTER TABLE users ADD COLUMN banner_url VARCHAR(512)'],
  ['users', 'status_text', 'ALTER TABLE users ADD COLUMN status_text VARCHAR(128)'],
  ['users', 'is_bot', 'ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0'],
  ['roles', 'color', 'ALTER TABLE roles ADD COLUMN color VARCHAR(16)'],
  ['server_members', 'timeout_expires_at', 'ALTER TABLE server_members ADD COLUMN timeout_expires_at VARCHAR(64)'],
  // Second factor + login throttling. Mirrored in LEGACY_ALTERS.
  ['users', 'totp_secret', 'ALTER TABLE users ADD COLUMN totp_secret TEXT'],
  ['users', 'totp_enabled_at', 'ALTER TABLE users ADD COLUMN totp_enabled_at VARCHAR(64)'],
  ['users', 'login_fail_count', 'ALTER TABLE users ADD COLUMN login_fail_count INTEGER NOT NULL DEFAULT 0'],
  ['users', 'login_locked_until', 'ALTER TABLE users ADD COLUMN login_locked_until VARCHAR(64)'],
  ['users', 'session_version', 'ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0'],
  // Human-readable URL segments. See services/slugs.js.
  ['servers', 'slug', 'ALTER TABLE servers ADD COLUMN slug VARCHAR(64)'],
  ['channels', 'slug', 'ALTER TABLE channels ADD COLUMN slug VARCHAR(64)'],
  // --- parity block ---------------------------------------------------------
  // Every column below is ALSO declared in LEGACY_ALTERS, which only runs on
  // SQLite. They were missing here, so on an existing MySQL/MariaDB database
  // `CREATE TABLE IF NOT EXISTS` was a no-op, these columns were never
  // created, and startup then died in backfillSequence() on
  // `WHERE seq IS NULL` with "Unknown column 'seq' in 'where clause'".
  //
  // scripts/test-schema-parity.js asserts that anything added to
  // LEGACY_ALTERS is also reachable from the MySQL path, so the two lists
  // cannot silently drift apart again.
  ['servers', 'is_public', 'ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0'],
  ['servers', 'is_discoverable', 'ALTER TABLE servers ADD COLUMN is_discoverable INTEGER NOT NULL DEFAULT 1'],
  // Community identity media. Mirrored in LEGACY_ALTERS.
  ['servers', 'icon_url', 'ALTER TABLE servers ADD COLUMN icon_url VARCHAR(512)'],
  ['servers', 'banner_url', 'ALTER TABLE servers ADD COLUMN banner_url VARCHAR(512)'],
  // Declared without the foreign key, matching every other entry in this
  // list: the column is nullable (categories are optional) and the app already
  // treats a NULL category as "no category". The constraint exists on
  // databases created from the base DDL.
  ['channels', 'category_id', 'ALTER TABLE channels ADD COLUMN category_id VARCHAR(64)'],
  ['users', 'email_verified_at', 'ALTER TABLE users ADD COLUMN email_verified_at VARCHAR(64)'],
  // Canonical ordering + idempotency. Types must match the base DDL exactly,
  // or the unique indexes built afterwards would index a different type than
  // the INSERTs write.
  ['messages', 'seq', 'ALTER TABLE messages ADD COLUMN seq INTEGER'],
  ['messages', 'client_nonce', 'ALTER TABLE messages ADD COLUMN client_nonce VARCHAR(64)'],
  ['dm_messages', 'seq', 'ALTER TABLE dm_messages ADD COLUMN seq INTEGER'],
  ['dm_messages', 'client_nonce', 'ALTER TABLE dm_messages ADD COLUMN client_nonce VARCHAR(64)'],
];

const INDEXES = [
  'CREATE INDEX idx_members_server ON server_members(server_id)',
  'CREATE INDEX idx_bans_server ON server_bans(server_id)',
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
  'CREATE INDEX idx_profile_media_user ON profile_media(user_id)',
  // Trust & Safety access patterns: report queues, per-target enforcement
  // history, appeal inboxes, and the audit trail.
  'CREATE INDEX idx_reports_status ON reports(status, created_at)',
  'CREATE INDEX idx_reports_target ON reports(target_type, target_id)',
  'CREATE INDEX idx_mod_actions_target ON moderation_actions(target_type, target_id)',
  'CREATE INDEX idx_mod_actions_actor ON moderation_actions(actor_id, created_at)',
  'CREATE INDEX idx_mod_actions_active ON moderation_actions(action_type, expires_at)',
  'CREATE INDEX idx_appeals_user ON appeals(user_id, status)',
  'CREATE INDEX idx_appeals_action ON appeals(action_id)',
  'CREATE INDEX idx_audit_created ON audit_logs(created_at)',
  'CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at)',
  'CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id)',
  'CREATE INDEX idx_audit_action ON audit_logs(action)',
  'CREATE INDEX idx_deletion_status ON account_deletion_requests(status, requested_at)',
  'CREATE INDEX idx_pages_status ON pages(status)',
  'CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, revision)',
  // servers had no indexes at all. Discovery is reachable without
  // authentication and filters on these columns, so it was a full scan
  // (twice: once to count, once to page).
  'CREATE INDEX idx_servers_discovery ON servers(is_public, is_discoverable, enforcement_state)',
  'CREATE INDEX idx_servers_owner ON servers(owner_id)',
  'CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes(user_id, used_at)',
  'CREATE INDEX idx_totp_used_user ON totp_used_steps(user_id, used_at)',
  'CREATE UNIQUE INDEX idx_servers_slug ON servers(slug)',
  // Unique per community, not globally: two communities may both have a
  // #general, and the community is already in the path.
  'CREATE UNIQUE INDEX idx_channels_slug ON channels(server_id, slug)',
  'CREATE INDEX idx_pins_channel ON pinned_messages(channel_id, pinned_at)',
  'CREATE INDEX idx_reactions_message ON reactions(message_id)',
  'CREATE INDEX idx_muted_user ON muted_channels(user_id)',
  // ---- Access patterns that were measured as full table scans ----------
  // `categories` was the only table in the schema with no index at all,
  // and its read (by community) runs on every server entry and on every
  // structural realtime event, so this was a whole-instance scan of the
  // category table to read one community's channels.
  'CREATE INDEX idx_categories_server ON categories(server_id, position)',
  // roles.remove() counts holders of a role before deleting it.
  // member_roles' primary key leads with (server_id, user_id), so
  // filtering by role_id alone could not use any index.
  'CREATE INDEX idx_member_roles_role ON member_roles(role_id)',
  // The reporter's own report list orders by created_at, and no existing
  // index has reporter_id as a leading column.
  'CREATE INDEX idx_reports_reporter ON reports(reporter_id, created_at)',
  // Unfiltered appeal queues order by created_at DESC.
  'CREATE INDEX idx_appeals_created ON appeals(created_at)',
  // The live announcement banner is fetched by every signed-in client on a
  // poll; the table had no indexes, so each poll sorted the whole table.
  'CREATE INDEX idx_announcements_active ON announcements(active, created_at)',
  // Messages are read as ORDER BY created_at DESC, id DESC. The existing
  // (channel_id, created_at) index cannot supply the id tiebreaker, so
  // every page of history ended in a temp sort. This makes the ordering
  // total, which also removes the possibility of two messages sharing a
  // created_at being ordered by a random UUID.
  'CREATE INDEX idx_messages_channel_order ON messages(channel_id, created_at, id)',
  // Same for direct messages.
  'CREATE INDEX idx_dm_messages_order ON dm_messages(conversation_id, created_at, id)',
  // Roster ordering: the member list sorts by joined_at within a server.
  'CREATE INDEX idx_members_server_joined ON server_members(server_id, joined_at)',
  // Role lists sort by position within a server.
  'CREATE INDEX idx_roles_server_position ON roles(server_id, position)',
  // Channel lists sort by position then name within a server.
  'CREATE INDEX idx_channels_server_order ON channels(server_id, position, name)',
  // ---- Canonical message ordering -----------------------------------------
  // seq is the authoritative order within a channel. The UNIQUE constraint is
  // what makes it trustworthy: two concurrent inserts cannot both claim the
  // same value, so the loser gets a constraint violation and retries rather
  // than silently writing an ambiguous order. It also lets history be walked
  // with a single-column cursor instead of a (created_at, id) tuple, which is
  // what removed the random-UUIDv4 tie-break.
  'CREATE UNIQUE INDEX idx_messages_channel_seq ON messages(channel_id, seq)',
  'CREATE UNIQUE INDEX idx_dm_messages_conv_seq ON dm_messages(conversation_id, seq)',
  // Idempotency. A retried POST carrying the same nonce resolves to the row
  // the first attempt wrote, so a lost response cannot produce a duplicate.
  // Partial-unique is not portable, so NULLs are excluded explicitly: SQLite
  // and MySQL both treat NULL as distinct in a unique index, which is
  // exactly the behaviour we want for callers that send no nonce.
  'CREATE UNIQUE INDEX idx_messages_nonce ON messages(channel_id, client_nonce)',
  'CREATE UNIQUE INDEX idx_dm_messages_nonce ON dm_messages(conversation_id, client_nonce)',
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

  // Retire columns that belong to removed features. After the base DDL, so the
  // table is guaranteed to exist: on a fresh database there is nothing to drop,
  // and on an existing one the column goes. Best effort, because a column that
  // is already gone - or a SQLite older than 3.35, which cannot drop one - is
  // not an error. The code never reads or writes it either way.
  for (const [table, column] of LEGACY_DROPS) {
    try {
      await conn.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch {
      // Already absent, or unsupported here. Inert either way.
    }
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

  // Backfill canonical ordering before the unique index is created, so the
  // index only ever sees a complete, duplicate-free column.
  //
  // Ordering for the backfill is (created_at, id) - the same tuple the old
  // read path used. That is deliberate: existing history keeps exactly the
  // order it already displayed, rather than being reshuffled by whatever
  // order rows happen to come back from the storage engine. The random-UUID
  // tie-break is a property of the *old* order; it stops mattering the
  // moment every row has an explicit seq.
  await backfillSequence(conn, 'messages', 'channel_id');
  await backfillSequence(conn, 'dm_messages', 'conversation_id');

  // Slugs must be populated and de-duplicated before the unique index below is
  // created, for the same reason messages.seq is backfilled first: building the
  // index over duplicates fails, and a failure here would stop every instance
  // from booting.
  await require('../services/slugs').backfill(conn);

  // users.email must be unique on every dialect, including a MySQL database
  // created by an older build. CREATE TABLE IF NOT EXISTS is a no-op on an
  // existing table and ALTER TABLE ADD COLUMN UNIQUE is not portable, so the
  // guarantee is expressed as a unique index instead. MySQL has no
  // CREATE INDEX IF NOT EXISTS, hence the existence check.
  if (dialect === 'mysql') {
    if (!(await mysqlIndexExists(conn, 'users', 'idx_users_email_unique'))) {
      const dupes = await conn.all(
        "SELECT email FROM users WHERE email IS NOT NULL AND email <> '' GROUP BY email HAVING COUNT(*) > 1 LIMIT 5"
      );
      if (dupes.length) {
        // Refusing is the only safe answer: building the index over duplicate
        // values fails, and silently allowing duplicates breaks the assumption
        // that an email identifies exactly one account.
        throw new Error(
          'schema: users.email has duplicate values, so the unique index cannot be built. ' +
          'Resolve the duplicates listed below, then restart: ' +
          JSON.stringify(dupes.map((d) => d.email))
        );
      }
      await conn.exec('CREATE UNIQUE INDEX idx_users_email_unique ON users(email)');
    }
  }

  // Create indexes after all column types have been normalized.
  for (const idx of INDEXES) {
    if (dialect === 'sqlite') {
      // Must handle "CREATE UNIQUE INDEX" as well as "CREATE INDEX" - a plain
      // string replace of 'CREATE INDEX' silently does nothing to the former,
      // so the statement re-runs on every boot and startup fails with
      // "index already exists". The pattern is anchored so only a leading
      // CREATE [UNIQUE] INDEX is rewritten.
      await conn.exec(idx.replace(
        /^CREATE\s+(UNIQUE\s+)?INDEX/i,
        (_m, u) => 'CREATE ' + (u || '') + 'INDEX IF NOT EXISTS'
      ));
      continue;
    }
    const m = /INDEX (\w+) ON (\w+)/.exec(idx);
    if (!m || !(await mysqlIndexExists(conn, m[2], m[1]))) {
      await conn.exec(idx);
    }
  }
}

// Assign seq = 1..N per scope for any row that does not have one yet.
// Re-runnable: rows that already carry a seq are skipped, and scopes with
// nothing to do are never touched.
async function backfillSequence(conn, table, scope) {
  const scopes = await conn.all(
    `SELECT DISTINCT ${scope} AS s FROM ${table} WHERE seq IS NULL`
  );
  if (!scopes.length) return;
  let total = 0;
  for (const { s } of scopes) {
    const rows = await conn.all(
      `SELECT id FROM ${table} WHERE ${scope} = ? AND seq IS NULL ORDER BY created_at ASC, id ASC`,
      [s]
    );
    for (let i = 0; i < rows.length; i++) {
      await conn.run(`UPDATE ${table} SET seq = ? WHERE id = ?`, [i + 1, rows[i].id]);
    }
    total += rows.length;
  }
  if (total) {
    // eslint-disable-next-line no-console
    console.log(`[schema] backfilled ${total} ${table}.seq values`);
  }
}

// Table names in creation order, which is also foreign-key order: every table
// is declared after the tables it references. Anything that needs to walk every
// table (data import, parity checks) reads this instead of keeping its own list,
// so a new table cannot be silently left out.
function tableNames() {
  return tables('')
    .map((ddl) => {
      const m = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(ddl);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

module.exports = {
  tables,
  tableNames,
  applySchema,
  // Exported for scripts/test-schema-parity.js. The SQLite and MySQL migration
  // lists describe the same schema changes and have to agree; the test needs to
  // read both to prove that, and exporting them keeps the check honest rather
  // than re-parsing this file.
  MIGRATIONS: { LEGACY_ALTERS, LEGACY_DROPS, MYSQL_MODIFY, MYSQL_ADD },
};
