// Message reactions: one row per (message, user, emoji). Summaries batch by
// message id so list reads stay at two queries.
//
// Two scopes share the shape: a channel message's rows live in `reactions`
// (whose foreign key reaches `messages`), and a direct message's rows live in
// `dm_reactions` (keyed to `dm_messages`). Every function takes the scope and
// defaults to the channel one, so the channel callers read exactly as they
// always did and a conversation caller names its own table rather than
// casting its message ids at a foreign key that would refuse them.
const db = require('../db');
const { now } = require('../util');

const SCOPES = {
  channel: { messages: 'messages', reactions: 'reactions' },
  dm: { messages: 'dm_messages', reactions: 'dm_reactions' },
};

function tables(scope) {
  return SCOPES[scope] || SCOPES.channel;
}

// A reaction is one visible grapheme-ish unit: 1-6 code points, no
// whitespace or controls. Keeps out text dumps while allowing ZWJ emoji.
// A community's custom emoji rides the same column as a unicode feeling: the
// short code `:name:` is stored as the string itself, and every client that
// can see the community turns it into the picture. The name rules are the
// emoji service's, and the whole code stays within the 32 characters the
// reactions tables give the column — a 30-character name is the widest that
// fits between the colons.
//
// A colon-delimited string is read as a short code, strictly: a malformed
// code is refused, not waved through as a unicode feeling, because a reader
// who typed a code meant a picture and got the punctuation back.
const SHORTCODE_RE = /^:([a-zA-Z0-9_]{2,30}):$/;

function validEmoji(e) {
  if (typeof e !== 'string') return null;
  const v = e.trim();
  if (!v) return null;
  if (v.length > 2 && v.startsWith(':') && v.endsWith(':')) {
    const code = v.match(SHORTCODE_RE);
    return code ? ':' + code[1].toLowerCase() + ':' : null;
  }
  const points = Array.from(v);
  if (points.length < 1 || points.length > 6) return null;
  if (/[\s\p{C}]/u.test(v)) return null;
  return v;
}

async function summary(messageIds, meId, scope) {
  const ids = [...new Set((messageIds || []).map(String))].filter(Boolean);
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT message_id, emoji, user_id FROM ${tables(scope).reactions} WHERE message_id IN (${placeholders})`,
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

async function add(userId, messageId, emoji, scope) {
  const v = validEmoji(emoji);
  if (!v) throw { code: 'VALIDATION_ERROR', message: 'Invalid emoji' };
  const t = tables(scope);
  const msg = await db.get(`SELECT id FROM ${t.messages} WHERE id = ?`, [messageId]);
  if (!msg) throw { code: 'NOT_FOUND', message: 'Message not found' };
  try {
    await db.run(
      `INSERT INTO ${t.reactions} (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`,
      [messageId, userId, v, now()]
    );
  } catch (e) {
    // Duplicate (message, user, emoji): idempotent success, not an error.
    const s = String((e && e.message) || e);
    if (!/UNIQUE|unique|duplicate|PRIMARY/i.test(s)) throw e;
  }
  return v;
}

async function remove(userId, messageId, emoji, scope) {
  const v = validEmoji(emoji);
  if (!v) throw { code: 'VALIDATION_ERROR', message: 'Invalid emoji' };
  await db.run(`DELETE FROM ${tables(scope).reactions} WHERE message_id = ? AND user_id = ? AND emoji = ?`, [messageId, userId, v]);
  return v;
}

module.exports = { validEmoji, summary, add, remove };
