// Named sessions: what is signed in, from where, and how to sign it out.
//
// Split out of services/privacy.js, where the name actively misled. This is session
// management, and it is what a reader opens Settings to reach.

const db = require('../db');
const { now } = require('../util');

// Written on login and on the ws ticket, read by the session list. `last_seen_at`
// is deliberately coarse: it is written when a session is created and when the
// gateway sees it, not on every authenticated request, so a busy client does not
// turn each API call into a write.
async function recordSession({ jti, userId, userAgent, ip, label }) {
  const ts = now();
  await db.upsert(
    'user_sessions',
    ['jti', 'user_id', 'label', 'user_agent', 'ip', 'created_at', 'last_seen_at'],
    [jti, userId, label || null, (userAgent || '').slice(0, 512) || null, ip || null, ts, ts],
    ['jti'],
    { last_seen_at: newRef('last_seen_at') }
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

module.exports = {
  recordSession,
  listSessions,
  revokeSession,
  revokeOthers,
};
