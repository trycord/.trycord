// Public discovery: paginated index + safe previews of public, discoverable servers.
// Private or non-discoverable servers can never appear here.
const db = require('../db');

const MAX_LIMIT = 24;

function search({ q, page, limit }) {
  limit = Math.min(Math.max(parseInt(limit || '12', 10) || 12, 1), MAX_LIMIT);
  page = Math.max(parseInt(page || '1', 10) || 1, 1);
  const term = String(q || '').trim();
  const where = ['s.is_public = 1', 's.is_discoverable = 1'];
  const vals = [];
  if (term) {
    where.push('(s.name LIKE ? OR s.description LIKE ?)');
    vals.push(`%${term}%`, `%${term}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM servers s WHERE ${where.join(' AND ')}`)
    .get(...vals).n;
  const items = db.prepare(`
    SELECT s.id, s.name, s.description, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
      (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count
    FROM servers s WHERE ${where.join(' AND ')}
    ORDER BY member_count DESC, s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...vals, limit, (page - 1) * limit);
  return { items, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

// Safe public representation — no join codes, members, messages, or settings.
function preview(serverId) {
  const srv = db.prepare(`
    SELECT s.id, s.name, s.description, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
    FROM servers s
    WHERE s.id = ? AND s.is_public = 1 AND s.is_discoverable = 1
  `).get(serverId);
  if (!srv) return null;
  srv.channels = db.prepare('SELECT id, name, topic FROM channels WHERE server_id = ? ORDER BY position, name')
    .all(serverId);
  srv.channel_count = srv.channels.length;
  return srv;
}

module.exports = { search, preview, MAX_LIMIT };
