// The emojis a community gives a name to.
//
//   GET    /api/servers/:serverId/emojis           a member reads the list, because
//                                                  rendering `:name:` in a message is
//                                                  what the list is for;
//   POST   /api/servers/:serverId/emojis           a manager uploads a picture and a
//                                                  name (multipart field "file", the
//                                                  name in the "name" field);
//   DELETE /api/servers/:serverId/emojis/:emojiId  a manager takes one away.
//
// Reading is a member's question and managing is a settings question, so the
// gates are requireMember and requirePerm('MANAGE_SERVER') — the same split
// the community memory and the invites make. The image itself is served by the
// existing /api/servers/media/:id, which every authenticated user can load,
// exactly as an icon or a banner is.

const express = require('express');
const auth = require('../middleware/auth');
const { singleFile } = require('../middleware/upload');
const rateLimit = require('../middleware/ratelimit');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const emojis = require('../services/emojis');

const router = express.Router({ mergeParams: true });
router.use(auth, rateLimit({ windowMs: 60000, max: 120 }), resolveServer, requireMember);

// GET /api/servers/:serverId/emojis — the community's emojis, oldest first.
router.get('/', async (req, res, next) => {
  try {
    res.json(await emojis.list(req.server.id));
  } catch (e) { next(e); }
});

// POST /api/servers/:serverId/emojis — name a picture. The multipart ceiling
// is the live upload setting, and the emoji's own 256 KB cap is the service's
// to enforce, so an oversized picture is refused with the reason named.
router.post('/', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20, key: 'emoji-create' }),
  requirePerm('MANAGE_SERVER'), singleFile, async (req, res, next) => {
    try {
      if (!req.file) return fail(res, 'VALIDATION_ERROR', 'a picture is required');
      const created = await emojis.create({
        serverId: req.server.id,
        creatorId: req.user.id,
        name: (req.body || {}).name,
        buffer: req.file.buffer,
        originalName: req.file.originalname,
      });
      res.status(201).json(created);
    } catch (e) { serviceError(res, e); }
  });

// DELETE /api/servers/:serverId/emojis/:emojiId — take a name away. The row
// and the picture it points at both go.
router.delete('/:emojiId', auth.requireVerified, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const removed = await emojis.remove(req.server.id, req.params.emojiId);
    if (!removed) return fail(res, 'NOT_FOUND', 'emoji not found');
    res.json({ ok: true, id: removed.id });
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
