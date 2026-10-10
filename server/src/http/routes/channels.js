// Channels, mounted under the community they belong to. Express merges the params, so
// :serverId is available from the mount path.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const channels = require('../../services/channels');

const router = express.Router({ mergeParams: true });
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  res.json(await channels.list(req.params.serverId, req.user.id));
}));

router.post('/', requireVerified, wrap(async (req, res) => {
  res.status(201).json(await channels.create(req.params.serverId, req.user.id, req.body || {}));
}));

router.get('/:channelId/overrides', wrap(async (req, res) => {
  res.json(await channels.overrides(req.params.channelId, req.user.id));
}));

router.put('/:channelId/overrides', requireVerified, wrap(async (req, res) => {
  res.json(await channels.setOverrides(req.params.serverId, req.params.channelId, req.user.id, req.body || {}));
}));

router.patch('/:channelId', requireVerified, wrap(async (req, res) => {
  res.json(await channels.update(req.params.serverId, req.params.channelId, req.user.id, req.body || {}));
}));

router.delete('/:channelId', requireVerified, wrap(async (req, res) => {
  res.json(await channels.remove(req.params.serverId, req.params.channelId, req.user.id));
}));

module.exports = router;
