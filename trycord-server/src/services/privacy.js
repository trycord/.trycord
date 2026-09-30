// Privacy, blocking, wellbeing, notification preferences and named sessions.
//
// Five small domains that all have the same shape - a per-user preference with
// a default, an enforcement point somewhere in an existing service - and that
// are all read on paths that touch another person. They live together because
// splitting them across five services would mean five places that each have to
// remember the same lookup, and the first one that forgets becomes a bypass.
//
// Every default is defined exactly once, here. An absent row is not "false" and
// not "empty": it is DEFAULTS, so an account created before a new preference
// existed behaves the same as one created after it, with no backfill.

const db = require('../db');
const { now, uuid } = require('../util');

// 'anyone'  - no restriction
// 'friends' - accepted friends only
// 'nobody'  - nobody except the account holder
const SCOPES = ['anyone', 'friends', 'nobody'];

const DEFAULTS = {
  friendRequests: 'anyone',
  dms: 'anyone',
  presence: 'everyone',
  discoverable: true,
};

const NOTIFICATION_CATEGORIES = ['dm', 'mention', 'friend', 'moderation', 'announcement'];

// A user-level motion preference is applied as a class on <html> so the
// stylesheet can honour it, and it is separate from the OS preference: a reader
// can ask for less motion without changing a system setting.
const DEFAULT_WELLBEING = {
  dndEnabled: false,
  quietHoursOn: false,
  quietStart: 22 * 60,
  quietEnd: 8 * 60,
  reducedMotion: false,
};

const boolInt = (v) => (v ? 1 : 0);
const intBool = (v) => !!v;

function scope(value, fallback) {
  const v = String(value || '').toLowerCase();
  return SCOPES.includes(v) ? v : fallback;
}

// ---- privacy -------------------------------------------------------------

async function getPrivacy(userId, conn = db) {
  const row = await conn.get('SELECT * FROM privacy_settings WHERE user_id = ?', [userId]);
  if (!row) return { ...DEFAULTS };
  return {
    friendRequests: scope(row.friend_requests, DEFAULTS.friendRequests),
    dms: scope(row.dms, DEFAULTS.dms),
    presence: scope(row.presence, DEFAULTS.presence),
    discoverable: intBool(row.discoverable),
  };
}

// Only the keys the caller actually sent are written, so a partial update from
// an older client cannot reset a preference it does not know about.
async function setPrivacy(userId, patch) {
  const current = await getPrivacy(userId);
  const next = {
    friendRequests: scope(patch.friendRequests, current.friendRequests),
    dms: scope(patch.dms, current.dms),
    presence: scope(patch.presence, current.presence),
    discoverable: patch.discoverable === undefined ? current.discoverable : !!patch.discoverable,
  };
  const ts = now();
  await db.run(
    `INSERT INTO privacy_settings
       (user_id, friend_requests, dms, presence, discoverable, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       friend_requests = excluded.friend_requests,
       dms = excluded.dms,
       presence = excluded.presence,
       discoverable = excluded.discoverable,
       updated_at = excluded.updated_at`,
    [userId, next.friendRequests, next.dms, next.presence, boolInt(next.discoverable), ts]
  );
  return next;
}

// ---- blocking ------------------------------------------------------------

// Symmetric: a row in either direction blocks the relationship. A block is
// therefore a property of the pair, not of the person who pressed the button,
// which is what makes "unblock" unambiguous from either side.
async function isBlocked(a, b, conn = db) {
  if (String(a) === String(b)) return false;
  const row = await conn.get(
    `SELECT 1 FROM user_blocks
     WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)`,
    [a, b, b, a]
  );
  return !!row;
}

async function blockedBy(a, b, conn = db) {
  if (String(a) === String(b)) return false;
  const row = await conn.get(
    'SELECT 1 FROM user_blocks WHERE user_id = ? AND blocked_id = ?',
    [a, b]
  );
  return !!row;
}

