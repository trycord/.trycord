// Attachment pipeline. Files live on disk keyed by their UUID (never the
// uploader's filename), are validated by magic bytes, bounded in size, and
// served through an authenticated route with a membership check — never the
// static file server. `message_id` is null while an upload is "pending"
// (uploaded but not yet attached to a message); pending files older than
// PENDING_TTL_MS are purged.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { now, uuid, isMember } = require('../util');

const MAX_SIZE = 8 * 1024 * 1024; // bytes
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function uploadsDir() {
  return path.join(__dirname, '..', '..', 'uploads');
}

function filePath(id) {
  return path.join(uploadsDir(), id);
}

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
// { error, message } for a rejected file. The buffer is < MAX_SIZE
// (enforced by the route), so sync write is cheap and atomic enough.
async function store({ uploaderId, channelId, buffer, originalName }) {
  if (!buffer || buffer.length === 0) {
    return { error: 'VALIDATION_ERROR', message: 'empty file' };
  }
  const mime = resolveMime(buffer, originalName);
  if (!mime) {
    return { error: 'VALIDATION_ERROR', message: 'file type not supported (images, PDF, or text files only)' };
  }
  const id = uuid();
  const ext = safeExt(originalName) || (EXT_FOR_MIME[mime] || '').slice(1);
  const filename = cleanFilename(originalName) + (ext ? '.' + ext : '');
  fs.writeFileSync(filePath(id), buffer);
  try {
    await db.run(
      'INSERT INTO attachments (id, message_id, channel_id, uploader_id, filename, mime, size, url, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)',
      [id, channelId, uploaderId, filename, mime, buffer.length, '/api/attachments/' + id, now()]
    );
  } catch (e) {
    try { fs.unlinkSync(filePath(id)); } catch { /* nothing on disk to clean */ }
    throw e;
  }
  return {
    id, filename, mime, size: buffer.length,
    url: '/api/attachments/' + id, message_id: null,
  };
}

// Adopt pending attachments into a message. Only the uploader's own pending
// uploads in the same channel can be attached — this is the integrity check.
async function attachToMessage(ids, messageId, userId, channelId) {
  if (!ids || !ids.length) return [];
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

// The caller may view this attachment if they are a member of its server, or
// if it is still pending and they are the uploader. Returns the row or null.
async function authorized(userId, attachmentId) {
  const a = await db.get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
  if (!a) return null;
  if (!a.message_id) return a.uploader_id === userId ? a : null;
  const ch = await db.get('SELECT server_id FROM channels WHERE id = ?', [a.channel_id]);
  if (!ch) return null;
  if (!(await isMember(userId, ch.server_id))) return null;
  return a;
}

// Best-effort disk cleanup for the given attachment rows (e.g. when the
// owning message is deleted — the row cascade is handled by the database).
function removeFiles(ids) {
  (ids || []).forEach((id) => {
    try { fs.unlinkSync(filePath(id)); } catch { /* already gone */ }
  });
}

// Called on the hourly purge: drop orphaned files and their rows so an
// abandoned upload never becomes a permanent disk leak.
async function purgePending() {
  const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  const rows = await db.all('SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?', [cutoff]);
  if (!rows.length) return;
  await db.run('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?', [cutoff]);
  removeFiles(rows.map((r) => r.id));
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
  fs.writeFileSync(filePath(id), buffer);
  try {
    await db.run(
      'INSERT INTO profile_media (id, user_id, kind, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, kind, cleanFilename(originalName) || 'profile', mime, buffer.length, now()]
    );
  } catch (e) {
    try { fs.unlinkSync(filePath(id)); } catch { /* nothing to clean */ }
    throw e;
  }
  return { id, url: '/api/attachments/profile/' + id, mime, size: buffer.length, kind };
}

async function profileMedia(id) {
  if (!/^pf-[a-f0-9-]{1,64}$/.test(String(id || ''))) return null;
  return db.get('SELECT * FROM profile_media WHERE id = ?', [id]);
}

// Best-effort removal of a previously set profile image: deletes the disk
// file and its row. Accepts only profile-prefixed paths so a malformed
// profile row can never delete a message attachment.
async function removeProfileFile(urlOrId) {
  const idMatch = String(urlOrId || '').match(/^(?:.*\/)+?(pf-[a-f0-9-]{1,64})$/);
  const id = idMatch ? idMatch[1] : (/^pf-[a-f0-9-]{1,64}$/.test(String(urlOrId || '')) ? String(urlOrId) : null);
  if (!id) return;
  try { fs.unlinkSync(filePath(id)); } catch { /* already gone */ }
  try { await db.run('DELETE FROM profile_media WHERE id = ?', [id]); } catch { /* row already gone */ }
}

function ensureDir() {
  fs.mkdirSync(uploadsDir(), { recursive: true });
}
ensureDir();

module.exports = {
  MAX_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  filePath,
  store,
  storeProfileMedia,
  profileMedia,
  removeProfileFile,
  attachToMessage,
  getForMessage,
  getForMessages,
  authorized,
  removeFiles,
  purgePending,
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