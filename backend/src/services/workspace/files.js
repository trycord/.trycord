// Files: the community's own store, on the workspace.
//
// A workspace file is storage the community keeps — a document's source
// asset, a picture the pages refer to, an archive somebody left for the
// others — rather than a file a message carries. It shares the upload
// machinery with message attachments (the type is read from the bytes, the
// quota is the uploader's, the name is cleaned) but it keeps its own table:
// a message attachment's integrity rules — pending until adopted, swept when
// orphaned — are the wrong rules for storage the community owns outright.
//
// Access: every member of the community may list and download. Uploading is
// a member write, checked by the route (SEND_MESSAGES, and the timeout
// check); removing is the uploader's or a moderator's, also checked by the
// route. Nothing here grants access on its own.
const db = require('../../db');
const { now, uuid, isMember } = require('../../util');
const detect = require('../uploads/detect');
const quota = require('../uploads/quota');
const storage = require('../storage');
const settings = require('../settings');

// The object key is rebuilt from the row everywhere, the way the message
// attachments do it: a deleted community's id cannot be walked into another
// scope's objects, because the row is what names the bytes.
function key(serverId, fileId) {
  return storage.key.communityMedia(serverId, 'workspace', fileId);
}

function shape(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    url: '/api/servers/' + row.server_id + '/files/' + row.id + '/download',
  };
}

async function list(serverId) {
  const rows = await db.all(
    'SELECT * FROM workspace_files WHERE server_id = ? ORDER BY created_at DESC, id DESC',
    [serverId]
  );
  return rows.map(shape);
}

async function get(serverId, fileId) {
  const row = await db.get('SELECT * FROM workspace_files WHERE id = ? AND server_id = ?', [fileId, serverId]);
  return row ? shape(row) : null;
}

async function store(serverId, uploaderId, file) {
  if (!file || !file.buffer || !file.buffer.length) {
    return { error: 'VALIDATION_ERROR', message: 'send the file as a multipart field named "file"' };
  }
  const mime = detect.detectMime(file.buffer, file.originalname || '');

  // The same gate message attachments pass: what this instance accepts, and
  // the type is the one the bytes say, not the one the client claimed.
  const allowed = settings.isLoaded() ? settings.read('content.allowedUploadTypes', []) : [];
  if (Array.isArray(allowed) && allowed.length) {
    const list = allowed.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (list.length && !list.includes(String(mime).toLowerCase())) {
      return { error: 'VALIDATION_ERROR', message: 'This instance does not accept ' + mime + ' files.' };
    }
  }

  // Storage is charged to the uploader's own quota, so a member cannot fill
  // the host's disk through the workspace any more than through a channel.
  const over = await quota.check(uploaderId, file.buffer.length);
  if (over) return over;

  const id = uuid();
  const name = detect.cleanFilename(file.originalname || '') || 'file';
  await storage.put(key(serverId, id), file.buffer, mime);
  try {
    const at = now();
    await db.run(
      'INSERT INTO workspace_files (id, server_id, name, mime, size, uploaded_by, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, serverId, name, mime, file.buffer.length, uploaderId, at]
    );
    return shape({ id, server_id: serverId, name, mime, size: file.buffer.length, uploaded_by: uploaderId, created_at: at });
  } catch (e) {
    // An object with no row is an object nobody can ever delete. Undo the
    // write rather than leaving it for a sweep to find.
    await storage.delete(key(serverId, id)).catch(() => {});
    throw e;
  }
}

// The serving rule, and the only path to the bytes: a member of the community
// the row names. The row is looked up WITH the resolved community's id, so a
// file id sent to another community's route is simply not found.
async function authorized(userId, serverId, fileId) {
  const row = await db.get('SELECT * FROM workspace_files WHERE id = ? AND server_id = ?', [fileId, serverId]);
  if (!row) return null;
  if (!(await isMember(userId, serverId))) return null;
  return row;
}

async function remove(serverId, fileId) {
  const row = await db.get('SELECT id FROM workspace_files WHERE id = ? AND server_id = ?', [fileId, serverId]);
  if (!row) return false;
  await db.run('DELETE FROM workspace_files WHERE id = ?', [fileId]);
  await storage.delete(key(serverId, fileId)).catch(() => {});
  return true;
}

// Read helper for the serving route, on the same shape as the attachments'
// open(): the stream, not the bytes, so a large file is never held whole.
function open(row) {
  return storage.createReadStream(key(row.server_id, row.id));
}

module.exports = { list, get, store, authorized, remove, open };
