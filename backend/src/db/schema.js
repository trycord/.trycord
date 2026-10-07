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
//
// ---- what this file is, and what is not ----
//
// It used to hold all forty-nine CREATE TABLE statements as one function, which made the
// answer to "where is the data model" a file you could not hold in your head. The DDL
// lives in ./tables now, one module per concern - accounts, communities, messaging,
// social, moderation, this instance - and this file is the part that genuinely has to
// know how the two engines differ: the migrations that bring an existing database up to
// date, the declared indexes, and the backfills.
const tableDefinitions = require('./tables');

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
  // Embeds, webhooks and applications. Added after the tables existed, so an
  // instance upgraded from before them needs these; a fresh one gets the columns
  // from the CREATE above and these are no-ops.
  ['webhooks', 'direction', "ALTER TABLE webhooks ADD COLUMN direction VARCHAR(16) NOT NULL DEFAULT 'outgoing'"],
  ['webhooks', 'use_count', 'ALTER TABLE webhooks ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0'],
  ['webhooks', 'last_used_at', 'ALTER TABLE webhooks ADD COLUMN last_used_at VARCHAR(64)'],
  ['bot_applications', 'description', 'ALTER TABLE bot_applications ADD COLUMN description VARCHAR(500)'],
  ['bot_applications', 'icon_url', 'ALTER TABLE bot_applications ADD COLUMN icon_url VARCHAR(512)'],
  ['bot_applications', 'status', "ALTER TABLE bot_applications ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active'"],
  ['bot_applications', 'updated_at', 'ALTER TABLE bot_applications ADD COLUMN updated_at VARCHAR(64)'],
  ['bot_commands', 'options', 'ALTER TABLE bot_commands ADD COLUMN options TEXT'],
  ['bot_commands', 'updated_at', 'ALTER TABLE bot_commands ADD COLUMN updated_at VARCHAR(64)'],
  ['message_embeds', 'video_url', 'ALTER TABLE message_embeds ADD COLUMN video_url VARCHAR(512)'],

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
  ['attachments', 'dm_conversation_id', 'ALTER TABLE attachments ADD COLUMN dm_conversation_id VARCHAR(64)'],
  ['attachments', 'dm_message_id', 'ALTER TABLE attachments ADD COLUMN dm_message_id VARCHAR(64)'],
  ['messages', 'thread_root_id', 'ALTER TABLE messages ADD COLUMN thread_root_id VARCHAR(64)'],
  ['dm_messages', 'thread_root_id', 'ALTER TABLE dm_messages ADD COLUMN thread_root_id VARCHAR(64)'],
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
  ['attachments', 'dm_conversation_id', 'ALTER TABLE attachments ADD COLUMN dm_conversation_id VARCHAR(64)'],
  ['attachments', 'dm_message_id', 'ALTER TABLE attachments ADD COLUMN dm_message_id VARCHAR(64)'],
  ['messages', 'thread_root_id', 'ALTER TABLE messages ADD COLUMN thread_root_id VARCHAR(64)'],
  ['dm_messages', 'thread_root_id', 'ALTER TABLE dm_messages ADD COLUMN thread_root_id VARCHAR(64)'],
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
  'CREATE INDEX idx_messages_thread ON messages(thread_root_id, seq)',
  'CREATE INDEX idx_membership_events ON server_membership_events(server_id, kind, created_at)',
  'CREATE INDEX idx_embeds_message ON message_embeds(message_id)',
  'CREATE INDEX idx_embeds_dm_message ON message_embeds(dm_message_id)',
  'CREATE UNIQUE INDEX idx_webhooks_incoming ON webhooks(secret_hash)',
  'CREATE INDEX idx_webhooks_server ON webhooks(server_id, active)',
  'CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at)',
  'CREATE INDEX idx_bot_apps_server ON bot_applications(server_id)',
  'CREATE INDEX idx_bot_commands_app ON bot_commands(application_id)',
  'CREATE INDEX idx_dm_messages_thread ON dm_messages(thread_root_id, seq)',
  'CREATE INDEX idx_attachments_message ON attachments(message_id)',
  'CREATE INDEX idx_attachments_channel ON attachments(channel_id)',
  // Every direct-message history page reads these, so without them a busy
  // conversation scans the whole table once per page load.
  'CREATE INDEX idx_attachments_dm_message ON attachments(dm_message_id)',
  'CREATE INDEX idx_attachments_dm_conversation ON attachments(dm_conversation_id)',
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
  // V2 privacy, safety, wellbeing and session tables. All are keyed by user_id
  // and read on paths that touch another person, so they are indexed for exactly
  // the lookups those paths perform.
  'CREATE INDEX idx_blocks_blocked ON user_blocks(blocked_id)',
  'CREATE INDEX idx_notif_prefs_server ON notification_prefs(server_id)',
  'CREATE INDEX idx_sessions_user ON user_sessions(user_id, revoked_at)',
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

