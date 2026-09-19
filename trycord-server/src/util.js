// Shared helpers: ids, timestamps, tokens, membership checks.
// All database access is async through the db facade (sqlite or mysql).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required. Set it in the environment or .env (see .env.example).');
  return s;
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function sign(user) {
  return jwt.sign(
    { id: user.id, username: user.username, jti: uuid() },
    secret(),
    { expiresIn: '7d' }
  );
}

async function isMember(userId, serverId) {
  return !!(await db.get('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?', [userId, serverId]));
}

async function isOwner(userId, serverId) {
  const row = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  return !!row && row.owner_id === userId;
}

// Channel row if it exists AND the user belongs to its server, else null.
async function visibleChannel(channelId, userId) {
  const ch = await db.get('SELECT * FROM channels WHERE id = ?', [channelId]);
  if (!ch || !(await isMember(userId, ch.server_id))) return null;
  return ch;
}

module.exports = { secret, now, uuid, sign, isMember, isOwner, visibleChannel };
