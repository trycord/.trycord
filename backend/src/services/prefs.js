// Which categories of notification this account wants at all.
//
// A per-category preference with a default and one enforcement point - the shape
// services/privacy.js held four of. Split out because "privacy" is not where anyone
// looks for notification settings.

const db = require('../db');
const { now } = require('../util');


const boolInt = (v) => (v ? 1 : 0);
const intBool = (v) => !!v;

const NOTIFICATION_CATEGORIES = ['dm', 'mention', 'friend', 'group', 'community', 'moderation', 'announcement'];

const DEFAULT_NOTIFICATION_PREFS = {
  dm: true, mention: true, friend: true, group: true, community: true,
  moderation: true, announcement: true,
};

function parseCategories(raw) {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_NOTIFICATION_PREFS };
    // Sparse by design: an absent key means the default, so adding a category
    // later does not silently mute it for everyone who already has a row.
    const out = { ...DEFAULT_NOTIFICATION_PREFS };
    for (const k of NOTIFICATION_CATEGORIES) {
      if (typeof parsed[k] === 'boolean') out[k] = parsed[k];
    }
    return out;
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

async function getNotificationPrefs(userId, serverId = null, conn = db) {
  if (serverId) {
    const scoped = await conn.get(
      'SELECT categories FROM notification_prefs WHERE user_id = ? AND server_id = ? ORDER BY updated_at DESC',
      [userId, serverId]
    );
    if (scoped) return parseCategories(scoped.categories);
  }
  // The global row is spelled with server_id IS NULL. A composite primary key
  // containing a nullable column does not make NULLs unique in either SQLite
  // or MySQL, so old writes could leave more than one global row. Reading the
  // newest is the honest answer for a database that already has them.
  const global = await conn.get(
    'SELECT categories FROM notification_prefs WHERE user_id = ? AND server_id IS NULL ORDER BY updated_at DESC',
    [userId]
  );
  return parseCategories(global && global.categories);
}

async function setNotificationPrefs(userId, patch, serverId = null) {
  const current = await getNotificationPrefs(userId, serverId);
  const next = { ...current };
  for (const k of NOTIFICATION_CATEGORIES) {
    if (typeof patch[k] === 'boolean') next[k] = patch[k];
  }
  const ts = now();
  const categories = JSON.stringify(next);
  // A select-then-write inside a transaction, rather than an upsert keyed on
  // (user_id, server_id). The global row carries NULL for server_id, and a
  // unique key with a NULL component does not conflict in SQLite or MySQL:
  // every global save inserted another row and the read kept finding the
  // oldest one, so a preference could be "saved" and never apply. The
  // transaction is the single-writer boundary the null-safe key cannot give
  // us, and updating every legacy duplicate keeps the next read truthful.
  await db.transaction(async (t) => {
    const where = serverId
      ? 'user_id = ? AND server_id = ?'
      : 'user_id = ? AND server_id IS NULL';
    const params = serverId ? [userId, serverId] : [userId];
    const existing = await t.get(
      'SELECT 1 FROM notification_prefs WHERE ' + where + ' LIMIT 1',
      params
    );
    if (existing) {
      await t.run(
        'UPDATE notification_prefs SET categories = ?, updated_at = ? WHERE ' + where,
        [categories, ts].concat(params)
      );
    } else {
      await t.run(
        'INSERT INTO notification_prefs (user_id, server_id, categories, updated_at) VALUES (?, ?, ?, ?)',
        [userId, serverId || null, categories, ts]
      );
    }
  });
  return next;
}

module.exports = {
  NOTIFICATION_CATEGORIES,
  getNotificationPrefs,
  setNotificationPrefs,
};