async function mysqlColumnIsNullable(conn, table, column) {
  const rows = await conn.all(
    'SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return rows[0] ? String(rows[0].IS_NULLABLE || '').toUpperCase() === 'YES' : null;
}

// attachments.channel_id has to stop being NOT NULL so a direct message can
// carry a file - a DM has no channel to point at. On MySQL that is an instant
// metadata change with no table rewrite. SQLite cannot alter a column's
// nullability at all, so it needs the documented rebuild, which does copy every
// row. The rebuild only runs when the column is actually still NOT NULL, so a
// database that is already correct is never touched.
//
// A failure here must not stop the instance booting. Direct-message attachments
// are one feature; an instance that will not start is the whole application.
async function relaxAttachmentsChannelId(conn) {
  if (conn.dialect === 'mysql') {
    try {
      if (await mysqlColumnIsNullable(conn, 'attachments', 'channel_id')) return;
      await conn.exec('ALTER TABLE attachments MODIFY COLUMN channel_id VARCHAR(64) NULL');
    } catch (e) {
      console.warn('[schema] could not relax attachments.channel_id: ' + (e && e.message));
      console.warn('[schema] direct-message attachments are unavailable until it succeeds; everything else is unaffected');
    }
    return;
  }
  const col = await sqliteColumn(conn, 'attachments', 'channel_id');
  if (!col || !col.notnull) return;

  // PRAGMA foreign_keys is a no-op inside a transaction, and this rebuild drops
  // and recreates a table that other tables point at.
  await conn.exec('PRAGMA foreign_keys = OFF');
  try {
    await conn.exec('BEGIN');
    // A leftover from an interrupted run would make the create below fail on
    // boot. It is a scratch table by definition - the real one is rebuilt and
    // renamed over the top of it a few statements later - so discarding one is
    // always safe.
    await conn.exec('DROP TABLE IF EXISTS attachments_v2');
    await conn.exec(`CREATE TABLE IF NOT EXISTS attachments_v2 (
      id          VARCHAR(64) PRIMARY KEY,
      message_id  VARCHAR(64),
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
    )`);
    await conn.exec(`INSERT INTO attachments_v2
      (id, message_id, channel_id, uploader_id, filename, mime, size, url, created_at)
      SELECT id, message_id, channel_id, uploader_id, filename, mime, size, url, created_at
      FROM attachments`);
    await conn.exec('DROP TABLE attachments');
    await conn.exec('ALTER TABLE attachments_v2 RENAME TO attachments');
    // The rebuilt table has no indexes of its own, and INDEXES runs later
    // against the new name - but the rebuild is inside a transaction, so the
    // ones this surface needs most are put back here.
    await conn.exec('CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)');
    await conn.exec('CREATE INDEX IF NOT EXISTS idx_attachments_channel ON attachments(channel_id)');
    await conn.exec('CREATE INDEX IF NOT EXISTS idx_attachments_dm_message ON attachments(dm_message_id)');
    await conn.exec('CREATE INDEX IF NOT EXISTS idx_attachments_dm_conversation ON attachments(dm_conversation_id)');
    await conn.exec('COMMIT');
  } catch (e) {
    await conn.exec('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await conn.exec('PRAGMA foreign_keys = ON');
  }
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
  for (const ddl of tableDefinitions(engine)) {
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

  // After the two columns above exist, so the rebuild copies a table that is
  // already the right shape.
  await relaxAttachmentsChannelId(conn);

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
    await relaxAttachmentsChannelId(conn);
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
  return tableDefinitions('')
    .map((ddl) => {
      const m = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(ddl);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

module.exports = {
  // The DDL, from ./tables. Re-exported so callers get the schema from one place
  // rather than having to know it moved into a directory.
  tables: tableDefinitions,
  tableNames,
  applySchema,
  // The declared index list, so check.js can assert that every index the schema
  // claims to create actually exists after it runs, and that the ones whose
  // uniqueness the application depends on are created UNIQUE. Without this, an
  // index could be dropped or silently skipped and nothing would notice.
  INDEXES,
  // Exported for scripts/test-schema-parity.js. The SQLite and MySQL migration
  // lists describe the same schema changes and have to agree; the test needs to
  // read both to prove that, and exporting them keeps the check honest rather
  // than re-parsing this file.
  MIGRATIONS: { LEGACY_ALTERS, LEGACY_DROPS, MYSQL_MODIFY, MYSQL_ADD },
};
