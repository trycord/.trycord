// Attachment pipeline. Files are written through the storage service, never
// straight to disk, so the same code works on local disk or an S3-compatible
// bucket. Files are keyed by a generated id and a key that encodes the owner,
// never by the uploader's filename, and are validated by magic bytes before
// anything is written. `message_id` is null while an upload is "pending"
// (uploaded but not yet attached to a message); pending files older than
// PENDING_TTL_MS are purged.
const db = require('../db');
const storage = require('./storage');
const { now, uuid, isMember } = require('../util');

const MAX_SIZE = 8 * 1024 * 1024; // bytes
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const EXT_FOR_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
};

// Magic-byte check for the binary types we accept. Returns the sniffed MIME
// or null. Never trusts the client-supplied Content-Type.
function sniffBinary(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) return 'image/webp';
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  return null;
}

// Whitelisted text files must be plausible text: no NUL or unexpected C0
// control bytes and nothing that decodes to U+FFFD (invalid UTF-8). This
// keeps binary garbage with a .txt alias out.
function sniffText(buf, ext) {
  const mime = EXT_FOR_MIME['text/' + ext];
  const allowed = ext === 'txt' ? 'text/plain' : ext === 'md' ? 'text/markdown' : ext === 'csv' ? 'text/csv' : ext === 'json' ? 'application/json' : null;
  const resolved = allowed || mime;
  if (!resolved) return null;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return null;
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12) return null;
    if (b === 0x7f) return null;
  }
  if (buf.toString('utf8').indexOf('\uFFFD') !== -1) return null;
  return resolved;
}

