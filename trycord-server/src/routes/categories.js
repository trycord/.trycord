// /api/servers/:serverId/categories — list (members), create/delete (MANAGE_CHANNELS).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { serviceError } = require('../errors');
const channels = require('../services/channels');
const events = require('../services/events');

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
    const cat = await channels.createCategory(req.server.id, name);
    events.emit(req.server.id, 'category_created', { category: cat });
    res.json(cat);
  } catch (e) { serviceError(res, e); }
});

router.patch('/:categoryId', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { name } = req.body || {};
    const cat = await channels.renameCategory(req.server.id, req.params.categoryId, name);
    events.emit(req.server.id, 'category_updated', { category: cat });
    res.json(cat);
  } catch (e) { serviceError(res, e); }
});

router.post('/reorder', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { orderedIds } = req.body || {};
    const layout = await channels.reorderCategories(req.server.id, orderedIds);
    events.emit(req.server.id, 'categories_reordered', { categories: layout.categories.map((c) => c.id) });
    res.json(layout);
  } catch (e) { serviceError(res, e); }
});

router.delete('/:categoryId', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const out = await channels.deleteCategory(req.server.id, req.params.categoryId);
    events.emit(req.server.id, 'category_deleted', { categoryId: String(req.params.categoryId) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
