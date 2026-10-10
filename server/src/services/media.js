// Stored media: attachments, avatars, community icons and banners.
//
// One driver interface behind a key builder, so switching a self-hoster from local disk
// to S3 is a configuration change rather than a rewrite. The type of a file is detected
// from its bytes and never from what the client claimed.
//
// The policy that makes "accept anything" safe: a file we cannot place is stored as
// application/octet-stream and served as a download. The risk was never that a file
// exists; it is that a browser is asked to interpret it, so interpretation is decided
// here, on the way out.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const { now, uuid, cleanFilename } = require('../util');

const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// The types a browser may be allowed to interpret on this origin. Everything else goes
// out as a download no matter what it claims to be.
const INLINE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
]);

const UNKNOWN_MIME = 'application/octet-stream';

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const driver = require('./storage').selectDriver();

function sniffBinary(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  return null;
}

// Whitelisted text has to look like text: no NUL, no unexpected C0 bytes, and nothing
// that decodes to U+FFFD.
function sniffText(buf, ext) {
  const wanted = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json' }[ext];
  if (!wanted) return null;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return null;
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12) return null;
    if (b === 0x7f) return null;
  }
  if (buf.toString('utf8').indexOf('\uFFFD') !== -1) return null;
  return wanted;
}

function safeExt(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

function detectMime(buf, originalName) {
  return sniffBinary(buf) || sniffText(buf, safeExt(originalName)) || UNKNOWN_MIME;
}

const isInlineMime = (mime) => INLINE_MIMES.has(String(mime || '').toLowerCase());

// The headers that make the inline set above real: without nosniff a browser may run
// bytes the server meant as data, which would make the allowlist decorative.
function sendHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
}

// Only uuid-shaped ids reach SQL, so an id from the wire cannot carry anything else.
const ID_RE = /^[a-f0-9-]{1,64}$/i;
function sanitizeIds(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
}

async function quotaUsed(userId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE uploader_id = ?
       AND created_at > ?`,
    [userId, new Date(Date.now() - 24 * 3600 * 1000).toISOString()]
  );
  return Number(row.total || 0);
}

// Per-user, per-day. Uploading is a write, so an account with no messages still consumes
// host storage, and a rate limit on the route is not a limit on bytes.
const QUOTA_BYTES = 200 * 1024 * 1024;

async function checkQuota(userId, size) {
  if (await quotaUsed(userId) + size > QUOTA_BYTES) {
    return { error: 'QUOTA_EXCEEDED', message: 'you have uploaded a lot in the last day — try again later' };
  }
  return null;
}

async function store({ uploaderId, channelId, buffer, originalName }) {
  if (!buffer || buffer.length === 0) {
    return { error: 'VALIDATION_ERROR', message: 'the file is empty' };
  }
  const mime = detectMime(buffer, originalName);
  const over = await checkQuota(uploaderId, buffer.length);
  if (over) return over;

  const id = uuid();
  const filename = cleanFilename(originalName);
  await driver.put(`channel/${channelId}/attachment/${id}`, buffer, mime);
  const url = '/api/attachments/' + id;

  await db.run(
    `INSERT INTO attachments (id, channel_id, uploader_id, filename, mime, size, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, channelId, uploaderId, filename, mime, buffer.length, url, now()]
  );

  return { id, filename, mime, size: buffer.length, url, message_id: null };
}

async function storeForConversation({ uploaderId, conversationId, buffer, originalName }) {
  if (!buffer || buffer.length === 0) {
    return { error: 'VALIDATION_ERROR', message: 'the file is empty' };
  }
  const mime = detectMime(buffer, originalName);
  const over = await checkQuota(uploaderId, buffer.length);
  if (over) return over;

  const id = uuid();
  const filename = cleanFilename(originalName);
  await driver.put(`dm-${conversationId}/attachment/${id}`, buffer, mime);
  const url = '/api/attachments/' + id;

  await db.run(
    `INSERT INTO attachments (id, dm_conversation_id, uploader_id, filename, mime, size, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, conversationId, uploaderId, filename, mime, buffer.length, url, now()]
  );

  return { id, filename, mime, size: buffer.length, url, message_id: null };
}

async function byId(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  return db.get('SELECT * FROM attachments WHERE id = ?', [id]);
}

// Reads the stored bytes for a row. The key is rebuilt from the row's own columns so a
// corrupt url column cannot name somebody else's file.
async function read(row) {
  const scope = row.channel_id
    ? `channel/${row.channel_id}/attachment/${row.id}`
    : `dm-${row.dm_conversation_id}/attachment/${row.id}`;
  return driver.get(scope);
}

// Identity media is keyed by the user and the kind, not by a conversation.
async function readProfile(row) {
  return driver.get(`user/${row.user_id}/${row.kind}/${row.id}`);
}

async function forMessages(messageIds) {
  const safe = sanitizeIds(messageIds);
  if (!safe.length) return {};
  const marks = safe.map((id) => `'${id}'`).join(',');
  const rows = await db.all(`SELECT * FROM attachments WHERE message_id IN (${marks})`);
  const out = {};
  for (const r of rows) {
    (out[r.message_id] = out[r.message_id] || []).push({
      id: r.id, filename: r.filename, mime: r.mime, size: r.size, url: r.url,
    });
  }
  return out;
}

async function attachToMessage(messageId, attachmentIds) {
  const safe = sanitizeIds(attachmentIds);
  if (!safe.length) return;
  const marks = safe.map((id) => `'${id}'`).join(',');
  await db.run(`UPDATE attachments SET message_id = ? WHERE id IN (${marks})`, [messageId]);
}

// Identity media. The id prefix is load-bearing: the fetch routes are authenticated, so
// a file id from the wire must not be able to name a message attachment.
const PROFILE_ID = /^pf-[a-f0-9-]{1,64}$/;
const COMMUNITY_ID = /^sv-[a-f0-9-]{1,64}$/i;

async function storeProfile(userId, kind, buffer, originalName) {
  if (!buffer || buffer.length === 0) return { error: 'VALIDATION_ERROR', message: 'the file is empty' };
  const mime = sniffBinary(buffer);
  if (!mime || IMAGE_MIMES.indexOf(mime) === -1) {
    return { error: 'VALIDATION_ERROR', message: 'profile images must be PNG, JPEG, GIF or WebP' };
  }
  const over = await checkQuota(userId, buffer.length);
  if (over) return over;

  const id = 'pf-' + uuid();
  await driver.put(`user/${userId}/${kind}/${id}`, buffer, mime);
  const url = '/api/attachments/profile/' + id;

  await db.run(
    `INSERT INTO profile_media (id, user_id, kind, filename, mime, size, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, kind, cleanFilename(originalName), mime, buffer.length, url, now()]
  );
  return { id, url, mime, size: buffer.length, kind };
}

