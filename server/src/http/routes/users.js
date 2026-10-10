// Users and profiles.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate } = require('../../middleware/auth');
const users = require('../../services/users');

const router = express.Router();
router.use(authenticate);

router.get('/me', wrap(async (req, res) => {
  res.json(await users.me(req.user.id));
}));

router.patch('/me', wrap(async (req, res) => {
  res.json(await users.update(req.user.id, req.body || {}));
}));

router.get('/search', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.json(await users.search(req.query.q, req.query.limit));
}));

router.get('/:id', wrap(async (req, res) => {
  const profile = await users.publicProfile(req.params.id);
  if (!profile) return fail(res, 'NOT_FOUND', 'user not found');
  res.json(profile);
}));

module.exports = router;
