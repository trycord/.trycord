// Public discovery: paginated index + safe previews of public, discoverable servers.
// Private or non-discoverable servers can never appear here.
const db = require('../db');

const MAX_LIMIT = 24;

function pageArgs(page, limit) {
  limit = Math.min(Math.max(parseInt(limit || '12', 10) || 12, 1), MAX_LIMIT);
  page = Math.max(parseInt(page || '1', 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

async function search({ q, page, limit }) {
  const { limit: lim, page: pg, offset } = pageArgs(page, limit);
  const term = String(q || '').trim();
  const where = ['s.is_public = 1', 's.is_discoverable = 1', 's.enforcement_state IS NULL'];
  const vals = [];
  if (term) {
    where.push('(s.name LIKE ? OR s.description LIKE ?)');
    vals.push(`%${term}%`, `%${term}%`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const totalRow = await db.get(`SELECT COUNT(*) AS n FROM servers s ${whereSql}`, vals);
  // Integers are validated above, so embedding them is injection-safe
  // (and keeps LIMIT/OFFSET working on every supported database).
  const items = await db.all(
    `SELECT s.id, s.name, s.description, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
      (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count
    FROM servers s ${whereSql}
    ORDER BY member_count DESC, s.created_at DESC
    LIMIT ${lim} OFFSET ${offset}`,
    vals
  );
  return { items, page: pg, limit: lim, total: totalRow.n, pages: Math.max(1, Math.ceil(totalRow.n / lim)) };
}

// Safe public representation — no join codes, members, messages, or settings.
async function preview(serverId) {
  const srv = await db.get(
    `SELECT s.id, s.name, s.description, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
    FROM servers s
    WHERE s.id = ? AND s.is_public = 1 AND s.is_discoverable = 1 AND s.enforcement_state IS NULL`,
    [serverId]
  );
  if (!srv) return null;
  srv.channels = await db.all('SELECT id, name, topic FROM channels WHERE server_id = ? ORDER BY position, name', [serverId]);
  srv.channel_count = srv.channels.length;
  return srv;
}

module.exports = { search, preview, MAX_LIMIT };
