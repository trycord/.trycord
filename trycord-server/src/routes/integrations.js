// Webhooks, bot applications and slash commands.
//
// Mounted under the community router so they inherit the same membership and
// permission evaluation every other community operation already goes through -
// a second router here would be a second answer to "may this admin do that".
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const webhooks = require('../services/webhooks');
const bots = require('../services/bots');
const analytics = require('../services/analytics');
const { visibleChannel } = require('../util');
const { resolveServer, requirePerm } = require('../middleware/serverAccess');

const router = express.Router({ mergeParams: true });

// ---- webhooks ------------------------------------------------------------

router.get('/webhooks', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try { res.json({ webhooks: await webhooks.list(req.server.id) }); } catch (e) { next(e); }
});

router.post('/webhooks', auth, resolveServer, requirePerm('MANAGE_SERVER'),
  auth.requireVerified, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
    try {
      const body = req.body || {};
      let channelId = null;
      if (body.channelId) {
        const ch = await visibleChannel(body.channelId, req.user.id);
        if (!ch || ch.server_id !== req.server.id) {
          return fail(res, 'NOT_FOUND', 'channel not found in this community');
        }
        channelId = ch.id;
      }
      const hook = await webhooks.create({
        serverId: req.server.id, channelId, name: body.name, url: body.url, createdBy: req.user.id,
      });
      // 201 with the secret in the body: it is shown exactly once and cannot be
      // recovered afterwards, which is what makes it rotatable.
      res.status(201).json({ webhook: hook });
    } catch (e) { serviceError(res, e); }
  });

router.patch('/webhooks/:webhookId', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const out = await webhooks.update(req.params.webhookId, req.server.id, req.body || {});
    if (!out) return fail(res, 'NOT_FOUND', 'webhook not found');
    res.json({ webhook: out });
  } catch (e) { serviceError(res, e); }
});

router.post('/webhooks/:webhookId/rotate-secret', auth, resolveServer, requirePerm('MANAGE_SERVER'),
  auth.requireVerified, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
    try {
      const out = await webhooks.rotate(req.params.webhookId, req.server.id);
      if (!out) return fail(res, 'NOT_FOUND', 'webhook not found');
      res.json(out);
    } catch (e) { serviceError(res, e); }
  });

router.get('/webhooks/:webhookId/deliveries', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const rows = await webhooks.deliveries(req.params.webhookId, req.server.id, req.query.limit);
    if (rows === null) return fail(res, 'NOT_FOUND', 'webhook not found');
    res.json({ deliveries: rows });
  } catch (e) { next(e); }
});

router.delete('/webhooks/:webhookId', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const ok = await webhooks.remove(req.params.webhookId, req.server.id);
    if (!ok) return fail(res, 'NOT_FOUND', 'webhook not found');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- analytics -----------------------------------------------------------
//
// These are counts over other people's messages, so this is MANAGE_SERVER
// rather than plain membership. There is no separate "view stats" permission in
// the model, and adding one to the vocabulary for this would mean a new column
// default, a new matrix row and a new client control to keep in step.
router.get('/analytics', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    res.json(await analytics.report(req.server.id, req.query.days));
  } catch (e) { next(e); }
});

// ---- bot applications ----------------------------------------------------

router.get('/apps', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try { res.json({ apps: await bots.listApps(req.server.id) }); } catch (e) { next(e); }
});

router.post('/apps', auth, resolveServer, requirePerm('MANAGE_SERVER'),
  auth.requireVerified, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
    try {
      const app = await bots.createApp({
        serverId: req.server.id, ownerUserId: req.user.id, name: (req.body || {}).name,
      });
      res.status(201).json({ app });
    } catch (e) { serviceError(res, e); }
  });

router.get('/apps/:appId/commands', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const app = await bots.getApp(req.params.appId, req.server.id);
    if (!app) return fail(res, 'NOT_FOUND', 'application not found');
    res.json({ commands: await bots.listCommands(app.id) });
  } catch (e) { next(e); }
});

router.put('/apps/:appId/commands', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const out = await bots.setCommand(req.params.appId, req.body || {});
    if (!out) return fail(res, 'NOT_FOUND', 'application not found');
    res.json({ command: out });
  } catch (e) { serviceError(res, e); }
});

router.delete('/apps/:appId/commands/:commandId', auth, resolveServer, requirePerm('MANAGE_SERVER'),
  async (req, res, next) => {
    try {
      const ok = await bots.removeCommand(req.params.commandId, req.params.appId);
      if (!ok) return fail(res, 'NOT_FOUND', 'command not found');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

router.delete('/apps/:appId', auth, resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const ok = await bots.removeApp(req.params.appId, req.server.id);
    if (!ok) return fail(res, 'NOT_FOUND', 'application not found');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;