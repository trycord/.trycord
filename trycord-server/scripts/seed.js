// Seed a demo account + public server so the app is usable on first run.
// Run:  npm run seed   (from trycord-server/)
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../src/db');
const servers = require('../src/services/servers');
const invites = require('../src/services/invites');

const now = () => new Date().toISOString();

let user = db.prepare('SELECT * FROM users WHERE username = ?').get('demo');
if (!user) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'demo', 'Demo', bcrypt.hashSync('demo1234', 10), now());
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

let serverId;
try {
  const r = servers.create(
    { name: 'Lobby', description: 'Demo server — open to everyone', joinCode: 'lobby', isPublic: true, isDiscoverable: true },
    { id: user.id, username: user.username }
  );
  serverId = r.serverId;
} catch (e) {
  if (e.code !== 'CONFLICT') throw e;
  serverId = db.prepare('SELECT id FROM servers WHERE join_code = ?').get('lobby').id;
}

const invite = invites.create(serverId, user.id, {});
console.log('Seed ready:');
console.log('  login:       demo / demo1234');
console.log('  join code:   lobby');
console.log('  invite code: ' + invite.code);
console.log('  url:         http://localhost:' + (process.env.PORT || 9971));
