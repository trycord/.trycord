// SQLite database: open the file, create tables if missing, export the handle.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function resolveDbPath() {
  let raw = String(process.env.DATABASE_URL || './server.db').trim().replace(/^["']|["']$/g, '');
  if (raw.startsWith('file:')) raw = raw.slice('file:'.length);
  if (!path.isAbsolute(raw)) raw = path.join(__dirname, '..', raw);
  return raw;
}

const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    owner_id    TEXT NOT NULL REFERENCES users(id),
    join_code   TEXT UNIQUE NOT NULL,
    is_public   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS server_members (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL REFERENCES users(id),
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    nickname  TEXT,
    joined_at TEXT NOT NULL,
    UNIQUE (user_id, server_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id        TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    topic     TEXT DEFAULT '',
    type      TEXT NOT NULL DEFAULT 'text',
    position  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti        TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
`);

// Migrations for databases created before these columns existed.
for (const sql of [
  'ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// Drop revocation entries whose tokens already expired.
db.prepare("DELETE FROM revoked_tokens WHERE expires_at < datetime('now')").run();
setInterval(() => {
  try {
    db.prepare("DELETE FROM revoked_tokens WHERE expires_at < datetime('now')").run();
  } catch { /* db closed during shutdown */ }
}, 60 * 60 * 1000).unref();

module.exports = db;
