// What a community refuses.
//
// Two rules, both the community's own:
//
//   - slow mode: the shortest gap between two messages from the same person
//     in a channel;
//   - the words that may not be used.
//
// Both are refused by the server, because a rule the client applies is a
// rule a reader can turn off. And both refuse with a sentence that says
// what happened, because "your message was not allowed" tells a person
// nothing they can act on.

const db = require('../db');

// How a word is matched.
//
// A whole word, not a part of one: a community that refuses a word does not
// refuse every word that contains it, or the rule refuses half the
// language. The word itself may be any length, and the case does not
// matter, because a rule that a capital letter gets around is not a rule.
function wordPattern(term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '([^\\p{L}\\p{N}]|$)', 'iu');
}

/**
 * The words a community refuses.
 *
 * @param {string} serverId
 * @returns {Promise<string[]>} the terms, lowercased
 */
async function blockedTerms(serverId) {
  const rows = await db.all(
    'SELECT term FROM blocked_terms WHERE server_id = ? ORDER BY term ASC',
    [serverId]
  );
  return rows.map((row) => String(row.term || '').toLowerCase()).filter(Boolean);
}

/**
 * Whether a message says something the community refuses.
 *
 * @param {string} serverId
 * @param {string} content
 * @returns {Promise<{ ok: boolean, term?: string, reason?: string }>}
 */
async function checkTerms(serverId, content) {
  const text = String(content || '');
  if (!text.trim()) return { ok: true };
  const terms = await blockedTerms(serverId);
  for (const term of terms) {
    if (wordPattern(term).test(text)) {
      return {
        ok: false,
        term,
        reason: 'this community does not allow the word "' + term + '"',
      };
    }
  }
  return { ok: true };
}

/**
 * Whether a person may post again yet.
 *
 * @param {object} channel   the channel row
 * @param {string} userId
 * @returns {Promise<{ ok: boolean, waitSeconds?: number, reason?: string }>}
 */
async function checkSlowMode(channel, userId) {
  const seconds = Number(channel && channel.slow_mode) || 0;
  if (seconds <= 0) return { ok: true };
  const last = await db.get(
    'SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? '
    + 'ORDER BY created_at DESC LIMIT 1',
    [channel.id, userId]
  );
  if (!last || !last.created_at) return { ok: true };
  const then = Date.parse(last.created_at);
  if (!Number.isFinite(then)) return { ok: true };
  const elapsed = Math.floor((Date.now() - then) / 1000);
  if (elapsed >= seconds) return { ok: true };
  const wait = seconds - elapsed;
  return {
    ok: false,
    waitSeconds: wait,
    reason: 'slow mode is on here: wait ' + wait + ' more '
      + (wait === 1 ? 'second' : 'seconds') + ' before posting again',
  };
}

module.exports = {
  blockedTerms,
  checkTerms,
  checkSlowMode,
};
