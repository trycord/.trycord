// Identity media: user avatars and banners, community icons and banners.
//
// These are four features that are the same feature. Same storage, same magic-byte
// check, same shape of row, same read route, same removal rule - differing only in which
// table, which key builder, and which id prefix.
//
// They are here together rather than in separate files because they used to be separate
// files, and reading them side by side is the only way to notice that four hand-written
// near-copies of one routine is a maintenance cost and not a design. If they ever diverge
// for a reason, split this file then, with the difference stated - not before.

const db = require('../../db');
const storage = require('../storage');
const { now, uuid } = require('../../util');
const { sniffBinary, cleanFilename, IMAGE_MIMES } = require('./detect');

const COMMUNITY_MEDIA_KINDS = ['icon', 'banner'];

// Both id prefixes are load-bearing. The fetch routes are authenticated, so a file id
// arriving from the wire must not be able to name a message attachment - and the regex
// that accepts an id is the thing that enforces it.
const PROFILE_ID = /^pf-[a-f0-9-]{1,64}$/;
const COMMUNITY_ID = /^sv-[a-f0-9-]{1,64}$/i;

function sniffImage(buffer, message) {
  if (!buffer || buffer.length === 0) return { error: 'VALIDATION_ERROR', message: 'empty file' };
  const mime = sniffBinary(buffer);
  if (!mime || IMAGE_MIMES.indexOf(mime) === -1) {
    return { error: 'VALIDATION_ERROR', message };
  }
  return { mime };
}

// --- user profile media ----------------------------------------------------

async function storeProfileMedia({ userId, kind, buffer, originalName }) {
  const sniffed = sniffImage(buffer, 'profile images must be PNG, JPEG, GIF, or WebP');
  if (sniffed.error) return sniffed;
  const id = 'pf-' + uuid();
  const key = storage.key.userMedia(userId, kind, id);
  await storage.put(key, buffer, sniffed.mime);
  try {
    await db.run(
      'INSERT INTO profile_media (id, user_id, kind, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, kind, cleanFilename(originalName) || 'profile', sniffed.mime, buffer.length, now()]
    );
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return { id, url: '/api/attachments/profile/' + id, mime: sniffed.mime, size: buffer.length, kind };
}

async function profileMedia(id) {
  if (!PROFILE_ID.test(String(id || ''))) return null;
  return db.get('SELECT * FROM profile_media WHERE id = ?', [id]);
}

// Removal deletes the object and the row. The object key is rebuilt from the row that
// owns it, never from the value stored on a profile, so a corrupt avatar_url can only
// ever remove that user's own current media.
async function removeProfileFile(urlOrId) {
  const idMatch = String(urlOrId || '').match(/^(?:.*\/)+?(pf-[a-f0-9-]{1,64})$/);
  const id = idMatch ? idMatch[1] : (PROFILE_ID.test(String(urlOrId || '')) ? String(urlOrId) : null);
  if (!id) return;
  const row = await db.get('SELECT user_id, kind FROM profile_media WHERE id = ?', [id]);
  if (row) await storage.delete(storage.key.userMedia(row.user_id, row.kind, id)).catch(() => {});
  try { await db.run('DELETE FROM profile_media WHERE id = ?', [id]); } catch { /* row already gone */ }
}

function openProfileMedia(row) {
  return storage.createReadStream(storage.key.userMedia(row.user_id, row.kind, row.id));
}

// --- community identity media ----------------------------------------------
//
// Any authenticated user may LOAD a community's icon or banner. It is public identity,
// exactly like a user avatar, and the discover feed shows it to people who are not
// members. Writing one is a separate question, answered by the route.

async function storeServerMedia({ serverId, kind, buffer, originalName }) {
  if (COMMUNITY_MEDIA_KINDS.indexOf(kind) === -1) {
    return { error: 'VALIDATION_ERROR', message: 'unknown community media kind' };
  }
  const sniffed = sniffImage(buffer, 'images must be PNG, JPEG, GIF, or WebP');
  if (sniffed.error) return sniffed;
  const id = 'sv-' + uuid();
  const key = storage.key.communityMedia(serverId, kind, id);
  await storage.put(key, buffer, sniffed.mime);
  try {
    await db.run(
      'INSERT INTO server_media (id, server_id, kind, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, serverId, kind, cleanFilename(originalName) || kind, sniffed.mime, buffer.length, now()]
    );
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return { id, url: '/api/servers/media/' + id, mime: sniffed.mime, size: buffer.length, kind };
}

async function serverMedia(id) {
  if (!COMMUNITY_ID.test(String(id || ''))) return null;
  return db.get('SELECT * FROM server_media WHERE id = ?', [id]);
}

async function removeServerFile(urlOrId) {
  const s = String(urlOrId || '');
  const idMatch = s.match(/^(?:.*\/)+?(sv-[a-f0-9-]{1,64})$/);
  const id = idMatch ? idMatch[1] : (COMMUNITY_ID.test(s) ? s : null);
  if (!id) return;
  const row = await db.get('SELECT server_id, kind FROM server_media WHERE id = ?', [id]);
  if (row) await storage.delete(storage.key.communityMedia(row.server_id, row.kind, id)).catch(() => {});
  try { await db.run('DELETE FROM server_media WHERE id = ?', [id]); } catch { /* row already gone */ }
}

function openServerMedia(row) {
  return storage.createReadStream(storage.key.communityMedia(row.server_id, row.kind, row.id));
}

module.exports = {
  storeProfileMedia,
  profileMedia,
  removeProfileFile,
  openProfileMedia,
  storeServerMedia,
  serverMedia,
  removeServerFile,
  openServerMedia,
};
