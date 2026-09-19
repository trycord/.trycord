// Shared helpers: ids, timestamps, tokens, membership checks.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function sign(user) {
  return jwt.sign(
    { id: user.id, username: user.username, jti: uuid() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function isMember(userId, serverId) {
  return !!db
    .prepare('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?')
    .get(userId, serverId);
}

function isOwner(userId, serverId) {
  const row = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  return !!row && row.owner_id === userId;
}

// Channel row if it exists AND the user belongs to its server, else null.
function visibleChannel(channelId, userId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch || !isMember(userId, ch.server_id)) return null;
  return ch;
}

module.exports = { JWT_SECRET, now, uuid, sign, isMember, isOwner, visibleChannel };
