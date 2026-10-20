// The collections a reader saves things into.
//
// A collection belongs to one community, because sharing is with a
// community: a private collection is visible to its owner alone, a shared
// one to the members of the community it belongs to.
//
// What is in a collection is a reference, never a copy. A saved message
// stays where it is and keeps its own permissions, so sharing a collection
// shares the list and not the content - a member of the community who may
// not read the channel a saved message is in is shown nothing for it.
//
// Everything here is the reader's own: the rows cascade with the account.

const db = require('../db');
const { now, uuid } = require('../clock');

const NAME_MAX = 128;
const REF_MAX = 512;
const TITLE_MAX = 255;

const ITEM_TYPES = ['message', 'file', 'link'];
const VISIBILITIES = ['private', 'community'];

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such collection');
  e.code = 'NOT_FOUND';
  throw e;
}

function cleanName(value) {
  return String(value == null ? '' : value).trim().slice(0, NAME_MAX);
}

function cleanVisibility(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return 'private';
  if (!VISIBILITIES.includes(text)) {
    bad('visibility must be private or community');
  }
  return text;
}

// Is the reader in this community?
async function isMember(userId, serverId) {
  const row = await db.get(
    'SELECT 1 AS n FROM server_members WHERE user_id = ? AND server_id = ?',
    [userId, serverId]
  );
  return !!row;
}

// Can the reader see this message? A message is visible to the members of
// the community it was written in.
async function canSeeMessage(userId, messageId) {
  const row = await db.get(
    'SELECT ch.server_id AS server_id FROM messages m JOIN channels ch ON ch.id = m.channel_id'
    + ' WHERE m.id = ?',
    [messageId]
  );
  if (!row) return { ok: false, reason: 'no such message' };
  if (!(await isMember(userId, row.server_id))) {
    return { ok: false, reason: 'you are not in that community' };
  }
  return { ok: true, serverId: row.server_id };
}

// Can the reader see this file? A file in a channel is visible to the
// members of that channel's community; a file in a direct conversation to
// the people in that conversation.
async function canSeeFile(userId, attachmentId) {
  const row = await db.get(
    'SELECT id, channel_id, dm_conversation_id, filename FROM attachments WHERE id = ?',
    [attachmentId]
  );
  if (!row) return { ok: false, reason: 'no such file' };
  if (row.channel_id) {
    const channel = await db.get('SELECT server_id FROM channels WHERE id = ?', [row.channel_id]);
    if (!channel) return { ok: false, reason: 'no such file' };
    if (!(await isMember(userId, channel.server_id))) {
      return { ok: false, reason: 'you are not in that community' };
    }
    return { ok: true, serverId: channel.server_id, filename: row.filename };
  }
  if (row.dm_conversation_id) {
    const member = await db.get(
      'SELECT 1 AS n FROM dm_members WHERE conversation_id = ? AND user_id = ?',
      [row.dm_conversation_id, userId]
    );
    if (!member) return { ok: false, reason: 'you are not in that conversation' };
    return { ok: true, filename: row.filename };
  }
  return { ok: false, reason: 'no such file' };
}

// A link a reader saved. Only an http(s) address: anything else - a
// javascript: URL, a data: URL - is not something to put in a list that
// other people will open.
function cleanLink(value) {
  const text = String(value == null ? '' : value).trim().slice(0, REF_MAX);
  if (!text) bad('a link needs an address');
  let url;
  try {
    url = new URL(text);
  } catch {
    bad('that is not a link');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    bad('a link must be an http or https address');
  }
  return url.toString();
}

// The collections a reader may see: their own, and the shared ones in the
// communities they belong to.
async function listForUser(userId) {
  return db.all(
    `SELECT c.id, c.name, c.visibility, c.server_id AS serverId, c.user_id AS ownerId,
            c.created_at AS createdAt, c.updated_at AS updatedAt,
            s.name AS serverName,
            (SELECT COUNT(*) FROM saved_collection_items i WHERE i.collection_id = c.id) AS itemCount
       FROM saved_collections c
       JOIN servers s ON s.id = c.server_id
      WHERE c.user_id = ?
         OR (c.visibility = 'community'
             AND EXISTS (SELECT 1 FROM server_members sm
                          WHERE sm.server_id = c.server_id AND sm.user_id = ?))
      ORDER BY c.created_at DESC, c.id DESC`,
    [userId, userId]
  );
}

// One collection, and only one this reader may see.
async function get(userId, id) {
  const row = await db.get(
    `SELECT c.id, c.name, c.visibility, c.server_id AS serverId, c.user_id AS ownerId,
            c.created_at AS createdAt, c.updated_at AS updatedAt, s.name AS serverName
       FROM saved_collections c JOIN servers s ON s.id = c.server_id
      WHERE c.id = ?`,
    [id]
  );
  if (!row) notFound();
  if (row.ownerId !== userId) {
    if (row.visibility !== 'community' || !(await isMember(userId, row.serverId))) {
      notFound();
    }
  }
  return row;
}

