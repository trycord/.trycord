// Sanity check for CI and local development: applies the portable schema to
// a throwaway SQLite database and verifies every table and the critical
// messages index exist. Catches DDL mistakes before they reach MySQL.
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-check-'));
  const sqlite = require('../src/db/sqlite');
  const { applySchema } = require('../src/db/schema');
  const conn = await sqlite.connect(path.join(dir, 'check.db'));
  await applySchema(conn);

  const rows = await conn.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const names = rows.map((r) => r.name);
  const required = [
    'users', 'servers', 'categories', 'roles', 'server_members',
    'member_roles', 'channels', 'messages', 'invites', 'revoked_tokens',
    'attachments', 'dm_conversations', 'dm_members', 'dm_messages',
    'friend_requests', 'friendships', 'notifications',
    'admins', 'reports', 'moderation_actions', 'appeals', 'audit_logs',
    'server_bans', 'pinned_messages', 'reactions', 'muted_channels',
    // V2 privacy/safety/wellbeing. Listed so a table cannot be dropped from
    // the DDL without CI noticing, the same as every other one here.
    'privacy_settings', 'user_blocks', 'notification_prefs',
    'wellbeing_settings', 'user_sessions',
  ];
  const missing = required.filter((t) => !names.includes(t));
  if (missing.length) throw new Error('missing tables: ' + missing.join(', '));

  // Every index the schema declares, not a hand-picked two. This is what catches
  // a DDL mistake - a misspelt column, an index that is valid-looking and fails
  // to apply - rather than only the one that once broke MySQL. Removing an entry
  // from INDEXES is a deliberate act; this file follows the list rather than
  // second-guessing it, and the three load-bearing ones below are named
  // separately so they cannot be quietly dropped from the list either.
  const { INDEXES } = require('../src/db/schema');
  const declared = [...new Set(
    INDEXES.map((ddl) => {
      const m = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/i.exec(ddl);
      return m ? { name: m[2], unique: !!m[1] } : null;
    }).filter(Boolean)
  )];
  if (!declared.length) throw new Error('no indexes parsed out of schema.js INDEXES');

  const present = await conn.all("SELECT name FROM sqlite_master WHERE type='index'");
  const presentNames = new Set(present.map((r) => r.name));
  const absent = declared.filter((i) => !presentNames.has(i.name)).map((i) => i.name);
  if (absent.length) throw new Error('declared but not created: ' + absent.join(', '));

  // Uniqueness is a correctness property, not a performance one, so it is
  // asserted rather than assumed. The message-sequence indexes are the
  // authority for ordering and the nonce indexes are what make a retried post
  // collapse onto the row the first attempt wrote; if either lost UNIQUE, the
  // application would still run and quietly do the wrong thing.
  for (const mustBeUnique of [
    'idx_messages_channel_seq', 'idx_dm_messages_conv_seq',
    'idx_messages_nonce', 'idx_dm_messages_nonce',
    'idx_servers_slug', 'idx_channels_slug',
  ]) {
    const entry = declared.find((i) => i.name === mustBeUnique);
    if (!entry) throw new Error(mustBeUnique + ' is not in the schema INDEXES list');
    if (!entry.unique) throw new Error(mustBeUnique + ' must be UNIQUE');
    const row = await conn.get("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?", [mustBeUnique]);
    if (!row) throw new Error('missing index ' + mustBeUnique);
    if (!/unique/i.test(String(row.sql || ''))) {
      throw new Error(mustBeUnique + ' was created without UNIQUE');
    }
  }

  // Email uniqueness is created outside the INDEXES list on purpose - SQLite
  // cannot express UNIQUE in ADD COLUMN - so it is checked by name here.
  const emailIdx = await conn.get(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_users_email_unique'"
  );
  if (!emailIdx) throw new Error('missing index idx_users_email_unique');
  if (!/unique/i.test(String(emailIdx.sql || ''))) {
    throw new Error('idx_users_email_unique must be UNIQUE');
  }

  // Named here as well as in INDEXES so that dropping one from the list itself
  // is caught, which the loop above cannot see.
  for (const critical of ['idx_messages_channel', 'idx_messages_created', 'idx_messages_channel_order']) {
    if (!declared.some((i) => i.name === critical)) {
      throw new Error(critical + ' is not in the schema INDEXES list');
    }
  }

  console.log(
    'schema check passed (' + names.length + ' tables, ' + declared.length +
    ' declared indexes created, uniqueness asserted)'
  );
  await conn.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('schema check failed: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
);