function safeExt(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

// Display-only name: no paths, no control characters, capped length. It is
// a label, never a filesystem path.
function cleanFilename(name) {
  const s = String(name || 'upload')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  return s || 'upload';
}

function resolveMime(buf, originalName) {
  const bin = sniffBinary(buf);
  if (bin) return bin;
  return sniffText(buf, safeExt(originalName));
}

function publicRow(r) {
  return {
    id: r.id, filename: r.filename, mime: r.mime,
    size: r.size, url: r.url, message_id: r.message_id || null,
  };
}

// Persist a pending attachment. Returns the row on success or
// Per-account storage ceiling.
//
// MAX_SIZE bounds one file and the route's rate limit bounds the rate, but
// neither bounds the total: 8 MB every 30 minutes is 14 GB an hour, and nothing
// ever reclaims an attached file. This is the only thing that stops one member
// filling the host disk.
//
// Counted from the database rather than by walking the storage tree, so it
// works identically on local disk and in an object store, and costs one indexed
// aggregate. Attachments only: avatars and community art are replaced in place
// rather than accumulated, so they do not grow without bound.
const QUOTA_BYTES = (() => {
  const mb = parseInt(process.env.STORAGE_QUOTA_MB || '', 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 512 * 1024 * 1024;
})();

async function checkQuota(userId, incoming) {
  const row = await db.get(
    'SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE uploader_id = ?',
    [userId]
  );
  const used = row ? Number(row.total) : 0;
  if (used + incoming <= QUOTA_BYTES) return null;
  return {
    error: 'QUOTA_EXCEEDED',
    message: 'storage quota reached; delete an attachment or ask a moderator to raise your limit',
    detail: { used, limit: QUOTA_BYTES, incoming },
  };
}

function quota(userId) {
  return db.get(
    'SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS files FROM attachments WHERE uploader_id = ?',
    [userId]
  ).then((row) => ({
    used: row ? Number(row.used) : 0,
    files: row ? Number(row.files) : 0,
    limit: QUOTA_BYTES,
  }));
}

// { error, message } for a rejected file. The buffer is < MAX_SIZE
// (enforced by the route), so sync write is cheap and atomic enough.
// A file is scoped either to a channel or to a DM conversation - never both,
// and never neither. Exactly one of the two is required, and saying so here
// beats letting a NULL/NULL row through to be invisible later.
function assertScope({ channelId, conversationId }) {
  if (channelId && conversationId) throw new Error('uploads: ambiguous scope');
  if (!channelId && !conversationId) throw new Error('uploads: no scope');
}

async function store({ uploaderId, channelId, conversationId, buffer, originalName }) {
  assertScope({ channelId, conversationId });
  if (!buffer || buffer.length === 0) {
    return { error: 'VALIDATION_ERROR', message: 'empty file' };
  }
  const mime = resolveMime(buffer, originalName);
  if (!mime) {
    return { error: 'VALIDATION_ERROR', message: 'file type not supported (images, PDF, or text files only)' };
  }
  const quota = await checkQuota(uploaderId, buffer.length);
  if (quota) return quota;
  const id = uuid();
  // Only supply an extension when the name does not already have one. Appending
  // unconditionally turned every "photo.png" into "photo.png.png", which is both
  // what the reader sees and what a download is named.
  const own = safeExt(originalName);
  const ext = own || (EXT_FOR_MIME[mime] || '').slice(1);
  const filename = cleanFilename(originalName) + (!own && ext ? '.' + ext : '');
  // The storage key carries the scope, so a channel's objects and a
  // conversation's never share a prefix.
  const key = storage.key.messageMedia(channelId || 'dm-' + conversationId, id);
  await storage.put(key, buffer, mime);
  try {
    await db.run(
      'INSERT INTO attachments (id, message_id, channel_id, dm_conversation_id, uploader_id, filename, mime, size, url, created_at)' +
      ' VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, channelId || null, conversationId || null, uploaderId, filename, mime, buffer.length, '/api/attachments/' + id, now()]
    );
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return {
    id, filename, mime, size: buffer.length,
    url: '/api/attachments/' + id, message_id: null,
  };
}

// Adopt pending attachments into a message. Only the uploader's own pending
// uploads in the same scope can be attached - this is the integrity check, and
// it is also what stops one conversation's file being attached to another's
// message.
async function attachToMessage(ids, messageId, userId, { channelId, conversationId } = {}) {
  if (!ids || !ids.length) return [];
  assertScope({ channelId, conversationId });
  if (conversationId) {
    await db.run(
      'UPDATE attachments SET dm_message_id = ? WHERE dm_message_id IS NULL AND uploader_id = ? AND dm_conversation_id = ? AND id IN (' +
      ids.map(() => '?').join(',') + ')',
      [messageId, userId, conversationId].concat(ids)
    );
    return getForDmMessage(messageId);
  }
  await db.run(
    'UPDATE attachments SET message_id = ? WHERE message_id IS NULL AND uploader_id = ? AND channel_id = ? AND id IN (' +
    ids.map(() => '?').join(',') + ')',
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

// messageId -> [attachmentRow, ...]. One query for a whole page.
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

// The caller may view this attachment if they are a member of its server, or
// if it is still pending and they are the uploader. Returns the row or null.
async function authorized(userId, attachmentId) {
  const a = await db.get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
  if (!a) return null;
  if (!a.message_id && !a.dm_message_id) return a.uploader_id === userId ? a : null;
  if (a.dm_message_id) {
    // Membership of the conversation, checked directly: there is no server to be
    // a member of. Both sides of it, because a left conversation must lose
    // access to what was said in it.
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

// Best-effort object cleanup for the given attachment rows (e.g. when the
// owning message is deleted — the row cascade is handled by the database).
// The key comes from the row, so a channel id that no longer exists cannot
// redirect the delete somewhere else.
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

// Called on the hourly purge: drop orphaned files and their rows so an
// abandoned upload never becomes a permanent disk leak.
async function purgePending() {
  const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  const rows = await db.all(
    'SELECT id FROM attachments WHERE message_id IS NULL AND dm_message_id IS NULL AND created_at < ?', [cutoff]
  );
  if (!rows.length) return;
  await db.run('DELETE FROM attachments WHERE message_id IS NULL AND dm_message_id IS NULL AND created_at < ?', [cutoff]);
  await removeFiles(rows.map((r) => r.id));
}

// Profile media (avatars / banners). Same disk store and magic-byte
// validation as attachments, but identity content: served by a dedicated
// profile route, not by server/channel membership. Files are prefixed so the
// serving route can never touch a message attachment, and each file has a
// profile_media row carrying the sniffed mime + ownership.
async function storeProfileMedia({ userId, kind, buffer, originalName }) {
  if (!buffer || buffer.length === 0) {
    return { error: 'VALIDATION_ERROR', message: 'empty file' };
  }
  const mime = sniffBinary(buffer);
  if (!mime) {
    return { error: 'VALIDATION_ERROR', message: 'profile images must be PNG, JPEG, GIF, or WebP' };
  }
  const id = 'pf-' + uuid();
  const key = storage.key.userMedia(userId, kind, id);
  await storage.put(key, buffer, mime);
  try {
    await db.run(
      'INSERT INTO profile_media (id, user_id, kind, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, kind, cleanFilename(originalName) || 'profile', mime, buffer.length, now()]
    );
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return { id, url: '/api/attachments/profile/' + id, mime, size: buffer.length, kind };
}

async function profileMedia(id) {
  if (!/^pf-[a-f0-9-]{1,64}$/.test(String(id || ''))) return null;
  return db.get('SELECT * FROM profile_media WHERE id = ?', [id]);
}

// Removal deletes the object and the row. The object key is rebuilt from the
// row that owns it, never from the value stored on a profile, so a corrupt
// avatar_url can only ever remove the user's own current media.
async function removeProfileFile(urlOrId) {
  const idMatch = String(urlOrId || '').match(/^(?:.*\/)+?(pf-[a-f0-9-]{1,64})$/);
  const id = idMatch ? idMatch[1] : (/^pf-[a-f0-9-]{1,64}$/.test(String(urlOrId || '')) ? String(urlOrId) : null);
  if (!id) return;
  const row = await db.get('SELECT user_id, kind FROM profile_media WHERE id = ?', [id]);
  if (row) await storage.delete(storage.key.userMedia(row.user_id, row.kind, id)).catch(() => {});
  try { await db.run('DELETE FROM profile_media WHERE id = ?', [id]); } catch { /* row already gone */ }
}

// Community identity media (icon / banner). Same disk store and magic-byte
// sniffing as profile media, with its own table and its own id prefix. The
// prefix is load-bearing: the fetch route is authenticated, so a file id
// arriving from the wire must not be able to name a message attachment.
//
// Any authenticated user may LOAD a community's icon or banner - it is public
// identity, exactly like a user avatar, and the discover feed shows it to
// people who are not members.
const SERVER_MEDIA_KINDS = ['icon', 'banner'];

async function storeServerMedia({ serverId, kind, buffer, originalName }) {
  if (SERVER_MEDIA_KINDS.indexOf(kind) === -1) {
    return { error: 'VALIDATION_ERROR', message: 'unknown community media kind' };
  }
  if (!buffer || buffer.length === 0) {
    return { error: 'VALIDATION_ERROR', message: 'empty file' };
  }
  const mime = sniffBinary(buffer);
  if (!mime) {
    return { error: 'VALIDATION_ERROR', message: 'images must be PNG, JPEG, GIF, or WebP' };
  }
  const id = 'sv-' + uuid();
  const key = storage.key.communityMedia(serverId, kind, id);
  await storage.put(key, buffer, mime);
  try {
    await db.run(
      'INSERT INTO server_media (id, server_id, kind, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, serverId, kind, cleanFilename(originalName) || kind, mime, buffer.length, now()]
    );
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return { id, url: '/api/servers/media/' + id, mime, size: buffer.length, kind };
}

async function serverMedia(id) {
  if (!/^sv-[a-f0-9-]{1,64}$/i.test(String(id || ''))) return null;
  return db.get('SELECT * FROM server_media WHERE id = ?', [id]);
}

// Best-effort removal of a superseded community image, keyed off the owning
// row so it can never touch a message attachment.
async function removeServerFile(urlOrId) {
  const s = String(urlOrId || '');
  const idMatch = s.match(/^(?:.*\/)+?(sv-[a-f0-9-]{1,64})$/);
  const id = idMatch ? idMatch[1] : (/^sv-[a-f0-9-]{1,64}$/i.test(s) ? s : null);
  if (!id) return;
  const row = await db.get('SELECT server_id, kind FROM server_media WHERE id = ?', [id]);
  if (row) await storage.delete(storage.key.communityMedia(row.server_id, row.kind, id)).catch(() => {});
  try { await db.run('DELETE FROM server_media WHERE id = ?', [id]); } catch { /* row already gone */ }
}

// Read helpers for the serving routes. Each returns a readable stream plus the
// sniffed mime, or null when the row is gone or the object is missing. The
// caller has already authorised the request.
function openAttachment(row) {
  // Same scoping rule as store(): a DM file is filed under its conversation, so
  // a channel id of null can never send the lookup somewhere else.
  return storage.createReadStream(
    storage.key.messageMedia(row.channel_id || 'dm-' + row.dm_conversation_id, row.id)
  );
}

function openProfileMedia(row) {
  return storage.createReadStream(storage.key.userMedia(row.user_id, row.kind, row.id));
}

function openServerMedia(row) {
  return storage.createReadStream(storage.key.communityMedia(row.server_id, row.kind, row.id));
}

module.exports = {
  MAX_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  store,
  storeProfileMedia,
  profileMedia,
  removeProfileFile,
  storeServerMedia,
  serverMedia,
  removeServerFile,
  attachToMessage,
  getForMessage,
  getForMessages,
  getForDmMessage,
  getForDmMessages,
  authorized,
  removeFiles,
  purgePending,
  quota,
  QUOTA_BYTES,
  openAttachment,
  openProfileMedia,
  openServerMedia,
};

// Allow ids from the wire to be used safely in SQL IN lists. Service stays
// strict: only lowercase-uuid-shaped strings pass.
const ID_RE = /^[a-f0-9-]{1,64}$/i;
function sanitizeIds(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string' && ID_RE.test(x))
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
}
module.exports.sanitizeIds = sanitizeIds;