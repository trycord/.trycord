// Direct messages.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const dms = require('../../services/dms');

const router = express.Router();
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  res.json(await dms.list(req.user.id));
}));

router.post('/', requireVerified, limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return fail(res, 'VALIDATION_ERROR', 'a user id is required');
  res.status(201).json(await dms.open(req.user.id, userId));
}));

router.get('/:conversationId', wrap(async (req, res) => {
  const detail = await dms.detail(req.params.conversationId, req.user.id);
  res.json(detail);
}));

router.post('/:conversationId/leave', requireVerified, wrap(async (req, res) => {
  res.json(await dms.leave(req.params.conversationId, req.user.id));
}));

router.get('/:conversationId/messages', wrap(async (req, res) => {
  res.json(await dms.history(req.params.conversationId, req.user.id, req.query));
}));

router.post('/:conversationId/messages', requireVerified, limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const out = await dms.post(req.params.conversationId, req.user, req.body || {});
  res.status(out.deduped ? 200 : 201).json(out.message);
}));

router.patch('/:conversationId/messages/:messageId', requireVerified, limit({ windowMs: 60000, max: 40 }), wrap(async (req, res) => {
  res.json(await dms.edit(req.params.conversationId, req.params.messageId, req.user, req.body && req.body.content));
}));

router.delete('/:conversationId/messages/:messageId', requireVerified, wrap(async (req, res) => {
  res.json(await dms.remove(req.params.conversationId, req.params.messageId, req.user));
}));

router.post('/:conversationId/read', requireVerified, wrap(async (req, res) => {
  res.json(await dms.markRead(req.params.conversationId, req.user.id));
}));

module.exports = router;
