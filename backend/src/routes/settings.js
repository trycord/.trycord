// System administration: instance configuration.
//
// Every route is behind the platform-admin gate, which is the admins table and nothing
// else. A community administrator owning a community does not reach any of this.
//
// The catalogue is what the dashboard renders. It carries no secret value, ever - a
// secret setting is reported as set or unset and replaced only by an explicit write.

const express = require('express');
const { fail, wrap } = require('../errors');
const rateLimit = require('../middleware/ratelimit');
const adminGuard = require('../middleware/adminGuard');
const settings = require('../services/settings');
const quickSetup = require('../services/quick-setup');
const db = require('../db');
const { now, uuid } = require('../util');

const router = express.Router();
router.use(adminGuard);

// The whole catalogue, plus the settings that cannot be changed here and why.
router.get('/', wrap(async (req, res) => {
  await settings.load();
  res.json({
    categories: settings.catalogue(),
    deploymentOnly: settings.DEPLOYMENT_ONLY,
  });
}));

// ---- quick setup ------------------------------------------------------------
// Off unless instance.quickSetup is on. The boot sequence says so when it is.

router.get('/quick-setup', wrap(async (req, res) => {
  res.json({
    enabled: settings.get('instance.quickSetup'),
    essentials: quickSetup.essentials(),
  });
}));

router.put('/quick-setup', rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  if (!settings.get('instance.quickSetup')) {
    return fail(res, 'PERMISSION_DENIED',
      'quick setup is off. Turn it on in General first.', 403);
  }
  const result = await quickSetup.apply(req.body || {}, req.user.id);
  if (!result.ok) return fail(res, 'VALIDATION_ERROR', result.problems.join('; '), 400);
  res.json(result);
}));

// A real test mail through the real sender. Reports what happened rather than
// whether the call returned.
router.post('/quick-setup/test-mail', rateLimit({ windowMs: 60000, max: 5 }), wrap(async (req, res) => {
  const out = await quickSetup.testMail((req.body || {}).to);
  if (!out.ok) return fail(res, 'VALIDATION_ERROR', out.error, 400);
  res.json(out);
}));

// One category, for a dashboard that loads them as they are opened.
router.get('/:category', wrap(async (req, res) => {
  await settings.load();
  const found = settings.catalogue().find((c) => c.id === req.params.category);
  if (!found) return fail(res, 'NOT_FOUND', 'unknown category');
  res.json(found);
}));

// Save. The body is a map of setting key to value.
router.put('/', rateLimit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  await settings.load();
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) return fail(res, 'VALIDATION_ERROR', 'nothing to save');

  // A consequential setting - one that locks people out or opens registration - is the
  // one that needs saying yes to rather than clicking save.
  const consequential = keys.filter((k) => {
    const entry = settings.SCHEMA.find((s) => s.key === k);
    return entry && entry.consequential;
  });
  if (consequential.length && body.__confirm !== true) {
    return fail(res, 'CONFIRMATION_REQUIRED',
      consequential.join(', ') + ' need confirmation', 400);
  }

  // The confirmation flag is not a setting, and treating it as one would refuse every
  // consequential change as "unknown setting".
  const entries = Object.assign({}, body);
  delete entries.__confirm;

  let result;
  try {
    result = await settings.save(entries, req.user.id);
  } catch (e) {
    // A concurrent write is a refusal, not a failure: the administrator's value was not
    // stored and nothing was changed, which is exactly what the conflict says.
    if (e && e.code === 'CONFLICT') {
      return fail(res, 'CONFLICT', e.message, 409);
    }
    throw e;
  }
  if (!result.ok) return fail(res, 'VALIDATION_ERROR', result.problems.join('; '), 400);

  res.json({ ok: true, changed: result.changed, categories: settings.catalogue() });
}));

// Reset one setting back to its default. Deletes the stored row, which puts the source
// back on 'default' rather than writing the default over it.
router.delete('/:key', rateLimit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  await settings.load();
  const entry = settings.SCHEMA.find((s) => s.key === req.params.key);
  if (!entry) return fail(res, 'NOT_FOUND', 'unknown setting');
  if (settings.source(req.params.key) === 'environment') {
    return fail(res, 'PERMISSION_DENIED',
      'that value comes from the deployment environment and cannot be reset here', 403);
  }

  await db.run('DELETE FROM instance_settings WHERE `key` = ?', [req.params.key]);
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, 'reset_setting', 'instance', ?, NULL, ?)`,
    [uuid(), req.user.id, req.params.key, now()]
  );
  await settings.load(true);

  res.json({ ok: true, categories: settings.catalogue() });
}));

// A sanitised export: every value, with the secret-bearing ones left as a placeholder
// rather than a real credential.
router.get('/export/template', wrap(async (req, res) => {
  await settings.load();
  const out = {};
  for (const entry of settings.SCHEMA) {
    if (settings.SECRETS.has(entry.key)) {
      out[entry.key] = '<set in deployment environment>';
      continue;
    }
    out[entry.key] = settings.serialise(settings.get(entry.key));
  }
  res.json({ settings: out });
}));

module.exports = router;
