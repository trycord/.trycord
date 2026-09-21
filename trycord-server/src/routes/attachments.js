// Attachment upload + authenticated download.
//   POST /api/channels/:channelId/attachments  (multipart field "file")
//   GET  /api/attachments/:id                  (member of the server only)
// Uploads require membership + SEND_MESSAGES; downloads the same membership
// level as reading the message the file is attached to. Files are never
// served from the public /uploads static mount (there is none).
const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const { visibleChannel } = require('../util');
const { hasPermission } = require('../services/permissions');
const uploads = require('../services/uploads');

const router = express.Router();
router.use(auth);

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
  rateLimit({ windowMs: 60000, max: 30 }),
  singleFile,
  async (req, res, next) => {
    try {
      const ch = await visibleChannel(req.params.channelId, req.user.id);
      if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
      if (!(await hasPermission(req.user.id, ch.server_id, 'SEND_MESSAGES'))) {
        return fail(res, 'PERMISSION_DENIED', 'you cannot post in this server');
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

router.get('/attachments/:id', async (req, res, next) => {
  try {
    const a = await uploads.authorized(req.user.id, req.params.id);
    if (!a) return fail(res, 'NOT_FOUND', 'attachment not found');
    const disp = encodeURIComponent(a.filename).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + disp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(uploads.filePath(a.id), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) return fail(res, 'NOT_FOUND', 'attachment not found');
    });
  } catch (e) { next(e); }
});

module.exports = router;