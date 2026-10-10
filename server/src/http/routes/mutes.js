// Muted channels, which is the same question the notifications route answers from the
// other side. Kept as its own prefix because the client calls it as /api/mutes.

const express = require('express');
const { wrap } = require('../errors');
const { authenticate, requireVerified } = require('../../middleware/auth');
const notifications = require('../../services/notifications');

const router = express.Router();
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  res.json({ channels: await notifications.mutedChannels(req.user.id) });
}));

router.put('/channels/:channelId', requireVerified, wrap(async (req, res) => {
  res.json(await notifications.setChannelPref(req.user.id, req.params.channelId, req.body && req.body.muted));
}));

module.exports = router;
