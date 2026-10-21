// The conversation a search hit came from.
//
// A search answer is a list of lines, and a line on its own is often
// cryptic: "no" means nothing until the line before it is read. So each hit
// carries the messages immediately around it - two before and one after -
// so the reader can see the exchange the hit was part of.
//
// The neighbours are fetched in two statements for the whole answer, not one
// request per hit: a search that made twenty-five requests to answer one
// question would be slower than the search itself.
//
// The neighbours come from the same channel as the hit, so they are exactly
// as visible as the hit: this adds the context around a line the reader may
// already see, and never a line they may not.

const db = require('../db');

/** How many messages before the hit. */
const BEFORE = 2;

/** How many messages after the hit. */
const AFTER = 1;

/**
 * The messages around a set of hits.
 *
 * @param {object[]} hits   the message hits, each with an id
 * @returns {Promise<Map>} the neighbours of each hit, by hit id
 */
async function around(hits) {
  const ids = (hits || [])
    .map((hit) => String(hit && hit.id || ''))
    .filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;

  // One statement for all the hits: which messages sit next to each of them.
  const marks = ids.map(() => '?').join(', ');
  const rows = await db.all(
    'SELECT h.id AS hit_id,'
    + ' (SELECT m2.id FROM messages m2 WHERE m2.channel_id = h.channel_id'
    + '   AND (m2.created_at < h.created_at OR (m2.created_at = h.created_at AND m2.id < h.id))'
    + '   ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS prev1,'
    + ' (SELECT m3.id FROM messages m3 WHERE m3.channel_id = h.channel_id'
    + '   AND (m3.created_at < h.created_at OR (m3.created_at = h.created_at AND m3.id < h.id))'
    + '   ORDER BY m3.created_at DESC, m3.id DESC LIMIT 1 OFFSET 1) AS prev2,'
    + ' (SELECT m4.id FROM messages m4 WHERE m4.channel_id = h.channel_id'
    + '   AND (m4.created_at > h.created_at OR (m4.created_at = h.created_at AND m4.id > h.id))'
    + '   ORDER BY m4.created_at ASC, m4.id ASC LIMIT 1) AS next1'
    + ' FROM messages h WHERE h.id IN (' + marks + ')',
    ids
  );

  // The neighbours themselves, in one more statement.
  const wanted = new Map();
  for (const row of rows) {
    const list = [];
    // The order matters: the oldest first, the hit's own place in the middle.
    for (const key of ['prev2', 'prev1']) {
      if (row[key]) list.push({ id: String(row[key]), where: 'before' });
    }
    if (row.next1) list.push({ id: String(row.next1), where: 'after' });
    if (list.length) wanted.set(String(row.hit_id), list);
  }
  if (!wanted.size) return out;

  const every = [];
  for (const list of wanted.values()) for (const entry of list) every.push(entry.id);
  const unique = [...new Set(every)];
  const messages = await db.all(
    'SELECT m.id, m.content, m.created_at, m.author_id,'
    + ' u.username AS author_name, u.display_name AS author_display'
    + ' FROM messages m JOIN users u ON u.id = m.author_id'
    + ' WHERE m.id IN (' + unique.map(() => '?').join(', ') + ')',
    unique
  );
  const byId = new Map(messages.map((message) => [String(message.id), message]));

  for (const [hitId, list] of wanted.entries()) {
    const context = [];
    for (const entry of list) {
      const message = byId.get(entry.id);
      if (!message) continue;
      context.push({
        id: String(message.id),
        where: entry.where,
        authorName: message.author_display || message.author_name || '',
        content: String(message.content || '').replace(/\s+/g, ' ').trim(),
        createdAt: message.created_at,
      });
    }
    out.set(hitId, context);
  }
  return out;
}

/**
 * Attach the context to a set of hits.
 *
 * The hits that are not messages - a community document - carry no context,
 * because a document is not part of a conversation.
 *
 * @param {object[]} hits
 * @returns {Promise<object[]>} the same hits, with the context attached
 */
async function attach(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const messages = list.filter((hit) => hit && hit.kind !== 'document' && hit.id);
  if (!messages.length) return list;
  const context = await around(messages);
  for (const hit of list) {
    if (!hit || hit.kind === 'document' || !hit.id) continue;
    const found = context.get(String(hit.id));
    if (found && found.length) hit.context = found;
  }
  return list;
}

module.exports = { around, attach, BEFORE, AFTER };
