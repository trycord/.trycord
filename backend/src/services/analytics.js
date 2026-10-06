// Community analytics.
//
// Computed from the rows that already exist rather than from a counter table.
// A separate daily-rollup table is the usual shape and it is the wrong one here:
// it has to be backfilled, it disagrees with the messages it summarises the
// moment a message is edited or deleted, and it is a second source of truth for
// something the messages table already answers exactly.
//
// Every figure below is a grouped query over an indexed column, and every one is
// scoped to a single community and a bounded window, so the cost does not grow
// with the instance.

const db = require('../db');

const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

// Inclusive list of ISO dates covering the window, so a day with no activity is
// a zero in the series rather than a gap. A chart with gaps reads as missing
// data; a chart with zeros reads as a quiet day, which is what happened.
function dayRange(days, nowMs) {
  const out = [];
  const day = 24 * 60 * 60 * 1000;
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end.getTime() - i * day).toISOString().slice(0, 10));
  }
  return out;
}

function clampDays(input) {
  const n = parseInt(input, 10);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(Math.max(n, 1), MAX_DAYS);
}

async function overview(serverId, days) {
  const d = clampDays(days);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

  const [messages, memberCount, joined, reactions, channelCount, attachmentCount, departures] =
    await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id' +
        ' WHERE c.server_id = ? AND m.created_at >= ?', [serverId, since]),
      db.get('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?', [serverId]),
      db.get('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ? AND joined_at >= ?', [serverId, since]),
      db.get('SELECT COUNT(*) AS n FROM reactions r JOIN messages m ON m.id = r.message_id' +
        ' JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ? AND r.created_at >= ?', [serverId, since])
        .catch(() => ({ n: 0 })),
      db.get('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', [serverId]),
      db.get('SELECT COUNT(*) AS n FROM attachments a JOIN messages m ON m.id = a.message_id' +
        ' JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ? AND a.created_at >= ?', [serverId, since]),
      db.get("SELECT COUNT(*) AS n FROM server_membership_events" +
        " WHERE server_id = ? AND kind = 'left' AND created_at >= ?", [serverId, since]),
    ]);

  const perDay = await daily(serverId, d);
  const totalMessages = perDay.reduce((a, b) => a + b.messages, 0);
  const activeDays = perDay.filter((x) => x.messages > 0).length;
  const n = (row) => (row ? Number(row.n) || 0 : 0);

  return {
    windowDays: d,
    since,
    totals: {
      messages: n(messages),
      attachments: n(attachmentCount),
      reactions: n(reactions),
      members: n(memberCount),
      joined: n(joined),
      left: n(departures),
      channels: n(channelCount),
    },
    // Two averages, because they answer different questions. Over the window a
    // quiet community scores low on one; over the days anyone actually spoke it
    // scores the same as a busy one. Reporting only the first reads as decline
    // when it is really just a holiday.
    averages: {
      messagesPerDay: Math.round((totalMessages / d) * 10) / 10,
      messagesPerActiveDay: activeDays ? Math.round((totalMessages / activeDays) * 10) / 10 : 0,
      activeDays,
    },
  };
}

// Messages and distinct posters per day, zero-filled across the window.
async function daily(serverId, days) {
  const d = clampDays(days);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.all(
    `SELECT substr(m.created_at, 1, 10) AS day,
            COUNT(*) AS messages,
            COUNT(DISTINCT m.author_id) AS posters
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     WHERE c.server_id = ? AND m.created_at >= ?
     GROUP BY substr(m.created_at, 1, 10)`,
    [serverId, since]
  );
  const byDay = new Map(rows.map((r) => [String(r.day), r]));
  return dayRange(d, Date.now()).map((day) => ({
    day,
    messages: byDay.has(day) ? Number(byDay.get(day).messages) : 0,
    posters: byDay.has(day) ? Number(byDay.get(day).posters) : 0,
  }));
}

