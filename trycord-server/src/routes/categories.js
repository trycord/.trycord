// /api/servers/:serverId/categories — list (members), create/delete (MANAGE_CHANNELS).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { serviceError } = require('../errors');
const channels = require('../services/channels');
const events = require('../services/events');
const permissions = require('../services/permissions');

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer);

router.get('/', requireMember, async (req, res, next) => {
  try {
    res.json(await channels.categories(req.server.id));
  } catch (e) { next(e); }
});

router.post('/', auth.requireVerified, requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { name } = req.body || {};
    const cat = await channels.createCategory(req.server.id, name);
    events.emit(req.server.id, 'category_created', { category: cat });
    res.json(cat);
  } catch (e) { serviceError(res, e); }
});

router.patch('/:categoryId', auth.requireVerified, requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { name } = req.body || {};
    const cat = await channels.renameCategory(req.server.id, req.params.categoryId, name);
    events.emit(req.server.id, 'category_updated', { category: cat });
    res.json(cat);
  } catch (e) { serviceError(res, e); }
});

router.post('/reorder', auth.requireVerified, requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { orderedIds } = req.body || {};
    const layout = await channels.reorderCategories(req.server.id, orderedIds);
    events.emit(req.server.id, 'categories_reordered', { categories: layout.categories.map((c) => c.id) });
    res.json(layout);
  } catch (e) { serviceError(res, e); }
});

router.delete('/:categoryId', auth.requireVerified, requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const out = await channels.deleteCategory(req.server.id, req.params.categoryId);
    events.emit(req.server.id, 'category_deleted', { categoryId: String(req.params.categoryId) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// ---- category permission overrides ----
// A category override applies to every channel inside it and is one level
// below the channel. Same tri-state and same MANAGE_CHANNELS gate as the
// channel editor: overrides adjust what roles grant, they are not a
// parallel permission system.
const findCategory = async (req) => {
  const list = await channels.categories(req.server.id);
  return (list || []).find((c) => String(c.id) === String(req.params.categoryId)) || null;
};

router.get('/:categoryId/overrides', requireMember, async (req, res, next) => {
  try {
    const cat = await findCategory(req);
    if (!cat) return serviceError(res, { code: 'NOT_FOUND', message: 'category not found' });
    res.json({
      categoryId: String(cat.id),
      overrides: await permissions.overridesFor('category_permission_overrides', cat.id),
      all: Object.keys(permissions.PERMISSIONS),
    });
  } catch (e) { serviceError(res, e); }
});

router.put('/:categoryId/overrides/:permission', auth.requireVerified, requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const cat = await findCategory(req);
    if (!cat) return serviceError(res, { code: 'NOT_FOUND', message: 'category not found' });
    const { effect } = req.body || {};
    await permissions.setOverride('category_permission_overrides', cat.id, req.params.permission, effect);
    events.emit(req.server.id, 'category_updated', { categoryId: String(cat.id) });
    res.json({
      categoryId: String(cat.id),
      overrides: await permissions.overridesFor('category_permission_overrides', cat.id),
    });
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
