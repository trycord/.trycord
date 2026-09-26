// @username mention detection for channel posts. Resolves mentioned names
// to server members, skips the author and muted channels, and persists
// 'mention' notifications (the type already exists; nothing created them).
// Returns [{ userId, notification }] so routes can push realtime events.
const db = require('../db');
const notifications = require('./notifications');

function extractCandidates(content) {
  const found = new Set();
  const re = /@([A-Za-z0-9_]{2,32})/g;
  let m;
  const text = String(content || '');
  while ((m = re.exec(text)) !== null) found.add(m[1].toLowerCase());
  return [...found];
}

async function notifyMentions({ serverId, channelId, messageId, authorId, content }) {
  const candidates = extractCandidates(content).filter((n) => n !== 'everyone' && n !== 'here');
  if (!candidates.length) return [];
  const placeholders = candidates.map(() => '?').join(',');
  // Named users who are actually members of this server (not the author).
  const members = await db.all(
    `SELECT u.id, u.username FROM users u
     JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = ?
     WHERE lower(u.username) IN (${placeholders}) AND u.id != ?`,
    [serverId].concat(candidates, [authorId])
  );
  if (!members.length) return [];
  const muted = await db.all(
    `SELECT user_id FROM muted_channels WHERE channel_id = ? AND user_id IN (${members.map(() => '?').join(',')})`,
    [channelId].concat(members.map((m) => m.id))
  );
  const mutedSet = new Set(muted.map((r) => String(r.user_id)));
  const out = [];
  for (const m of members) {
    if (mutedSet.has(String(m.id))) continue;
    try {
      const note = await notifications.create(m.id, 'mention', authorId, messageId);
      out.push({ userId: m.id, notification: note });
    } catch { /* one bad mention never fails the post */ }
  }
  return out;
}

module.exports = { extractCandidates, notifyMentions };
