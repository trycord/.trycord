// Invites by code: preview before joining, and the join itself.
//
// The management half lives under servers.js, because creating and revoking an invite is
// a MANAGE_INVITES act inside a community.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const servers = require('../../services/servers');

const router = express.Router();
router.use(authenticate);

// A preview shows only what a stranger needs to decide, never settings or members.
router.get('/:code/preview', wrap(async (req, res) => {
  const preview = await servers.previewInvite(req.params.code);
  if (!preview) return fail(res, 'INVITE_INVALID', 'invite not found');
  res.json(preview);
}));

router.post('/:code/join', requireVerified, limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.json(await servers.joinByCode(req.user.id, req.params.code));
}));

module.exports = router;
