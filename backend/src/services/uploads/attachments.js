// Message attachments: the pending-upload lifecycle.
//
// A file is uploaded first and attached to a message afterwards, which is why
// `message_id` is nullable. That gap is where the interesting cases live - an upload
// that is never attached to anything, and an attachment id that arrives for someone
// else's upload or someone else's conversation - so both the write path and the read
// path live here rather than being split across the service.

const db = require('../../db');
const storage = require('../storage');
const { now, uuid, isMember } = require('../../util');
const detect = require('./detect');
const quota = require('./quota');

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

// A file is scoped either to a channel or to a DM conversation - never both, and never
// neither. Exactly one is required, and saying so here beats letting a NULL/NULL row
// through to be invisible later.
function assertScope({ channelId, conversationId }) {
  if (channelId && conversationId) throw new Error('uploads: ambiguous scope');
  if (!channelId && !conversationId) throw new Error('uploads: no scope');
}

function publicRow(r) {
  return {
    id: r.id, filename: r.filename, mime: r.mime,
    size: r.size, url: r.url, message_id: r.message_id || null,
  };
}

async function store({ uploaderId, channelId, conversationId, buffer, originalName }) {
  assertScope({ channelId, conversationId });
  if (!buffer || buffer.length === 0) {
    return { error: 'VALIDATION_ERROR', message: 'empty file' };
  }
  const mime = detect.detectMime(buffer, originalName);
  const over = await quota.check(uploaderId, buffer.length);
  if (over) return over;

  const id = uuid();
  // Only supply an extension when the name does not already have one. Appending
  // unconditionally turned every "photo.png" into "photo.png.png", which is both what
  // the reader sees and what a download is named.
  const own = detect.safeExt(originalName);
  const ext = own || (detect.EXT_FOR_MIME[mime] || '').slice(1);
  const filename = detect.cleanFilename(originalName) + (!own && ext ? '.' + ext : '');
  // The storage key carries the scope, so a channel's objects and a conversation's never
  // share a prefix.
  const key = storage.key.messageMedia(channelId || 'dm-' + conversationId, id);
  await storage.put(key, buffer, mime);
  try {
    await db.run(
      'INSERT INTO attachments (id, message_id, channel_id, dm_conversation_id, uploader_id, filename, mime, size, url, created_at)'
      + ' VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, channelId || null, conversationId || null, uploaderId, filename, mime, buffer.length, '/api/attachments/' + id, now()]
    );
  } catch (e) {
    // An object with no row is an object nobody can ever delete. Undo the write rather
    // than leaving it for the purge to find a week later.
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return {
    id, filename, mime, size: buffer.length,
    url: '/api/attachments/' + id, message_id: null,
  };
}

// Adopt pending attachments into a message. Only the uploader's own pending uploads in
// the same scope can be attached - this is the integrity check, and it is also what stops
// one conversation's file being attached to another conversation's message.
async function attachToMessage(ids, messageId, userId, { channelId, conversationId } = {}) {
  if (!ids || !ids.length) return [];
  assertScope({ channelId, conversationId });
  if (conversationId) {
    await db.run(
      'UPDATE attachments SET dm_message_id = ? WHERE dm_message_id IS NULL AND uploader_id = ? AND dm_conversation_id = ? AND id IN ('
      + ids.map(() => '?').join(',') + ')',
      [messageId, userId, conversationId].concat(ids)
    );
    return getForDmMessage(messageId);
  }
  await db.run(
    'UPDATE attachments SET message_id = ? WHERE message_id IS NULL AND uploader_id = ? AND channel_id = ? AND id IN ('
    + ids.map(() => '?').join(',') + ')',
    [messageId, userId, channelId].concat(ids)
  );
  return getForMessage(messageId);
}

async function getForMessage(messageId) {
  const rows = await db.all('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', [messageId]);
  return rows.map(publicRow);
}

async function getForDmMessage(messageId) {
  const rows = await db.all('SELECT * FROM attachments WHERE dm_message_id = ? ORDER BY created_at', [messageId]);
  return rows.map(publicRow);
}

// messageId -> [attachment, ...]. One query for a whole page of history, because
// fetching per message is what made history slow before.
async function getForMessages(messageIds) {
  const ids = (messageIds || []).slice(0, 250);
  if (!ids.length) return {};
  const rows = await db.all(
    'SELECT * FROM attachments WHERE message_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY created_at',
    ids
  );
  const map = {};
  rows.forEach((r) => {
    (map[r.message_id] = map[r.message_id] || []).push(publicRow(r));
  });
  return map;
}

// The DM equivalent, kept beside getForMessages so the two are read together.
async function getForDmMessages(messageIds) {
  const ids = (messageIds || []).slice(0, 250);
  if (!ids.length) return {};
  const rows = await db.all(
    'SELECT * FROM attachments WHERE dm_message_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY created_at',
    ids
  );
  const map = {};
  rows.forEach((r) => {
    (map[r.dm_message_id] = map[r.dm_message_id] || []).push(publicRow(r));
  });
  return map;
}

// The caller may view this attachment if they are a member of its server, or if it is
// still pending and they are the uploader. Returns the row or null.
async function authorized(userId, attachmentId) {
  const a = await db.get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
  if (!a) return null;
  if (!a.message_id && !a.dm_message_id) return a.uploader_id === userId ? a : null;
  if (a.dm_message_id) {
    // Membership of the conversation, checked directly: there is no server to be a member
    // of. Both sides of it, because a left conversation must lose access to what was said
    // in it.
    const row = await db.get(
      'SELECT 1 AS ok FROM dm_members WHERE conversation_id = ? AND user_id = ?',
      [a.dm_conversation_id, userId]
    );
    return row ? a : null;
  }
  const ch = await db.get('SELECT server_id FROM channels WHERE id = ?', [a.channel_id]);
  if (!ch) return null;
  if (!(await isMember(userId, ch.server_id))) return null;
  return a;
}

// Best-effort object cleanup for the given attachment rows (e.g. when the owning message
// is deleted - the row cascade is handled by the database). The key comes from the row,
// so a channel id that no longer exists cannot redirect the delete somewhere else.
async function removeFiles(rows) {
  for (const row of rows || []) {
    if (typeof row === 'string') {
      const r = await db.get('SELECT channel_id, dm_conversation_id FROM attachments WHERE id = ?', [row]);
      if (r) await storage.delete(storage.key.messageMedia(r.channel_id || 'dm-' + r.dm_conversation_id, row)).catch(() => {});
    } else {
      await storage
        .delete(storage.key.messageMedia(row.channel_id || 'dm-' + row.dm_conversation_id, row.id))
        .catch(() => {});
    }
  }
}

// Called on the hourly purge: drop orphaned files and their rows so an abandoned upload
// never becomes a permanent disk leak.
async function purgePending() {
  const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  const rows = await db.all(
    'SELECT id FROM attachments WHERE message_id IS NULL AND dm_message_id IS NULL AND created_at < ?', [cutoff]
  );
  if (!rows.length) return;
  await db.run('DELETE FROM attachments WHERE message_id IS NULL AND dm_message_id IS NULL AND created_at < ?', [cutoff]);
  await removeFiles(rows.map((r) => r.id));
}

// Read helper for the serving route. Same scoping rule as store(): a DM file is filed
// under its conversation, so a channel id of null can never send the lookup elsewhere.
function open(row) {
  return storage.createReadStream(
    storage.key.messageMedia(row.channel_id || 'dm-' + row.dm_conversation_id, row.id)
  );
}

module.exports = {
  store,
  attachToMessage,
  getForMessage,
  getForMessages,
  getForDmMessage,
  getForDmMessages,
  authorized,
  removeFiles,
  purgePending,
  open,
};
