// Attachments: upload and authenticated download.
//
// A file is served with nosniff and only as its detected type when that type is in the
// inline set, so an .html or an .svg attachment is a download rather than a script
// running on this origin with the reader's session.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const { singleFile } = require('../../middleware/upload');
const media = require('../../services/media');
const db = require('../../db');

// Uploads are mounted at the api root, so authentication is applied per route rather than
// with router.use: a router-level guard would claim every /api/* path and turn an unknown
// route into a 401 instead of the 404 it should be.
const uploads = express.Router();

// Reading an attachment needs the same membership as reading the message it was attached
// to, so a file is never more public than the conversation it belongs to.
async function senderOf(channelId, userId) {
  const ch = await db.get(
    `SELECT c.id, c.server_id FROM channels c
       JOIN server_members m ON m.server_id = c.server_id AND m.user_id = ?
      WHERE c.id = ?`,
    [userId, channelId]
  );
  if (!ch) return null;

  const permissions = require('../../services/permissions');
  const perms = await permissions.serverPermissions(userId, ch.server_id);
  if (!permissions.can(perms, 'SEND_MESSAGES')) {
    return { denied: { code: 'PERMISSION_DENIED', message: 'you cannot post in this community' } };
  }
  return ch;
}

async function receiveFile(req, res, scope, store) {
  const permitted = await senderOf(scope.id, req.user.id);
  if (!permitted) return fail(res, 'NOT_A_MEMBER', 'conversation not found or not a member');
  if (permitted.denied) return fail(res, permitted.denied.code, permitted.denied.message);

  const moderation = require('../../services/moderation');
  if (await moderation.isTimedOut(permitted.server_id, req.user.id)) {
    return fail(res, 'TIMED_OUT', 'you are timed out in this community');
  }
  if (!req.file || !req.file.buffer) {
    return fail(res, 'VALIDATION_ERROR', 'send the file as a multipart field named "file"');
  }

  const out = await store({
    uploaderId: req.user.id,
    [scope.key]: scope.id,
    buffer: req.file.buffer,
    originalName: req.file.originalname || '',
  });
  if (out.error) return fail(res, out.error, out.message);
  res.status(201).json({ attachment: out });
}

uploads.post('/channels/:channelId/attachments',
  authenticate, requireVerified, limit({ windowMs: 60000, max: 30 }), singleFile,
  wrap(async (req, res) => receiveFile(req, res, { id: req.params.channelId, key: 'channelId' }, media.store))
);

async function dmMember(conversationId, userId) {
  return db.get(
    'SELECT 1 FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
}

uploads.post('/dms/:conversationId/attachments',
  authenticate, requireVerified, limit({ windowMs: 60000, max: 30 }), singleFile,
  wrap(async (req, res) => {
    if (!(await dmMember(req.params.conversationId, req.user.id))) {
      return fail(res, 'NOT_A_MEMBER', 'conversation not found or not a member');
    }
    if (!req.file || !req.file.buffer) {
      return fail(res, 'VALIDATION_ERROR', 'send the file as a multipart field named "file"');
    }
    const out = await media.storeForConversation({
      uploaderId: req.user.id,
      conversationId: req.params.conversationId,
      buffer: req.file.buffer,
      originalName: req.file.originalname || '',
    });
    if (out.error) return fail(res, out.error, out.message);
    res.status(201).json({ attachment: out });
  })
);

// Downloads. An attachment is addressed by its own id, which is the one thing the client
// still holds once the message has scrolled away.
const downloads = express.Router();
downloads.use(authenticate);

async function mayReadAttachment(row, userId) {
  if (row.channel_id) {
    const ch = await db.get(
      `SELECT c.server_id FROM channels c
         JOIN server_members m ON m.server_id = c.server_id AND m.user_id = ?
        WHERE c.id = ?`,
      [userId, row.channel_id]
    );
    if (!ch) return false;
    const permissions = require('../../services/permissions');
    const perms = await permissions.serverPermissions(userId, ch.server_id);
    return permissions.can(perms, 'READ_MESSAGES') || permissions.can(perms, 'SEND_MESSAGES');
  }
  if (row.dm_conversation_id) {
    return !!(await dmMember(row.dm_conversation_id, userId));
  }
  return false;
}

function send(res, row, bytes) {
  const type = media.isInlineMime(row.mime) ? row.mime : 'application/octet-stream';
  media.sendHeaders(res);
  res.type(type);
  res.setHeader('Content-Disposition', 'inline');
  res.send(bytes);
}

downloads.get('/:id', wrap(async (req, res) => {
  const row = await media.byId(req.params.id);
  if (!row) return fail(res, 'NOT_FOUND', 'attachment not found');
  if (!(await mayReadAttachment(row, req.user.id))) {
    return fail(res, 'NOT_A_MEMBER', 'you are not a member of this conversation');
  }
  send(res, row, await media.read(row));
}));

downloads.get('/profile/:id', wrap(async (req, res) => {
  const row = await media.profileMedia(req.params.id);
  if (!row) return fail(res, 'NOT_FOUND', 'image not found');
  send(res, row, await media.readProfile(row));
}));

module.exports = { uploads, downloads };
