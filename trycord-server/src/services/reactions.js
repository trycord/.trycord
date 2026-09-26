// Message reactions (channels only): one row per (message, user, emoji).
// Summaries batch by message id so list reads stay at two queries.
const db = require('../db');
const { now } = require('../util');

// A reaction is one visible grapheme-ish unit: 1-6 code points, no
// whitespace or controls. Keeps out text dumps while allowing ZWJ emoji.
function validEmoji(e) {
  if (typeof e !== 'string') return null;
  const v = e.trim();
  if (!v) return null;
  const points = Array.from(v);
  if (points.length < 1 || points.length > 6) return null;
  if (/[\s\p{C}]/u.test(v)) return null;
  return v;
}

async function summary(messageIds, meId) {
  const ids = [...new Set((messageIds || []).map(String))].filter(Boolean);
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${placeholders})`,
    ids
  );
  const out = {};
  for (const id of ids) out[id] = [];
  const byKey = new Map();
  for (const r of rows) {
    const key = r.message_id + '|' + r.emoji;
    if (!byKey.has(key)) {
      // users samples who reacted (capped) so broadcast receivers can
      // derive their own `mine` flag — the summary is fanned out to
      // every socket, but `mine` is only valid for one reader.
      const entry = { emoji: r.emoji, count: 0, mine: false, users: [] };
      byKey.set(key, entry);
      out[r.message_id].push(entry);
    }
    const entry = byKey.get(key);
    entry.count += 1;
    if (entry.users.length < 3) entry.users.push(String(r.user_id));
    if (meId && String(r.user_id) === String(meId)) entry.mine = true;
  }
  for (const id of ids) {
    out[id].sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : 1));
  }
  return out;
}

async function add(userId, messageId, emoji) {
  const v = validEmoji(emoji);
  if (!v) throw { code: 'VALIDATION_ERROR', message: 'invalid emoji' };
  const msg = await db.get('SELECT id, channel_id FROM messages WHERE id = ?', [messageId]);
  if (!msg) throw { code: 'NOT_FOUND', message: 'message not found' };
  try {
    await db.run(
      'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      [messageId, userId, v, now()]
    );
  } catch (e) {
    // Duplicate (message, user, emoji): idempotent success, not an error.
    const s = String((e && e.message) || e);
    if (!/UNIQUE|unique|duplicate|PRIMARY/i.test(s)) throw e;
  }
  return v;
}

async function remove(userId, messageId, emoji) {
  const v = validEmoji(emoji);
  if (!v) throw { code: 'VALIDATION_ERROR', message: 'invalid emoji' };
  await db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, userId, v]);
  return v;
}

module.exports = { validEmoji, summary, add, remove };
