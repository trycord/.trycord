// Channel + category lifecycle. Channels belong to a server,
// optionally grouped under a category.
const db = require('../db');
const { uuid } = require('../util');
const slugs = require('./slugs');

function cleanName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').slice(0, 32) || 'channel';
}

// The types the backend can actually honour. `announcement` and `forum` exist in older
// rows as icons only - a channel of those types behaves exactly like text - so they stay
// readable but are not offered: letting one be set would promise a behaviour that is not
// there. `stage` is a voice channel the audience cannot speak in until a moderator grants
// it; see services/voice.js.
const CHANNEL_TYPES = ['text', 'voice', 'stage'];

function cleanType(type, fallback = 'text') {
  if (type === undefined || type === null || String(type).trim() === '') return fallback;
  const clean = String(type).trim().toLowerCase();
  if (!CHANNEL_TYPES.includes(clean)) {
    throw { code: 'VALIDATION_ERROR', message: 'Unknown channel type: ' + clean };
  }
  return clean;
}

async function categories(serverId) {
  return db.all('SELECT * FROM categories WHERE server_id = ? ORDER BY position, name', [serverId]);
}

async function createCategory(serverId, name) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'Category name required' };
  const pos = await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories WHERE server_id = ?', [serverId]);
  const id = uuid();
  await db.run('INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)', [id, serverId, clean, pos.p]);
  return db.get('SELECT * FROM categories WHERE id = ?', [id]);
}

async function deleteCategory(serverId, categoryId) {
  const cat = await db.get('SELECT * FROM categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
  if (!cat) throw { code: 'NOT_FOUND', message: 'Category not found' };
  await db.run('DELETE FROM categories WHERE id = ?', [cat.id]); // channels SET NULL
  return { ok: true };
}

async function renameCategory(serverId, categoryId, name) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'Category name required' };
  const cat = await db.get('SELECT * FROM categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
  if (!cat) throw { code: 'NOT_FOUND', message: 'Category not found' };
  await db.run('UPDATE categories SET name = ? WHERE id = ?', [clean, cat.id]);
  return db.get('SELECT * FROM categories WHERE id = ?', [cat.id]);
}

// Atomic reorder of this server's categories. The id list must match
// exactly; positions are rewritten 0..n in one transaction.
async function reorderCategories(serverId, orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw { code: 'VALIDATION_ERROR', message: 'OrderedIds must be a non-empty array' };
  }
  return db.transaction(async (t) => {
    const rows = await t.all('SELECT id FROM categories WHERE server_id = ?', [serverId]);
    const known = new Set(rows.map((r) => String(r.id)));
    const clean = orderedIds.map(String);
    if (clean.length !== known.size || !clean.every((id) => known.has(id))) {
      throw { code: 'VALIDATION_ERROR', message: 'OrderedIds must contain exactly the server categories' };
    }
    let pos = 0;
    for (const id of clean) {
      await t.run('UPDATE categories SET position = ? WHERE id = ?', [pos++, id]);
    }
    return list(serverId);
  });
}

// Atomic reorder of this server's channels. Same exact-match contract as
// categories; channel<->category association is unchanged (use update to
// move a channel between categories first).
async function reorderChannels(serverId, orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw { code: 'VALIDATION_ERROR', message: 'OrderedIds must be a non-empty array' };
  }
  return db.transaction(async (t) => {
    const rows = await t.all('SELECT id FROM channels WHERE server_id = ?', [serverId]);
    const known = new Set(rows.map((r) => String(r.id)));
    const clean = orderedIds.map(String);
    if (clean.length !== known.size || !clean.every((id) => known.has(id))) {
      throw { code: 'VALIDATION_ERROR', message: 'OrderedIds must contain exactly the server channels' };
    }
    let pos = 0;
    for (const id of clean) {
      await t.run('UPDATE channels SET position = ? WHERE id = ?', [pos++, id]);
    }
    return list(serverId);
  });
}

async function list(serverId) {
  // Categories and channels are independent — fetch concurrently.
  const [cats, channels] = await Promise.all([
    categories(serverId),
    db.all('SELECT * FROM channels WHERE server_id = ? ORDER BY position, name', [serverId]),
  ]);
  return { categories: cats, channels };
}

async function create(serverId, { name, topic, categoryId, type }) {
  let cat = null;
  if (categoryId) {
    cat = await db.get('SELECT * FROM categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
    if (!cat) throw { code: 'VALIDATION_ERROR', message: 'Category not found in this server' };
  }
  const kind = cleanType(type);
  const pos = await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?', [serverId]);
  const id = uuid();
  const clean = cleanName(name);
  await db.run(
    'INSERT INTO channels (id, server_id, category_id, name, topic, type, position, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, serverId, cat ? cat.id : null, clean, String(topic || '').slice(0, 200), kind, pos.p,
      await slugs.forChannel(clean, serverId)]
  );
  return db.get('SELECT * FROM channels WHERE id = ?', [id]);
}

async function update(channel, { name, topic, categoryId, type }) {
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
  if (type !== undefined) {
    const kind = cleanType(type, channel.type);
    // A type change is refused while the room is live. Flipping a channel to text with
    // people still connected would leave their voice_rooms and voice_participants rows
    // behind, so the change waits until the room is empty rather than orphaning them.
    if (kind !== channel.type) {
      const live = await db.get(
        'SELECT id FROM voice_participants WHERE channel_id = ? AND left_at IS NULL LIMIT 1',
        [channel.id]
      );
      if (live) {
        throw {
          code: 'CHANNEL_IN_USE',
          message: 'Someone is connected to this channel. Ask them to leave before changing its type.',
        };
      }
    }
    sets.push('type = ?');
    vals.push(kind);
  }
  if (categoryId !== undefined) {
    if (categoryId) {
      const cat = await db.get('SELECT * FROM categories WHERE id = ? AND server_id = ?', [categoryId, channel.server_id]);
      if (!cat) throw { code: 'VALIDATION_ERROR', message: 'Category not found in this server' };
      sets.push('category_id = ?');
      vals.push(cat.id);
    } else {
      sets.push('category_id = ?');
      vals.push(null);
    }
  }
  if (!sets.length) throw { code: 'VALIDATION_ERROR', message: 'Nothing to update' };
  vals.push(channel.id);
  await db.run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, vals);
  return db.get('SELECT * FROM channels WHERE id = ?', [channel.id]);
}

async function remove(serverId, channelId) {
  return db.transaction(async (t) => {
    const ch = await t.get('SELECT * FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
    if (!ch) throw { code: 'NOT_FOUND', message: 'Channel not found' };
    const count = await t.get('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', [serverId]);
    if (count.n <= 1) throw { code: 'CANNOT_DELETE_LAST_CHANNEL', message: 'Cannot delete the last channel' };
    await t.run('DELETE FROM channels WHERE id = ?', [ch.id]);
    return { ok: true };
  });
}

module.exports = { categories, createCategory, renameCategory, reorderCategories, deleteCategory, list, create, update, remove, reorderChannels, CHANNEL_TYPES };
