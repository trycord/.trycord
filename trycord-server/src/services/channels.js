// Channel + category lifecycle. Channels belong to a server,
// optionally grouped under a category.
const db = require('../db');
const { uuid } = require('../util');

function cleanName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').slice(0, 32) || 'channel';
}

async function categories(serverId) {
  return db.all('SELECT * FROM categories WHERE server_id = ? ORDER BY position, name', [serverId]);
}

async function createCategory(serverId, name) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'category name required' };
  const pos = await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories WHERE server_id = ?', [serverId]);
  const id = uuid();
  await db.run('INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)', [id, serverId, clean, pos.p]);
  return db.get('SELECT * FROM categories WHERE id = ?', [id]);
}

async function deleteCategory(serverId, categoryId) {
  const cat = await db.get('SELECT * FROM categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
  if (!cat) throw { code: 'NOT_FOUND', message: 'category not found' };
  await db.run('DELETE FROM categories WHERE id = ?', [cat.id]); // channels SET NULL
  return { ok: true };
}

async function list(serverId) {
  // Categories and channels are independent — fetch concurrently.
  const [cats, channels] = await Promise.all([
    categories(serverId),
    db.all('SELECT * FROM channels WHERE server_id = ? ORDER BY position, name', [serverId]),
  ]);
  return { categories: cats, channels };
}

async function create(serverId, { name, topic, categoryId }) {
  let cat = null;
  if (categoryId) {
    cat = await db.get('SELECT * FROM categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
    if (!cat) throw { code: 'VALIDATION_ERROR', message: 'category not found in this server' };
  }
  const pos = await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?', [serverId]);
  const id = uuid();
  await db.run(
    'INSERT INTO channels (id, server_id, category_id, name, topic, type, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, serverId, cat ? cat.id : null, cleanName(name), String(topic || '').slice(0, 200), 'text', pos.p]
  );
  return db.get('SELECT * FROM channels WHERE id = ?', [id]);
}

async function update(channel, { name, topic, categoryId }) {
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
      const cat = await db.get('SELECT * FROM categories WHERE id = ? AND server_id = ?', [categoryId, channel.server_id]);
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
  await db.run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, vals);
  return db.get('SELECT * FROM channels WHERE id = ?', [channel.id]);
}

async function remove(serverId, channelId) {
  return db.transaction(async (t) => {
    const ch = await t.get('SELECT * FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
    if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found' };
    const count = await t.get('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', [serverId]);
    if (count.n <= 1) throw { code: 'CANNOT_DELETE_LAST_CHANNEL', message: 'cannot delete the last channel' };
    await t.run('DELETE FROM channels WHERE id = ?', [ch.id]);
    return { ok: true };
  });
}

module.exports = { categories, createCategory, deleteCategory, list, create, update, remove };
