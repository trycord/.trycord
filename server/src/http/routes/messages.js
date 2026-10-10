// Messages: history, posting, editing, reactions, threads.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const messages = require('../../services/messages');

const router = express.Router();
router.use(authenticate);

// History, with the forward and backward cursors.
router.get('/:channelId/messages', wrap(async (req, res) => {
  res.json(await messages.history(req.params.channelId, req.user.id, req.query));
}));

router.post('/:channelId/messages', requireVerified, limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const { content, threadRootId, clientNonce } = req.body || {};
  const out = await messages.post(req.params.channelId, req.user, { content, threadRootId, clientNonce });
  // A duplicate client nonce is answered with the message that already carries it rather
  // than a second copy, so a retry does not double-post.
  res.status(out.deduped ? 200 : 201).json(out.message);
}));

router.get('/:channelId/messages/:messageId', wrap(async (req, res) => {
  res.json(await messages.byId(req.params.channelId, req.params.messageId, req.user.id));
}));

router.patch('/:channelId/messages/:messageId', requireVerified, limit({ windowMs: 60000, max: 40 }), wrap(async (req, res) => {
  res.json(await messages.edit(req.params.channelId, req.params.messageId, req.user, req.body && req.body.content));
}));

router.delete('/:channelId/messages/:messageId', requireVerified, wrap(async (req, res) => {
  res.json(await messages.remove(req.params.channelId, req.params.messageId, req.user));
}));

router.post('/:channelId/messages/:messageId/reactions', requireVerified, limit({ windowMs: 60000, max: 120 }), wrap(async (req, res) => {
  res.json(await messages.react(req.params.channelId, req.params.messageId, req.user, req.body && req.body.emoji));
}));

router.get('/:channelId/messages/:messageId/thread', wrap(async (req, res) => {
  res.json(await messages.thread(req.params.messageId, req.user.id));
}));

module.exports = router;
