// Friends, blocking, and the privacy settings that govern who may reach you.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const friends = require('../../services/friends');

const router = express.Router();
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  res.json(await friends.list(req.user.id));
}));

router.post('/', requireVerified, limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return fail(res, 'VALIDATION_ERROR', 'a user id is required');
  res.status(201).json(await friends.sendRequest(req.user.id, userId));
}));

router.post('/requests/:requestId/accept', requireVerified, wrap(async (req, res) => {
  res.json(await friends.accept(req.user.id, req.params.requestId));
}));

router.post('/requests/:requestId/decline', requireVerified, wrap(async (req, res) => {
  res.json(await friends.decline(req.user.id, req.params.requestId));
}));

router.delete('/requests/:requestId', requireVerified, wrap(async (req, res) => {
  res.json(await friends.withdraw(req.user.id, req.params.requestId));
}));

router.delete('/:userId', requireVerified, wrap(async (req, res) => {
  res.json(await friends.remove(req.user.id, req.params.userId));
}));

router.get('/privacy', wrap(async (req, res) => {
  res.json(await friends.privacy(req.user.id));
}));

router.put('/privacy', requireVerified, wrap(async (req, res) => {
  res.json(await friends.setPrivacy(req.user.id, req.body || {}));
}));

router.get('/blocks', wrap(async (req, res) => {
  res.json(await friends.blocks(req.user.id));
}));

router.post('/blocks', requireVerified, wrap(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return fail(res, 'VALIDATION_ERROR', 'a user id is required');
  res.status(201).json(await friends.block(req.user.id, userId));
}));

router.delete('/blocks/:userId', requireVerified, wrap(async (req, res) => {
  res.json(await friends.unblock(req.user.id, req.params.userId));
}));

module.exports = router;
