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
    'attachments',
  ];
  const missing = required.filter((t) => !names.includes(t));
  if (missing.length) throw new Error('missing tables: ' + missing.join(', '));

  // The index that broke MySQL when created_at was TEXT — must exist.
  const idx = await conn.all("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_channel'");
  if (!idx.length) throw new Error('missing index idx_messages_channel');

  console.log('schema check passed (' + names.length + ' tables, idx_messages_channel present)');
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