// Where the conversation actually happens.
async function topChannels(serverId, days, limit = 10) {
  const d = clampDays(days);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const rows = await db.all(
    `SELECT c.id, c.name, c.slug, COUNT(m.id) AS messages,
            COUNT(DISTINCT m.author_id) AS posters
     FROM channels c
     LEFT JOIN messages m ON m.channel_id = c.id AND m.created_at >= ?
     WHERE c.server_id = ?
     GROUP BY c.id
     ORDER BY messages DESC, c.name ASC
     LIMIT ` + lim,
    [since, serverId]
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug,
    messages: Number(r.messages), posters: Number(r.posters),
  }));
}

// Who is here, counted by distinct messages rather than by membership: someone
// who joined and never spoke is not participation.
async function topMembers(serverId, days, limit = 10) {
  const d = clampDays(days);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const rows = await db.all(
    `SELECT m.author_id AS id, u.username, u.display_name AS displayName,
            COUNT(*) AS messages, COUNT(DISTINCT m.channel_id) AS channels
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     JOIN users u ON u.id = m.author_id
     WHERE c.server_id = ? AND m.created_at >= ?
     GROUP BY m.author_id
     ORDER BY messages DESC
     LIMIT ` + lim,
    [serverId, since]
  );
  return rows.map((r) => ({
    id: r.id, username: r.username, displayName: r.displayName || r.username,
    messages: Number(r.messages), channels: Number(r.channels),
  }));
}

// New and departed members per day.
async function membership(serverId, days) {
  const d = clampDays(days);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const joined = await db.all(
    `SELECT substr(joined_at, 1, 10) AS day, COUNT(*) AS n
     FROM server_members WHERE server_id = ? AND joined_at >= ?
     GROUP BY substr(joined_at, 1, 10)`,
    [serverId, since]
  );
  // Departures come from server_membership_events, written at the moment of the
  // leave. The audit log only records moderator actions, so counting departures
  // from it would miss everyone who left by choice.
  const left = await db.all(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
     FROM server_membership_events
     WHERE server_id = ? AND kind = 'left' AND created_at >= ?
     GROUP BY substr(created_at, 1, 10)`,
    [serverId, since]
  ).catch(() => []);
  const jm = new Map(joined.map((r) => [String(r.day), Number(r.n)]));
  const lm = new Map(left.map((r) => [String(r.day), Number(r.n)]));
  return dayRange(d, Date.now()).map((day) => ({
    day, joined: jm.get(day) || 0, left: lm.get(day) || 0,
  }));
}

// How many days in a row somebody has posted, and the streak before it. Read
// backwards from today so "current streak" means current.
async function streaks(serverId) {
  const rows = await db.all(
    `SELECT substr(m.created_at, 1, 10) AS day
     FROM messages m JOIN channels c ON c.id = m.channel_id
     WHERE c.server_id = ?
     GROUP BY substr(m.created_at, 1, 10) ORDER BY day DESC`,
    [serverId]
  );
  const days = rows.map((r) => String(r.day));
  if (!days.length) return { current: 0, longest: 0 };
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let current = 0;
  for (let i = 0; i < days.length; i++) {
    const expected = new Date(today.getTime() - i * dayMs).toISOString().slice(0, 10);
    if (days[i] === expected) current++;
    else break;
  }
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    if (prev && Math.round((new Date(prev + 'T00:00:00Z') - new Date(day + 'T00:00:00Z')) / dayMs) === 1) run++;
    else run = 1;
    if (run > longest) longest = run;
    prev = day;
  }
  return { current, longest };
}

// Everything one request needs, so the page is not six round trips.
async function report(serverId, days) {
  const d = clampDays(days);
  const [head, perDay, chans, members, memberDays, streak] = await Promise.all([
    overview(serverId, d),
    daily(serverId, d),
    topChannels(serverId, d),
    topMembers(serverId, d),
    membership(serverId, d),
    streaks(serverId),
  ]);
  return {
    windowDays: d,
    generatedAt: new Date().toISOString(),
    totals: head.totals,
    averages: head.averages,
    daily: perDay,
    membership: memberDays,
    topChannels: chans,
    topMembers: members,
    streaks: streak,
  };
}

module.exports = { overview, daily, topChannels, topMembers, membership, streaks, report, MAX_DAYS, DEFAULT_DAYS };