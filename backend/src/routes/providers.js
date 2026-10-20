// The provider catalogue, for the administration console.
//
// What a subsystem can be configured to use, which one is in force, and why
// the others are not. The console renders this and nothing else, so a
// subsystem's providers are described in one place rather than being assembled
// from four services that each knew only their own.
const express = require('express');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const registry = require('../services/providers/registry');

const router = express.Router();
router.use(adminGuard);

// GET /api/admin/providers — the whole catalogue.
router.get('/', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json({ subsystems: await registry.catalogue() });
  } catch (e) { next(e); }
});

// GET /api/admin/providers/:subsystem — one subsystem.
router.get('/:subsystem', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const subsystem = registry.findSubsystem(req.params.subsystem);
    if (!subsystem) return fail(res, 'NOT_FOUND', 'no such subsystem');
    const all = await registry.catalogue();
    const found = all.find((s) => s.id === subsystem.id);
    res.json(found);
  } catch (e) { next(e); }
});

// POST /api/admin/providers/:subsystem/:provider/check — a real check.
//
// This is the only route here that touches the network, and it does so
// because an administrator pressed a button. A provider that cannot be
// checked says so rather than reporting itself healthy.
router.post('/:subsystem/:provider/check', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const result = await registry.check(req.params.subsystem, req.params.provider);
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
