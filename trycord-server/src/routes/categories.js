// /api/servers/:serverId/categories — list (members), create/delete (MANAGE_CHANNELS).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { serviceError } = require('../errors');
const channels = require('../services/channels');

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer);

router.get('/', requireMember, async (req, res, next) => {
  try {
    res.json(await channels.categories(req.server.id));
  } catch (e) { next(e); }
});

router.post('/', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { name } = req.body || {};
    res.json(await channels.createCategory(req.server.id, name));
  } catch (e) { serviceError(res, e); }
});

router.delete('/:categoryId', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    res.json(await channels.deleteCategory(req.server.id, req.params.categoryId));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
