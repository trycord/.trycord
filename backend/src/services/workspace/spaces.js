// Spaces: the navigation and configuration layer over a community.
//
// A space groups references - channels, documents, a board, resource links -
// and gives the community a way to arrange them. It is not a second container
// for the community's data: everything in a space is a reference to something
// that already exists and keeps its own access rules.
//
// The access rules, in the order they apply:
//
//   1. the community's role permissions decide who is a member at all
//   2. a channel's own overrides decide who may take part in that channel
//   3. the space's visibility decides who may see the space
//
// A space can only narrow. Listing a channel in a space never makes a
// restricted channel readable, and a public space never exposes a document
// that lives in a private one.
const db = require('../../db');
const { now, uuid } = require('../../util');
const { fail, text, required, httpUrl, oneOf } = require('./common');
const { canAccessChannel, canViewSpace } = require('./access');

const ITEM_KINDS = ['channel', 'document', 'board', 'resource'];

// The space, in the shape the API answers with.
function shape(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    description: row.description || '',
    isPrivate: !!row.is_private,
    requiredRoleId: row.required_role_id || null,
    position: Number(row.position || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeItem(row) {
  return {
    id: row.id,
    spaceId: row.space_id,
    kind: row.kind,
    targetId: row.target_id || null,
    title: row.title || '',
    url: row.url || null,
    position: Number(row.position || 0),
    createdAt: row.created_at,
  };
}

// The items of a space, filtered for one member.
//
// A channel item is listed only for the members who may take part in that
// channel. A document or a board is listed only when the space it lives in is
// visible to the member, so a public space cannot become a window onto a
// private one.
async function visibleItems(serverId, space, viewerId, isOwner) {
  const rows = await db.all(
    'SELECT * FROM space_items WHERE space_id = ? ORDER BY position ASC, created_at ASC, id ASC',
    [space.id]
  );
  const out = [];
  for (const row of rows) {
    if (row.kind === 'channel') {
      if (!(await canAccessChannel(viewerId, serverId, row.target_id))) continue;
    } else if (row.kind === 'document' || row.kind === 'board') {
      if (!(await targetVisible(serverId, row.kind, row.target_id, viewerId, isOwner))) continue;
    }
    out.push(shapeItem(row));
  }
  return out;
}

// Whether the thing a reference points at is visible to this member.
async function targetVisible(serverId, kind, targetId, viewerId, isOwner) {
  if (!targetId) return false;
  if (kind === 'document') {
    const doc = await db.get('SELECT space_id FROM documents WHERE id = ? AND server_id = ?', [targetId, serverId]);
    if (!doc) return false;
    if (!doc.space_id) return true;
    const space = await db.get('SELECT * FROM spaces WHERE id = ?', [doc.space_id]);
    return canViewSpace(serverId, space, viewerId, isOwner);
  }
  if (kind === 'board') {
    const board = await db.get('SELECT space_id FROM boards WHERE id = ? AND server_id = ?', [targetId, serverId]);
    if (!board) return false;
    if (!board.space_id) return true;
    const space = await db.get('SELECT * FROM spaces WHERE id = ?', [board.space_id]);
    return canViewSpace(serverId, space, viewerId, isOwner);
  }
  return true;
}

// A space the member may see, or null. A space that exists but is not visible
// to this member reads as absent rather than as forbidden: the member is not
// told that a private space is there.
async function visibleSpace(serverId, spaceId, viewerId, isOwner) {
  const row = await db.get('SELECT * FROM spaces WHERE id = ? AND server_id = ?', [spaceId, serverId]);
  if (!row) return null;
  if (!(await canViewSpace(serverId, row, viewerId, isOwner))) return null;
  return row;
}

async function list(serverId, viewerId, isOwner) {
  const rows = await db.all(
    'SELECT * FROM spaces WHERE server_id = ? ORDER BY position ASC, name ASC',
    [serverId]
  );
  const out = [];
  for (const row of rows) {
    if (!(await canViewSpace(serverId, row, viewerId, isOwner))) continue;
    out.push(Object.assign(shape(row), { items: await visibleItems(serverId, row, viewerId, isOwner) }));
  }
  return out;
}

async function get(serverId, spaceId, viewerId, isOwner) {
  const row = await visibleSpace(serverId, spaceId, viewerId, isOwner);
  if (!row) fail('NOT_FOUND', 'space not found');
  return Object.assign(shape(row), { items: await visibleItems(serverId, row, viewerId, isOwner) });
}

// The role a private space names has to be a role of this community, and the
// person creating the space has to be able to see what they are creating:
// the owner, or a holder of that role.
async function assertRoleUsable(serverId, roleId, actorId, isOwner) {
  const role = await db.get('SELECT id FROM roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
  if (!role) fail('VALIDATION_ERROR', 'that role is not in this community');
  if (isOwner) return role;
  const roles = require('../roles');
  if (!(await roles.userHasRole(serverId, actorId, roleId))) {
    fail('PERMISSION_DENIED', 'you cannot create a space for a role you do not hold');
  }
  return role;
}

async function create(serverId, actorId, isOwner, { name, description, isPrivate, requiredRoleId }) {
  const clean = required(name, 64, 'name');
  const privateSpace = isPrivate === true;
  let roleId = null;
  if (privateSpace) {
    roleId = String(requiredRoleId || '').trim();
    if (!roleId) fail('VALIDATION_ERROR', 'a private space needs the role that may see it');
    await assertRoleUsable(serverId, roleId, actorId, isOwner);
  }
  const pos = await db.get(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM spaces WHERE server_id = ?',
    [serverId]
  );
  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO spaces (id, server_id, name, description, is_private, required_role_id, position, created_by, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, serverId, clean, text(description, 1000, 'description'), privateSpace ? 1 : 0,
      roleId, pos.p, actorId, ts, ts]
  );
  return get(serverId, id, actorId, isOwner);
}

async function update(serverId, spaceId, actorId, isOwner, patch) {
  const row = await visibleSpace(serverId, spaceId, actorId, isOwner);
  if (!row) fail('NOT_FOUND', 'space not found');
  const sets = [];
  const vals = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(required(patch.name, 64, 'name'));
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    vals.push(text(patch.description, 1000, 'description'));
  }
  if (patch.isPrivate !== undefined) {
    const privateSpace = patch.isPrivate === true;
    if (privateSpace && !row.required_role_id && !patch.requiredRoleId) {
      fail('VALIDATION_ERROR', 'a private space needs the role that may see it');
    }
    sets.push('is_private = ?');
    vals.push(privateSpace ? 1 : 0);
  }
  if (patch.requiredRoleId !== undefined) {
    const roleId = String(patch.requiredRoleId || '').trim();
    if (roleId) await assertRoleUsable(serverId, roleId, actorId, isOwner);
    sets.push('required_role_id = ?');
    vals.push(roleId || null);
  }
  if (patch.position !== undefined) {
    const position = Number(patch.position);
    if (!Number.isInteger(position) || position < 0) fail('VALIDATION_ERROR', 'position must be a whole number of at least 0');
    sets.push('position = ?');
    vals.push(position);
  }
  if (!sets.length) fail('VALIDATION_ERROR', 'nothing to update');
  vals.push(row.id);
  await db.run(`UPDATE spaces SET ${sets.join(', ')} WHERE id = ?`, vals);
  return get(serverId, row.id, actorId, isOwner);
}

async function remove(serverId, spaceId, actorId, isOwner) {
  const row = await visibleSpace(serverId, spaceId, actorId, isOwner);
  if (!row) fail('NOT_FOUND', 'space not found');
  await db.run('DELETE FROM spaces WHERE id = ?', [row.id]);
  return { ok: true, id: row.id };
}

// The title a reference carries when the caller did not give one.
async function defaultTitle(serverId, kind, targetId) {
  if (kind === 'channel') {
    const ch = await db.get('SELECT name FROM channels WHERE id = ? AND server_id = ?', [targetId, serverId]);
    return ch ? ch.name : '';
  }
  if (kind === 'document') {
    const doc = await db.get('SELECT title FROM documents WHERE id = ? AND server_id = ?', [targetId, serverId]);
    return doc ? doc.title : '';
  }
  if (kind === 'board') {
    const board = await db.get('SELECT name FROM boards WHERE id = ? AND server_id = ?', [targetId, serverId]);
    return board ? board.name : '';
  }
  return '';
}

// A reference is checked before it is stored: the thing has to exist in this
// community, and the person adding it has to be allowed to know about it. A
// member who may not take part in a channel cannot add it to a space and use
// the space to find out that it is there.
async function assertTargetUsable(serverId, kind, targetId, actorId) {
  if (kind === 'channel') {
    const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [targetId, serverId]);
    if (!ch) fail('NOT_FOUND', 'channel not found in this community');
    if (!(await canAccessChannel(actorId, serverId, ch.id))) {
      fail('PERMISSION_DENIED', 'you cannot reference a channel you may not take part in');
    }
    return;
  }
  if (kind === 'document') {
    const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [targetId, serverId]);
    if (!doc) fail('NOT_FOUND', 'document not found in this community');
    return;
  }
  if (kind === 'board') {
    const board = await db.get('SELECT id FROM boards WHERE id = ? AND server_id = ?', [targetId, serverId]);
    if (!board) fail('NOT_FOUND', 'board not found in this community');
  }
}

