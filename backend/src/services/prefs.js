// Which categories of notification this account wants at all.
//
// A per-category preference with a default and one enforcement point - the shape
// services/privacy.js held four of. Split out because "privacy" is not where anyone
// looks for notification settings.

const db = require('../db');
const { now } = require('../util');

const newRef = (column) =>
  db.dialect === 'mysql' ? `VALUES(${column})` : `excluded.${column}`;

const boolInt = (v) => (v ? 1 : 0);
const intBool = (v) => !!v;

const NOTIFICATION_CATEGORIES = ['dm', 'mention', 'friend', 'moderation', 'announcement'];

const DEFAULT_NOTIFICATION_PREFS = {
  dm: true, mention: true, friend: true, moderation: true, announcement: true,
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
      'SELECT categories FROM notification_prefs WHERE user_id = ? AND server_id = ?',
      [userId, serverId]
    );
    if (scoped) return parseCategories(scoped.categories);
  }
  const global = await conn.get(
    'SELECT categories FROM notification_prefs WHERE user_id = ? AND server_id IS NULL',
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
  // A NULL server_id is the global row. SQLite and MySQL both need the NULL
  // spelled out for the unique key to match, which is why this is two statements
  // rather than one upsert.
  // The global row stores NULL for server_id rather than an empty string, and
  // both databases need the NULL spelled out for the unique key to match it.
  // That is why this is two calls and not one with a conditional column list.
  await db.upsert(
    'notification_prefs',
    ['user_id', 'server_id', 'categories', 'updated_at'],
    [userId, serverId || null, JSON.stringify(next), ts],
    ['user_id', 'server_id'],
    { categories: newRef('categories'), updated_at: newRef('updated_at') }
  );
  return next;
}

module.exports = {
  NOTIFICATION_CATEGORIES,
  getNotificationPrefs,
  setNotificationPrefs,
};
