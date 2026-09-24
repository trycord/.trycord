// Import records from a SQLite file into the configured database.
// Run:  node scripts/migrate.js --from ./old-server.db
// Works sqlite -> mysql and sqlite -> sqlite. Never touches the source file.
// Tables are copied in foreign-key order; duplicate ids are skipped and counted.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../src/db');
require('dotenv').config();

const TABLES = [
  'users',
  'servers',
  'categories',
  'roles',
  'server_members',
  'member_roles',
  'channels',
  'messages',
  'invites',
  'revoked_tokens',
  // Phase 2 / overhaul features, in foreign-key order. Every table that the
  // schema creates is represented here so `db.connect(schema) then copy`
  // covers the whole feature set — not just the server-era tables.
  'dm_conversations',
  'dm_members',
  'dm_messages',
  'friend_requests',
  'friendships',
  'attachments',
  'notifications',
  'password_resets',
  'email_verifications',
  // Profile media reference only users.
  'profile_media',
  // Trust & Safety, in foreign-key order: admins/reports only reference
  // users; moderation_actions reference users + reports; appeals reference
  // users + moderation_actions; audit_logs reference users + reports.
  'admins',
  'reports',
  'moderation_actions',
  'appeals',
  'audit_logs',
];

function isDuplicate(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

async function main() {
  const fromIdx = process.argv.indexOf('--from');
  const from = fromIdx !== -1 ? process.argv[fromIdx + 1] : null;
  if (!from || !fs.existsSync(from)) {
    console.error('usage: node scripts/migrate.js --from <sqlite-file>');
    process.exit(1);
  }
  await db.connect(); // applies schema to the TARGET first
  const q = (name) => (db.dialect === 'mysql' ? '`' + name + '`' : '"' + name + '"');
  const src = new Database(path.resolve(from), { readonly: true });
  try {
    for (const table of TABLES) {
      let rows = [];
      try {
        rows = src.prepare(`SELECT * FROM "${table}"`).all();
      } catch (e) {
        console.log(`${table}: missing in source, skipped`);
        continue;
      }
      if (!rows.length) {
        console.log(`${table}: 0 rows`);
        continue;
      }
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => '?').join(', ');
      let copied = 0;
      let skipped = 0;
      for (const row of rows) {
        try {
          await db.run(
            `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${placeholders})`,
            cols.map((c) => row[c] === undefined ? null : row[c])
          );
          copied++;
        } catch (e) {
          if (isDuplicate(e)) skipped++;
          else throw e;
        }
      }
      console.log(`${table}: ${copied} copied, ${skipped} skipped (already present)`);
    }
  } finally {
    src.close();
    await db.close();
  }
  console.log('migration complete');
}

main().catch((e) => {
  console.error('migration failed: ' + (e.message || e));
  process.exit(1);
});
