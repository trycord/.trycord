// Seed a demo account + server so the app is usable on first run.
// Run:  npm run seed   (from trycord-server/)
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../src/db');

const now = () => new Date().toISOString();

let user = db.prepare('SELECT * FROM users WHERE username = ?').get('demo');
if (!user) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'demo', 'Demo', bcrypt.hashSync('demo1234', 10), now());
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

let srv = db.prepare('SELECT * FROM servers WHERE join_code = ?').get('lobby');
if (!srv) {
  const serverId = crypto.randomUUID();
  db.prepare('INSERT INTO servers (id, name, description, owner_id, join_code, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(serverId, 'Lobby', 'Demo server', user.id, 'lobby', now());
  db.prepare('INSERT OR IGNORE INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), user.id, serverId, user.username, now());
  db.prepare("INSERT INTO channels (id, server_id, name, topic, type, position) VALUES (?, ?, 'general', 'General chat', 'text', 0)")
    .run(crypto.randomUUID(), serverId);
  srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
}

console.log('Seed ready:');
console.log('  login:     demo / demo1234');
console.log('  join code: lobby');
console.log('  url:       http://localhost:' + (process.env.PORT || 3000));