// What is in it. The references, not the things they point at.
async function items(userId, id) {
  await get(userId, id);
  return db.all(
    'SELECT id, item_type AS itemType, item_id AS itemId, item_ref AS itemRef,'
    + ' title, created_at AS createdAt FROM saved_collection_items'
    + ' WHERE collection_id = ? ORDER BY created_at ASC, id ASC',
    [id]
  );
}

async function create(userId, input) {
  const serverId = String((input && input.serverId) || '').trim();
  if (!serverId) bad('a collection belongs to a community');
  const name = cleanName(input && input.name);
  if (!name) bad('a collection needs a name');
  const visibility = cleanVisibility(input && input.visibility);
  if (!(await isMember(userId, serverId))) {
    bad('you are not in that community', 'NOT_A_MEMBER');
  }

  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO saved_collections (id, user_id, server_id, name, visibility, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, serverId, name, visibility, ts, ts]
  );
  return get(userId, id);
}

// Only the owner renames a collection or changes who can see it.
async function update(userId, id, input) {
  const current = await get(userId, id);
  if (current.ownerId !== userId) {
    const e = new Error('only the owner can change this collection');
    e.code = 'PERMISSION_DENIED';
    throw e;
  }
  const name = input && input.name !== undefined ? cleanName(input.name) : current.name;
  const visibility = input && input.visibility !== undefined
    ? cleanVisibility(input.visibility)
    : current.visibility;
  if (!name) bad('a collection needs a name');

  const ts = now();
  await db.run(
    'UPDATE saved_collections SET name = ?, visibility = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [name, visibility, ts, id, userId]
  );
  return get(userId, id);
}

async function remove(userId, id) {
  const current = await get(userId, id);
  if (current.ownerId !== userId) {
    const e = new Error('only the owner can delete this collection');
    e.code = 'PERMISSION_DENIED';
    throw e;
  }
  await db.run('DELETE FROM saved_collections WHERE id = ? AND user_id = ?', [id, userId]);
  return { ok: true, id };
}

// Put something in a collection.
//
// What may go in is decided by what the reader may see. A message or a file
// has to be in the collection's own community, so that sharing the
// collection never points at something from a private community; a link is
// the reader's own reference and may be anywhere.
async function addItem(userId, id, input) {
  const collection = await get(userId, id);
  if (collection.ownerId !== userId) {
    const e = new Error('only the owner can add to this collection');
    e.code = 'PERMISSION_DENIED';
    throw e;
  }
  const itemType = String((input && input.itemType) || '').trim().toLowerCase();
  if (!ITEM_TYPES.includes(itemType)) {
    bad('itemType must be message, file or link');
  }

  let itemId = null;
  let itemRef = null;
  let title = String((input && input.title) || '').trim().slice(0, TITLE_MAX) || null;

  if (itemType === 'message') {
    itemId = String((input && input.itemId) || '').trim();
    if (!itemId) bad('itemId is required');
    const seen = await canSeeMessage(userId, itemId);
    if (!seen.ok) bad(seen.reason);
    if (seen.serverId !== collection.serverId) {
      bad('that is not in the community this collection belongs to');
    }
  } else if (itemType === 'file') {
    itemId = String((input && input.itemId) || '').trim();
    if (!itemId) bad('itemId is required');
    const seen = await canSeeFile(userId, itemId);
    if (!seen.ok) bad(seen.reason);
    if (seen.serverId && seen.serverId !== collection.serverId) {
      bad('that is not in the community this collection belongs to');
    }
    if (!title && seen.filename) title = seen.filename;
  } else {
    itemRef = cleanLink(input && (input.itemRef || input.url));
    itemId = String((input && input.itemId) || '').trim().slice(0, 64) || uuid();
    if (!title) title = itemRef;
  }

  const rowId = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO saved_collection_items (id, collection_id, item_type, item_id, item_ref, title, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [rowId, id, itemType, itemId, itemRef, title, ts]
  );
  return db.get(
    'SELECT id, item_type AS itemType, item_id AS itemId, item_ref AS itemRef, title,'
    + ' created_at AS createdAt FROM saved_collection_items WHERE id = ?',
    [rowId]
  );
}

async function removeItem(userId, id, itemId) {
  const collection = await get(userId, id);
  if (collection.ownerId !== userId) {
    const e = new Error('only the owner can change this collection');
    e.code = 'PERMISSION_DENIED';
    throw e;
  }
  const info = await db.run(
    'DELETE FROM saved_collection_items WHERE id = ? AND collection_id = ?',
    [itemId, id]
  );
  if (!info.changes) notFound();
  return { ok: true, id: itemId };
}

module.exports = {
  listForUser, get, items, create, update, remove, addItem, removeItem, isMember,
};