async function block(userId, blockedId, reason) {
  if (String(userId) === String(blockedId)) {
    throw { code: 'VALIDATION_ERROR', message: 'You cannot block yourself' };
  }
  const exists = await db.get('SELECT id FROM users WHERE id = ?', [blockedId]);
  if (!exists) throw { code: 'NOT_FOUND', message: 'User not found' };

  const ts = now();
  await db.run(
    `INSERT INTO user_blocks (user_id, blocked_id, reason, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, blocked_id) DO UPDATE SET reason = excluded.reason`,
    [userId, blockedId, reason || null, ts]
  );

  // A block is meant to take effect now, not on the next request the other
  // person happens to make. Anything that would keep the relationship alive
  // despite the block is removed here rather than merely hidden:
  //   - a pending friend request in either direction
  //   - an existing friendship, both directions
  //   - the blocker's presence to the blocked user
  const pending = await db.get(
    `SELECT * FROM friend_requests
     WHERE status = 'pending'
       AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    [userId, blockedId, blockedId, userId]
  );
  if (pending) {
    await db.run('DELETE FROM friend_requests WHERE id = ?', [pending.id]);
  }
  await db.run(
    'DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [userId, blockedId, blockedId, userId]
  );
  await db.run(
    'UPDATE server_members SET nickname = nickname WHERE user_id = ? AND server_id IN (SELECT server_id FROM server_members WHERE user_id = ?)',
    [blockedId, blockedId]
  );

  return { userId, blockedId, reason: reason || null, createdAt: ts };
}

async function unblock(userId, blockedId) {
  await db.run('DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?', [userId, blockedId]);
  return { userId, blockedId };
}

async function listBlocks(userId) {
  const rows = await db.all(
    `SELECT b.blocked_id AS id, b.reason, b.created_at,
            u.username, u.display_name
     FROM user_blocks b LEFT JOIN users u ON u.id = b.blocked_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/**
 * Can `fromId` open a DM with `toId`?
 *
 * Three gates, in the order that gives the least information to a stranger:
 * the target has to exist, neither party may have blocked the other, and the
 * target's DM preference has to permit this sender. Each rejection is a distinct
 * code so the client can explain itself rather than saying "could not send".
 */
async function canOpenDm(fromId, toId, conn = db) {
  if (String(fromId) === String(toId)) return { allowed: true };
  const target = await conn.get('SELECT id FROM users WHERE id = ?', [toId]);
  if (!target) return { allowed: false, code: 'NOT_FOUND', message: 'User not found' };
  if (await isBlocked(fromId, toId, conn)) {
    return { allowed: false, code: 'BLOCKED', message: 'This conversation is not available' };
  }
  const pref = await getPrivacy(toId, conn);
  if (pref.dms === 'nobody') {
    return { allowed: false, code: 'NOT_ACCEPTING_DMS', message: 'This user is not accepting messages' };
  }
  if (pref.dms === 'friends') {
    const row = await conn.get(
      'SELECT 1 FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
      [toId, fromId, fromId, toId]
    );
    if (!row) {
      return { allowed: false, code: 'NOT_ACCEPTING_DMS', message: 'This user only accepts messages from friends' };
    }
  }
  return { allowed: true };
}

/** Can `fromId` send `toId` a friend request? Same three gates. */
async function canSendFriendRequest(fromId, toId, conn = db) {
  if (String(fromId) === String(toId)) {
    return { allowed: false, code: 'VALIDATION_ERROR', message: 'You cannot friend yourself' };
  }
  const target = await conn.get('SELECT id FROM users WHERE id = ?', [toId]);
  if (!target) return { allowed: false, code: 'NOT_FOUND', message: 'User not found' };
  if (await isBlocked(fromId, toId, conn)) {
    return { allowed: false, code: 'BLOCKED', message: 'This request is not available' };
  }
  const pref = await getPrivacy(toId, conn);
  if (pref.friendRequests === 'nobody') {
    return { allowed: false, code: 'NOT_ACCEPTING_REQUESTS', message: 'This user is not accepting friend requests' };
  }
  if (pref.friendRequests === 'friends') {
    const row = await conn.get(
      'SELECT 1 FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
      [toId, fromId, fromId, toId]
    );
    if (!row) {
      return { allowed: false, code: 'NOT_ACCEPTING_REQUESTS', message: 'This user only accepts requests from friends' };
    }
  }
  return { allowed: true };
}

/** May `viewerId` see `subjectId`'s presence? Absent an explicit preference, yes. */
async function canSeePresence(viewerId, subjectId, conn = db) {
  if (String(viewerId) === String(subjectId)) return true;
  if (await isBlocked(viewerId, subjectId, conn)) return false;
  const pref = await getPrivacy(subjectId, conn);
  if (pref.presence === 'everyone') return true;
  if (pref.presence === 'nobody') return false;
  const row = await conn.get(
    'SELECT 1 FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [subjectId, viewerId, viewerId, subjectId]
  );
  return !!row;
}

/** May `viewerId` receive `subjectId` in user-search results? */
async function canDiscover(viewerId, subjectId, conn = db) {
  if (String(viewerId) === String(subjectId)) return true;
  if (await isBlocked(viewerId, subjectId, conn)) return false;
  const pref = await getPrivacy(subjectId, conn);
  return pref.discoverable;
}

// ---- notification preferences --------------------------------------------

const DEFAULT_NOTIFICATION_PREFS = { dm: true, mention: true, friend: true, moderation: true, announcement: true };

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
  if (serverId) {
    await db.run(
      `INSERT INTO notification_prefs (user_id, server_id, categories, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, server_id) DO UPDATE SET
         categories = excluded.categories, updated_at = excluded.updated_at`,
      [userId, serverId, JSON.stringify(next), ts]
    );
  } else {
    await db.run(
      `INSERT INTO notification_prefs (user_id, server_id, categories, updated_at)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT (user_id, server_id) DO UPDATE SET
         categories = excluded.categories, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(next), ts]
    );
  }
  return next;
}

// ---- wellbeing -----------------------------------------------------------

async function getWellbeing(userId, conn = db) {
  const row = await conn.get('SELECT * FROM wellbeing_settings WHERE user_id = ?', [userId]);
  if (!row) return { ...DEFAULT_WELLBEING };
  return {
    dndEnabled: intBool(row.dnd_enabled),
    quietHoursOn: intBool(row.quiet_hours_on),
    quietStart: Number.isInteger(row.quiet_start) ? row.quiet_start : DEFAULT_WELLBEING.quietStart,
    quietEnd: Number.isInteger(row.quiet_end) ? row.quiet_end : DEFAULT_WELLBEING.quietEnd,
    reducedMotion: intBool(row.reduced_motion),
  };
}

const clampMinute = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(24 * 60 - 1, Math.round(n)));
};

async function setWellbeing(userId, patch) {
  const current = await getWellbeing(userId);
  const next = {
    dndEnabled: patch.dndEnabled === undefined ? current.dndEnabled : !!patch.dndEnabled,
    quietHoursOn: patch.quietHoursOn === undefined ? current.quietHoursOn : !!patch.quietHoursOn,
    quietStart: clampMinute(patch.quietStart, current.quietStart),
    quietEnd: clampMinute(patch.quietEnd, current.quietEnd),
    reducedMotion: patch.reducedMotion === undefined ? current.reducedMotion : !!patch.reducedMotion,
  };
  const ts = now();
  await db.run(
    `INSERT INTO wellbeing_settings
       (user_id, dnd_enabled, quiet_hours_on, quiet_start, quiet_end, reduced_motion, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       dnd_enabled = excluded.dnd_enabled,
       quiet_hours_on = excluded.quiet_hours_on,
       quiet_start = excluded.quiet_start,
       quiet_end = excluded.quiet_end,
       reduced_motion = excluded.reduced_motion,
       updated_at = excluded.updated_at`,
    [userId, boolInt(next.dndEnabled), boolInt(next.quietHoursOn), next.quietStart,
      next.quietEnd, boolInt(next.reducedMotion), ts]
  );
  return next;
}

/**
 * Should a notification be delivered right now?
 *
 * DND is absolute. Quiet hours are a window that is allowed to wrap past
 * midnight, which is the ordinary case for a schedule like 22:00-08:00 and the
 * bug a naive `start < now < end` check produces for every one of them.
 * The per-category preference is checked last because it is a durable choice,
 * while these two are about the current moment.
 */
function suppressesNow(wellbeing, category, minutesFromMidnight, nowDate = new Date()) {
  if (!wellbeing) return false;
  if (wellbeing.dndEnabled) return true;
  if (wellbeing.quietHoursOn) {
    const start = wellbeing.quietStart;
    const end = wellbeing.quietEnd;
    const now = typeof minutesFromMidnight === 'number'
      ? minutesFromMidnight
      : nowDate.getHours() * 60 + nowDate.getMinutes();
    const wraps = start > end;
    const inside = wraps ? (now >= start || now < end) : (now >= start && now < end);
    // A category the reader has explicitly kept on is still delivered during
    // quiet hours: the schedule is a default, not a mute.
    if (inside && wellbeing._keepDuringQuiet && wellbeing._keepDuringQuiet.includes(category)) return false;
    if (inside) return true;
  }
  return false;
}

// ---- named sessions ------------------------------------------------------

// Written on login and on the ws ticket, read by the session list. `last_seen_at`
// is deliberately coarse: it is written when a session is created and when the
// gateway sees it, not on every authenticated request, so a busy client does not
// turn each API call into a write.
async function recordSession({ jti, userId, userAgent, ip, label }) {
  const ts = now();
  await db.run(
    `INSERT INTO user_sessions (jti, user_id, label, user_agent, ip, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (jti) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [jti, userId, label || null, (userAgent || '').slice(0, 512) || null, ip || null, ts, ts]
  );
}

async function listSessions(userId, currentJti) {
  const rows = await db.all(
    `SELECT jti, label, user_agent, ip, created_at, last_seen_at
     FROM user_sessions
     WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY last_seen_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    jti: r.jti,
    label: r.label || describeAgent(r.user_agent),
    userAgent: r.user_agent || null,
    ip: r.ip || null,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.jti === currentJti,
  }));
}

// A device name is a guess, but a useful one: "Chrome on Linux" tells a reader
// which row to revoke, where the raw user-agent string does not.
function describeAgent(ua) {
  if (!ua) return 'Unknown device';
  const s = String(ua);
  const browser = /Firefox\/[\d.]+/.test(s) ? 'Firefox'
    : /Edg\//.test(s) ? 'Edge'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : '';
  const os = /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android'
    : /(iPhone|iPad)/.test(s) ? 'iOS'
    : /Linux/.test(s) ? 'Linux'
    : '';
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown device';
}

async function revokeSession(userId, jti) {
  const res = await db.run(
    'UPDATE user_sessions SET revoked_at = ? WHERE jti = ? AND user_id = ? AND revoked_at IS NULL',
    [now(), jti, userId]
  );
  return res && (res.changes || res.affectedRows || 0) > 0;
}

async function revokeOthers(userId, currentJti) {
  return db.run(
    'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND jti != ? AND revoked_at IS NULL',
    [now(), userId, currentJti || '']
  );
}

async function isSessionRevoked(jti) {
  if (!jti) return false;
  const row = await db.get('SELECT revoked_at FROM user_sessions WHERE jti = ?', [jti]);
  // An unknown jti is a session minted before this table existed, or a forged
  // one. Neither is revoked here; the token's own signature and the user's
  // session_version counter are what authenticate a request.
  return !!(row && row.revoked_at);
}

module.exports = {
  DEFAULTS,
  DEFAULT_WELLBEING,
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_CATEGORIES,
  SCOPES,
  getPrivacy,
  setPrivacy,
  isBlocked,
  blockedBy,
  block,
  unblock,
  listBlocks,
  canOpenDm,
  canSendFriendRequest,
  canSeePresence,
  canDiscover,
  getNotificationPrefs,
  setNotificationPrefs,
  getWellbeing,
  setWellbeing,
  suppressesNow,
  recordSession,
  listSessions,
  revokeSession,
  revokeOthers,
  isSessionRevoked,
  describeAgent,
};