async function storeCommunity(serverId, kind, buffer, originalName, viewerId) {
  if (['icon', 'banner'].indexOf(kind) === -1) {
    return { error: 'VALIDATION_ERROR', message: 'unknown community media kind' };
  }
  const servers = require('./servers');
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_SERVER')) {
    return { error: 'PERMISSION_DENIED', message: 'you cannot change this community\'s appearance' };
  }
  if (!buffer || buffer.length === 0) return { error: 'VALIDATION_ERROR', message: 'the file is empty' };
  const mime = sniffBinary(buffer);
  if (!mime || IMAGE_MIMES.indexOf(mime) === -1) {
    return { error: 'VALIDATION_ERROR', message: 'community images must be PNG, JPEG, GIF or WebP' };
  }

  const id = 'sv-' + uuid();
  await driver.put(`community/${serverId}/${kind}/${id}`, buffer, mime);
  const url = '/api/servers/media/' + id;

  await db.run(
    `INSERT INTO server_media (id, server_id, kind, filename, mime, size, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, serverId, kind, cleanFilename(originalName), mime, buffer.length, url, now()]
  );
  return { id, url, mime, size: buffer.length, kind };
}

async function profileMedia(id) {
  if (!PROFILE_ID.test(String(id || ''))) return null;
  return db.get('SELECT * FROM profile_media WHERE id = ?', [id]);
}

async function serverMedia(id) {
  if (!COMMUNITY_ID.test(String(id || ''))) return null;
  return db.get('SELECT * FROM server_media WHERE id = ?', [id]);
}

// Removal rebuilds the object key from the row that owns it, never from a value stored
// on a profile, so a corrupt avatar_url can only ever remove that user's own media.
async function removeProfile(userId, kind) {
  const row = await db.get('SELECT id FROM profile_media WHERE user_id = ? AND kind = ?', [userId, kind]);
  if (!row) return { ok: true };
  await driver.remove(`user/${userId}/${kind}/${row.id}`).catch(() => {});
  await db.run('DELETE FROM profile_media WHERE id = ?', [row.id]);
  await db.run('UPDATE users SET avatar_url = NULL WHERE id = ? AND avatar_url = ?', [userId, '/api/attachments/profile/' + row.id]);
  return { ok: true };
}

async function removeCommunity(serverId, kind, viewerId) {
  const servers = require('./servers');
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_SERVER')) {
    return { error: 'PERMISSION_DENIED', message: 'you cannot change this community\'s appearance' };
  }
  const row = await db.get('SELECT id FROM server_media WHERE server_id = ? AND kind = ?', [serverId, kind]);
  if (!row) return { ok: true };
  await driver.remove(`community/${serverId}/${kind}/${row.id}`).catch(() => {});
  await db.run('DELETE FROM server_media WHERE id = ?', [row.id]);
  return { ok: true };
}

// Pending uploads with no message attached are garbage: the host should not keep them.
async function purgePending() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await db.all(
    'SELECT id, channel_id, dm_conversation_id AS conversation_id FROM attachments WHERE message_id IS NULL AND created_at < ?',
    [cutoff]
  );
  for (const r of rows) {
    const scope = r.channel_id
      ? `channel/${r.channel_id}/attachment/${r.id}`
      : `dm-${r.dm_conversation_id}/attachment/${r.id}`;
    await driver.remove(scope).catch(() => {});
  }
  await db.run('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?', [cutoff]);
  return rows.length;
}

module.exports = {
  store, storeForConversation, byId, forMessages, attachToMessage,
  storeProfile, storeCommunity, profileMedia, serverMedia,
  removeProfile, removeCommunity, purgePending,
  read, readProfile,
  detectMime, isInlineMime, sendHeaders, sanitizeIds,
  MAX_ATTACHMENTS_PER_MESSAGE, INLINE_MIMES, IMAGE_MIMES,
};
