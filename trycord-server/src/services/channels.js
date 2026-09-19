// Channel + category lifecycle. Channels belong to a server,
// optionally grouped under a category.
const db = require('../db');
const { uuid } = require('../util');

function cleanName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').slice(0, 32) || 'channel';
}

function categories(serverId) {
  return db.prepare('SELECT * FROM categories WHERE server_id = ? ORDER BY position, name').all(serverId);
}

function createCategory(serverId, name) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'category name required' };
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories WHERE server_id = ?')
    .get(serverId).p;
  const id = uuid();
  db.prepare('INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)')
    .run(id, serverId, clean, pos);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

function deleteCategory(serverId, categoryId) {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ? AND server_id = ?').get(categoryId, serverId);
  if (!cat) throw { code: 'NOT_FOUND', message: 'category not found' };
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id); // channels SET NULL
  return { ok: true };
}

function list(serverId) {
  const cats = categories(serverId);
  const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, name').all(serverId);
  return { categories: cats, channels };
}

function create(serverId, { name, topic, categoryId }) {
  let cat = null;
  if (categoryId) {
    cat = db.prepare('SELECT * FROM categories WHERE id = ? AND server_id = ?').get(categoryId, serverId);
    if (!cat) throw { code: 'VALIDATION_ERROR', message: 'category not found in this server' };
  }
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?')
    .get(serverId).p;
  const id = uuid();
  db.prepare('INSERT INTO channels (id, server_id, category_id, name, topic, type, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, serverId, cat ? cat.id : null, cleanName(name), String(topic || '').slice(0, 200), 'text', pos);
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

function update(channel, { name, topic, categoryId }) {
  const sets = [];
  const vals = [];
  if (name !== undefined) {
    sets.push('name = ?');
    vals.push(cleanName(name));
  }
  if (topic !== undefined) {
    sets.push('topic = ?');
    vals.push(String(topic).slice(0, 200));
  }
  if (categoryId !== undefined) {
    if (categoryId) {
      const cat = db.prepare('SELECT * FROM categories WHERE id = ? AND server_id = ?')
        .get(categoryId, channel.server_id);
      if (!cat) throw { code: 'VALIDATION_ERROR', message: 'category not found in this server' };
      sets.push('category_id = ?');
      vals.push(cat.id);
    } else {
      sets.push('category_id = ?');
      vals.push(null);
    }
  }
  if (!sets.length) throw { code: 'VALIDATION_ERROR', message: 'nothing to update' };
  vals.push(channel.id);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
}

function remove(serverId, channelId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(channelId, serverId);
  if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found' };
  const count = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?').get(serverId).n;
  if (count <= 1) throw { code: 'CANNOT_DELETE_LAST_CHANNEL', message: 'cannot delete the last channel' };
  db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
  return { ok: true };
}

module.exports = { categories, createCategory, deleteCategory, list, create, update, remove };
