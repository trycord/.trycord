// Community Memory routes.
//
// Curated knowledge entries scoped to a single server. Any member may read;
// writing requires the MEMORIZE permission.
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const memory = require('../services/communityMemory');

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer, requireMember);

// GET /api/servers/:serverId/communityMemory - list entries for this server
router.get('/', async (req, res, next) => {
  try {
    res.json(await memory.list(req.server.id));
  } catch (e) { serviceError(res, e); }
});

// POST /api/servers/:serverId/communityMemory - create an entry
router.post('/', auth.requireVerified, requirePerm('MEMORIZE'), async (req, res, next) => {
  try {
    const { title, body, channelId, sourceMessageId } = req.body || {};
    const entry = await memory.create({
      serverId: req.server.id,
      actorId: req.user.id,
      channelId: channelId || null,
      title: title || '',
      body: body || '',
      sourceMessageId: sourceMessageId || null,
    });
    res.status(201).json(entry);
  } catch (e) { serviceError(res, e); }
});

// GET /api/servers/:serverId/communityMemory/:id - get one entry
router.get('/:id', async (req, res, next) => {
  try {
    const entry = await memory.get(req.server.id, req.params.id);
    if (!entry) return fail(res, 'NOT_FOUND', 'entry not found');
    res.json(entry);
  } catch (e) { serviceError(res, e); }
});

// PUT /api/servers/:serverId/communityMemory/:id - edit an entry
router.put('/:id', auth.requireVerified, requirePerm('MEMORIZE'), async (req, res, next) => {
  try {
    const { title, body } = req.body || {};
    const entry = await memory.update({
      serverId: req.server.id,
      actorId: req.user.id,
      id: req.params.id,
      title: title !== undefined ? title : undefined,
      body: body !== undefined ? body : undefined,
    });
    res.json(entry);
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/servers/:serverId/communityMemory/:id - delete an entry
router.delete('/:id', auth.requireVerified, requirePerm('MEMORIZE'), async (req, res, next) => {
  try {
    await memory.remove({
      serverId: req.server.id,
      actorId: req.user.id,
      id: req.params.id,
    });
    res.json({ ok: true });
  } catch (e) { serviceError(res, e); }
});

// GET /api/servers/:serverId/communityMemory/:id/revisions - list revisions
router.get('/:id/revisions', async (req, res, next) => {
  try {
    const entry = await memory.get(req.server.id, req.params.id);
    if (!entry) return fail(res, 'NOT_FOUND', 'entry not found');
    const revisions = await memory.listRevisions(req.params.id);
    res.json(revisions);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
