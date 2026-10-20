// The message templates a reader keeps.
//
// A template is a named piece of text the reader inserts: a greeting, a
// sign-off, the paragraph they post every week. They belong to the reader
// and to nobody else - every read, change and deletion carries the owner in
// the WHERE clause - and they go with the account.
//
// The shortcut is the short form the reader types to insert one. It is
// unique per reader, because two templates answering to the same shortcut
// would make the insertion depend on which one was found first.

const db = require('../db');
const { now, uuid } = require('../clock');

const NAME_MAX = 128;
const BODY_MAX = 4000;
const SHORTCUT_MAX = 32;
const SHORTCUT_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such template');
  e.code = 'NOT_FOUND';
  throw e;
}

function cleanName(value) {
  return String(value == null ? '' : value).trim().slice(0, NAME_MAX);
}

function cleanBody(value) {
  return String(value == null ? '' : value).slice(0, BODY_MAX);
}

function cleanShortcut(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (!SHORTCUT_SHAPE.test(text)) {
    bad('a shortcut may use letters, digits, - and _ only');
  }
  return text;
}

// The reader's templates.
async function list(userId) {
  return db.all(
    'SELECT id, name, body, shortcut, created_at AS createdAt, updated_at AS updatedAt'
    + ' FROM message_templates WHERE user_id = ? ORDER BY name ASC, id ASC',
    [userId]
  );
}

// One template, and only the owner's.
async function get(userId, id) {
  const row = await db.get(
    'SELECT id, name, body, shortcut, created_at AS createdAt, updated_at AS updatedAt'
    + ' FROM message_templates WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  if (!row) notFound();
  return row;
}

// A shortcut is one shortcut per reader.
async function shortcutTaken(userId, shortcut, exceptId) {
  if (!shortcut) return false;
  const row = await db.get(
    'SELECT id FROM message_templates WHERE user_id = ? AND shortcut = ?',
    [userId, shortcut]
  );
  return !!row && row.id !== exceptId;
}

async function create(userId, input) {
  const name = cleanName(input && input.name);
  const body = cleanBody(input && input.body);
  const shortcut = cleanShortcut(input && input.shortcut);
  if (!name) bad('a template needs a name');
  if (!body.trim()) bad('a template needs some text');
  if (await shortcutTaken(userId, shortcut, null)) {
    bad('that shortcut is already in use');
  }

  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO message_templates (id, user_id, name, body, shortcut, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, name, body, shortcut, ts, ts]
  );
  return get(userId, id);
}

async function update(userId, id, input) {
  const current = await get(userId, id);
  const name = input && input.name !== undefined ? cleanName(input.name) : current.name;
  const body = input && input.body !== undefined ? cleanBody(input.body) : current.body;
  const shortcut = input && input.shortcut !== undefined
    ? cleanShortcut(input.shortcut)
    : current.shortcut;
  if (!name) bad('a template needs a name');
  if (!body.trim()) bad('a template needs some text');
  if (await shortcutTaken(userId, shortcut, id)) bad('that shortcut is already in use');

  const ts = now();
  await db.run(
    'UPDATE message_templates SET name = ?, body = ?, shortcut = ?, updated_at = ?'
    + ' WHERE id = ? AND user_id = ?',
    [name, body, shortcut, ts, id, userId]
  );
  return get(userId, id);
}

async function remove(userId, id) {
  const info = await db.run('DELETE FROM message_templates WHERE id = ? AND user_id = ?', [id, userId]);
  if (!info.changes) notFound();
  return { ok: true, id };
}

// The template a shortcut names, for the client that expands it.
async function byShortcut(userId, shortcut) {
  const text = cleanShortcut(shortcut);
  if (!text) return null;
  const row = await db.get(
    'SELECT id, name, body, shortcut FROM message_templates WHERE user_id = ? AND shortcut = ?',
    [userId, text]
  );
  return row || null;
}

module.exports = { list, get, create, update, remove, byShortcut };
