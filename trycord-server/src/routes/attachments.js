// Attachment upload + authenticated download.
//   POST /api/channels/:channelId/attachments  (multipart field "file")
//   POST /api/dms/:id/attachments              (multipart field "file")
//   GET  /api/attachments/:id                  (member of the server or the DM)
// Uploads require membership + SEND_MESSAGES; downloads the same membership
// level as reading the message the file is attached to. Files are never
// served from the public /uploads static mount (there is none).
const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const { visibleChannel } = require('../util');
const { hasChannelPermission } = require('../services/permissions');
const memberships = require('../services/memberships');
const uploads = require('../services/uploads');
const dms = require('../services/dms');

const router = express.Router();
// Auth is applied per-route, not via router.use(auth): this router is
// mounted at /api (a prefix of every API path), so router-level auth
// would run — and bill two DB lookups — on every API request that merely
// passes through on its way to another router. The two attachment
// endpoints keep the exact same auth behavior via route-level middleware.
const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploads.MAX_SIZE, files: 1 },
});

function singleFile(req, res, next) {
  memory.single('file')(req, res, (err) => {
    if (err) {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 'VALIDATION_ERROR', 'file is too large (max 8 MB)');
      }
      return next(err);
    }
    next();
  });
}

router.post(
  '/channels/:channelId/attachments',
  auth,
  auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 30 }),
  singleFile,
  async (req, res, next) => {
    try {
      const ch = await visibleChannel(req.params.channelId, req.user.id);
      if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
      if (!(await hasChannelPermission(req.user.id, ch.server_id, ch.id, 'SEND_MESSAGES'))) {
        return fail(res, 'PERMISSION_DENIED', 'you cannot post in this server');
      }
      // Uploading is a write. Without this a timed-out member fills the host
      // disk with files they can never attach to a message.
      if (await memberships.isTimedOut(ch.server_id, req.user.id)) {
        return fail(res, 'TIMED_OUT', 'you are timed out in this server');
      }
      if (!req.file || !req.file.buffer) {
        return fail(res, 'VALIDATION_ERROR', 'send the file as a multipart field named "file"');
      }
      const out = await uploads.store({
        uploaderId: req.user.id,
        channelId: ch.id,
        buffer: req.file.buffer,
        originalName: req.file.originalname || '',
      });
      if (out.error) return fail(res, out.error, out.message);
      res.status(201).json({ attachment: out });
    } catch (e) { next(e); }
  }
);

// The same upload for a direct message. Membership of the conversation is the
// only gate - there is no channel permission to check - but the DM preference
// and the block list still apply, because being able to open the conversation is
// not the same as being allowed to put a file in it.
router.post(
  '/dms/:id/attachments',
  auth,
  auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 30 }),
  singleFile,
  async (req, res, next) => {
    try {
      const found = await dms.visibleConversation(req.params.id, req.user.id);
      if (!found) return fail(res, 'NOT_FOUND', 'conversation not found');
      if (!req.file || !req.file.buffer) {
        return fail(res, 'VALIDATION_ERROR', 'send the file as a multipart field named "file"');
      }
      const out = await uploads.store({
        uploaderId: req.user.id,
        conversationId: found.conv.id,
        buffer: req.file.buffer,
        originalName: req.file.originalname || '',
      });
      if (out.error) return fail(res, out.error, out.message);
      res.status(201).json({ attachment: out });
    } catch (e) { next(e); }
  }
);

// Current usage for the caller. The client needs this to show a meter and to
// explain a 413 before the user has burned an upload on finding out.
router.get('/attachments/quota', auth, async (req, res, next) => {  try {
    res.json(await uploads.quota(req.user.id));
  } catch (e) { next(e); }
});

router.get('/attachments/:id', auth, async (req, res, next) => {
  try {
    const a = await uploads.authorized(req.user.id, req.params.id);
    if (!a) return fail(res, 'NOT_FOUND', 'attachment not found');
    const disp = encodeURIComponent(a.filename).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + disp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = uploads.openAttachment(a);
    stream.on('error', () => { if (!res.headersSent) fail(res, 'NOT_FOUND', 'attachment not found'); });
    stream.pipe(res);
  } catch (e) { next(e); }
});

// Profile media (avatars / banners) are public identity by design — any
// authenticated user may load them. Class isolation is now a property of the
// object key, which is rebuilt from the owning row: a message attachment id
// cannot resolve to a profile object.
router.get('/attachments/profile/:id', auth, async (req, res, next) => {
  try {
    const row = await uploads.profileMedia(req.params.id);
    if (!row) return fail(res, 'NOT_FOUND', 'attachment not found');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = uploads.openProfileMedia(row);
    stream.on('error', () => { if (!res.headersSent) fail(res, 'NOT_FOUND', 'attachment not found'); });
    stream.pipe(res);
  } catch (e) { next(e); }
});

module.exports = router;