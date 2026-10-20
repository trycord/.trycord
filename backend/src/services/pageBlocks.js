// Reusable blocks: the parts of a page that are written once and used in more
// than one page.
//
// The editor's library used to live in the browser, which meant a block could
// only ever be shared with the person who wrote it. A shared block is content
// for the whole instance, so it lives on the server, and two administrators of
// the same instance can insert the same one.
//
// A page holds the content of a block, not a reference to it. Inserting a
// block copies its blocks into the page, and the revision records them as they
// were at that moment. That is deliberate: resolving a block at render time
// would let a later edit to the block change a page that was already published
// and accepted, and a published page is a thing visitors have already read.
//
// A block's scope is fixed when it is created. A shared block is instance-wide,
// so writing one is an administrative act; a personal block belongs to its
// author and nobody else can see it. Making a block shared later is done by
// creating it shared, so that what happens to the instance-wide library is
// always an explicit, audited act.
const db = require('../db');
const { now, uuid } = require('../util');
const content = require('./pageContent');
const enforcement = require('./enforcement');

const SCOPES = { PERSONAL: 'PERSONAL', SHARED: 'SHARED' };
const MAX_NAME = 128;

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('reusable block not found');
  e.code = 'NOT_FOUND';
  throw e;
}

function parse(body) {
  try {
    return JSON.parse(body || '[]');
  } catch {
    return [];
  }
}

// Writing a shared block is an administrative act, because the block is
// instance-wide content: it appears in the library of every administrator.
async function requireAdmin(actorId) {
  if (!(await enforcement.isPlatformAdmin(actorId))) {
    bad('only an administrator can write a shared reusable block', 'PERMISSION_DENIED');
  }
}

// A personal block belongs to its author. A caller who does not own it is
// told the block does not exist, rather than that it exists and is not theirs:
// the library is not an inventory of other people's work.
function requireOwner(row, actorId) {
  if (row.author_id !== actorId) notFound();
}

function toPublic(row, actorId) {
  return {
    id: row.id,
    name: row.name,
    body: parse(row.body),
    scope: row.scope,
    authorId: row.author_id,
    mine: row.author_id === actorId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scopeOf(raw) {
  if (raw == null || raw === '') return SCOPES.PERSONAL;
  const wanted = String(raw).toUpperCase();
  if (wanted !== SCOPES.PERSONAL && wanted !== SCOPES.SHARED) {
    bad('a reusable block is either shared or personal');
  }
  return wanted;
}

function nameOf(raw) {
  const label = String(raw == null ? '' : raw).trim().slice(0, MAX_NAME);
  if (!label) bad('a reusable block needs a name');
  return label;
}

// The body of a block is page content, so it is held to the page validator:
// a stored block is content the renderer has already agreed it can render.
function bodyOf(raw) {
  const blocks = content.normalise(raw);
  if (!blocks.length) bad('a reusable block needs at least one block');
  return blocks;
}

// Every block this caller may see: the shared ones, and their own personal
// ones. The personal blocks of other administrators are not in the list.
async function list({ actorId }) {
  const rows = await db.all(
    'SELECT * FROM page_blocks WHERE scope = ? OR author_id = ? ORDER BY name, created_at',
    [SCOPES.SHARED, actorId]
  );
  return rows.map((row) => toPublic(row, actorId));
}

async function create({ actorId, name, body, scope }) {
  const wanted = scopeOf(scope);
  if (wanted === SCOPES.SHARED) await requireAdmin(actorId);
  const blocks = bodyOf(body);
  const label = nameOf(name);
  const ts = now();
  const id = uuid();
  await db.run(
    'INSERT INTO page_blocks (id, name, body, author_id, scope, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, label, JSON.stringify(blocks), actorId, wanted, ts, ts]
  );
  await enforcement.audit(actorId, 'PAGE_BLOCK_CREATED', 'page_block', id, wanted);
  return toPublic(await db.get('SELECT * FROM page_blocks WHERE id = ?', [id]), actorId);
}

async function update({ actorId, id, name, body }) {
  const row = await db.get('SELECT * FROM page_blocks WHERE id = ?', [id]);
  if (!row) notFound();
  // A shared block is instance content, so writing one is administrative. A
  // personal block is the author's alone.
  if (row.scope === SCOPES.SHARED) await requireAdmin(actorId);
  else requireOwner(row, actorId);
  const label = name === undefined ? row.name : nameOf(name);
  const blocks = body === undefined ? parse(row.body) : bodyOf(body);
  await db.run(
    'UPDATE page_blocks SET name = ?, body = ?, updated_at = ? WHERE id = ?',
    [label, JSON.stringify(blocks), now(), row.id]
  );
  await enforcement.audit(actorId, 'PAGE_BLOCK_UPDATED', 'page_block', row.id, row.scope);
  return toPublic(await db.get('SELECT * FROM page_blocks WHERE id = ?', [id]), actorId);
}

async function remove({ actorId, id }) {
  const row = await db.get('SELECT * FROM page_blocks WHERE id = ?', [id]);
  if (!row) notFound();
  if (row.scope === SCOPES.SHARED) await requireAdmin(actorId);
  else requireOwner(row, actorId);
  await db.run('DELETE FROM page_blocks WHERE id = ?', [row.id]);
  await enforcement.audit(actorId, 'PAGE_BLOCK_DELETED', 'page_block', row.id, row.scope);
  return { ok: true, id: row.id };
}

module.exports = { SCOPES, list, create, update, remove };
