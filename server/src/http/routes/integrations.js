// Community integrations: webhooks, and the analytics an owner sees.
//
// The incoming half - an external service posting into a channel - lives at
// /api/webhooks/:token rather than here, because a caller holding a webhook secret is not
// a Trycord user and has no session.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const webhooks = require('../../services/webhooks');

const router = express.Router({ mergeParams: true });
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  res.json(await webhooks.list(req.params.serverId, req.user.id));
}));

router.post('/', requireVerified, limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  res.status(201).json(await webhooks.create(req.params.serverId, req.user.id, req.body || {}));
}));

router.patch('/:webhookId', requireVerified, wrap(async (req, res) => {
  res.json(await webhooks.update(req.params.serverId, req.params.webhookId, req.user.id, req.body || {}));
}));

router.post('/:webhookId/rotate-secret', requireVerified, limit({ windowMs: 60000, max: 5 }), wrap(async (req, res) => {
  res.json(await webhooks.rotateSecret(req.params.serverId, req.params.webhookId, req.user.id));
}));

router.get('/:webhookId/deliveries', wrap(async (req, res) => {
  res.json(await webhooks.deliveries(req.params.serverId, req.params.webhookId, req.user.id, req.query || {}));
}));

router.delete('/:webhookId', requireVerified, wrap(async (req, res) => {
  res.json(await webhooks.remove(req.params.serverId, req.params.webhookId, req.user.id));
}));

module.exports = router;
