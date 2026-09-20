// Seed a demo account + public server so the app is usable on first run.
// Run:  npm run seed   (from trycord-server/, with the database configured)
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../src/db');
const servers = require('../src/services/servers');
const invites = require('../src/services/invites');
require('dotenv').config();
async function main() {
  await db.connect();

  let user = await db.get('SELECT * FROM users WHERE username = ?', ['demo']);
  if (!user) {
    const id = crypto.randomUUID();
    const { TERMS_VERSION, PRIVACY_VERSION } = require('../src/legal');
    const ts = new Date().toISOString();
    await db.run(
      'INSERT INTO users (id, username, display_name, password_hash, created_at, terms_version, privacy_version, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, 'demo', 'Demo', bcrypt.hashSync('demo1234', 10), ts, TERMS_VERSION, PRIVACY_VERSION, ts]
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  }

  let serverId;
  try {
    const r = await servers.create(
      { name: 'Lobby', description: 'Demo server — open to everyone', joinCode: 'lobby', isPublic: true, isDiscoverable: true },
      { id: user.id, username: user.username }
    );
    serverId = r.serverId;
  } catch (e) {
    if (e.code !== 'CONFLICT') throw e;
    serverId = (await db.get('SELECT id FROM servers WHERE join_code = ?', ['lobby'])).id;
  }

  const invite = await invites.create(serverId, user.id, {});
  console.log('Seed ready:');
  console.log('  login:       demo / demo1234');
  console.log('  join code:   lobby');
  console.log('  invite code: ' + invite.code);
  console.log('  url:         http://localhost:' + (process.env.PORT || 9971));
  await db.close();
}

main().catch((e) => {
  console.error('seed failed: ' + (e.message || e));
  process.exit(1);
});