async function addItem(serverId, spaceId, actorId, isOwner, { kind, targetId, title, url }) {
  const space = await visibleSpace(serverId, spaceId, actorId, isOwner);
  if (!space) fail('NOT_FOUND', 'space not found');
  const itemKind = oneOf(kind, ITEM_KINDS, 'kind');
  let target = null;
  let link = null;
  if (itemKind === 'resource') {
    link = httpUrl(url);
  } else {
    target = String(targetId || '').trim();
    if (!target) fail('VALIDATION_ERROR', 'targetId is required for this kind');
    await assertTargetUsable(serverId, itemKind, target, actorId);
  }
  const label = text(title, 255, 'title') || (await defaultTitle(serverId, itemKind, target));
  const pos = await db.get(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM space_items WHERE space_id = ?',
    [space.id]
  );
  const id = uuid();
  await db.run(
    'INSERT INTO space_items (id, space_id, kind, target_id, title, url, position, created_by, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, space.id, itemKind, target, label, link, pos.p, actorId, now()]
  );
  const row = await db.get('SELECT * FROM space_items WHERE id = ?', [id]);
  return shapeItem(row);
}

async function removeItem(serverId, spaceId, itemId, actorId, isOwner) {
  const space = await visibleSpace(serverId, spaceId, actorId, isOwner);
  if (!space) fail('NOT_FOUND', 'space not found');
  const row = await db.get('SELECT * FROM space_items WHERE id = ? AND space_id = ?', [itemId, space.id]);
  if (!row) fail('NOT_FOUND', 'space item not found');
  await db.run('DELETE FROM space_items WHERE id = ?', [row.id]);
  return { ok: true, id: row.id };
}

// The order the items appear in. The whole list is given, so a client that
// drops one item is refused rather than quietly reordering the rest.
async function reorderItems(serverId, spaceId, actorId, isOwner, orderedIds) {
  const space = await visibleSpace(serverId, spaceId, actorId, isOwner);
  if (!space) fail('NOT_FOUND', 'space not found');
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    fail('VALIDATION_ERROR', 'orderedIds must be a non-empty array');
  }
  const rows = await db.all('SELECT id FROM space_items WHERE space_id = ?', [space.id]);
  const known = new Set(rows.map((r) => String(r.id)));
  const clean = orderedIds.map(String);
  if (clean.length !== known.size || !clean.every((id) => known.has(id))) {
    fail('VALIDATION_ERROR', 'orderedIds must contain exactly the items of this space');
  }
  await db.transaction(async (t) => {
    let pos = 0;
    for (const id of clean) {
      await t.run('UPDATE space_items SET position = ? WHERE id = ?', [pos++, id]);
    }
  });
  return visibleItems(serverId, space, actorId, isOwner);
}

module.exports = {
  ITEM_KINDS,
  list, get, create, update, remove,
  addItem, removeItem, reorderItems,
};
