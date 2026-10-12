// Mail configuration endpoints.
//
// Behind the platform-admin gate with everything else in settings, and rate limited
// harder than the rest because test-send reaches a third-party service and burns a
// credential. The catalogue comes from the provider registry, so this file names no
// vendor and needs no change when one is added.
//
// Secrets are never returned. The response says whether one is set, where it came from,
// and whether it can still be read, and nothing else.

const express = require('express');
const { fail, wrap } = require('../errors');
const rateLimit = require('../middleware/ratelimit');
const adminGuard = require('../middleware/adminGuard');
const settings = require('../services/settings');
const mail = require('../services/mail');
const secrets = require('../services/secrets');
const db = require('../db');
const { now, uuid } = require('../util');

const router = express.Router();
router.use(adminGuard);

// The three modes and what each one needs, plus the current configuration. The dashboard
// renders whatever this returns, so the set of providers is decided in one place.
router.get('/', wrap(async (req, res) => {
  await settings.load();
  res.json({
    modes: mail.MODES,
    providers: mail.catalogue(),
    current: mail.mode(),
    status: mail.describe(),
    validation: mail.validateCurrent(),
  });
}));

// Check the configuration without sending anything. No network: a provider's validate()
// has to be answerable on the request path.
router.post('/validate', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  await settings.load();
  const result = mail.validateCurrent();
  res.json({
    ok: result.ok,
    problems: result.problems,
    mode: mail.mode(),
    status: mail.describe(),
  });
}));

// A real message to a real address through the configured provider. This is the only
// endpoint that leaves the instance, so it is the tightest rate limit here.
router.post('/test', rateLimit({ windowMs: 60000, max: 5 }), wrap(async (req, res) => {
  await settings.load();
  const out = await mail.test((req.body || {}).to);
  if (!out.ok) return fail(res, 'VALIDATION_ERROR', out.error, 400);
  res.json(out);
}));

// Store a credential. The value arrives over the wire, is encrypted before it is written
// and is never echoed back. An empty body keeps whatever is stored, which is what lets
// the dashboard render an empty password field for something it cannot read.
router.put('/secrets/:key', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  await settings.load();

  const key = 'mail.' + String(req.params.key || '').replace(/[^a-zA-Z]/g, '');
  if (!settings.SECRETS.has(key)) return fail(res, 'NOT_FOUND', 'that is not a mail credential');

  const body = req.body || {};
  const value = body.value === undefined ? body.clear ? null : undefined : String(body.value);

  if (value === undefined) {
    return fail(res, 'VALIDATION_ERROR', 'send a value, or clear:true to remove the stored one', 400);
  }
  if (value !== null && !value.trim()) {
    return fail(res, 'VALIDATION_ERROR', 'send a value, or clear:true to remove the stored one', 400);
  }
  if (settings.source(key) === 'environment') {
    return fail(res, 'PERMISSION_DENIED',
      'that credential comes from the deployment environment (' + (settings.SCHEMA.find((s) => s.key === key) || {}).env + ') and cannot be changed here', 403);
  }

  try {
    await settings.save({ [key]: value }, req.user.id);
  } catch (e) {
    if (e && e.code === 'CONFLICT') return fail(res, 'CONFLICT', e.message, 409);
    throw e;
  }

  const stored = settings.secretStored(key);
  res.json({
    ok: true,
    key,
    // Presence only. The value cannot be read back and is not sent over the wire.
    set: !!stored,
    readable: stored ? secrets.readable('mail:' + key, stored) : null,
    source: settings.source(key),
  });
}));

// Remove a stored credential. The environment is untouched: that value belongs to the
// deployment, and deleting a row here must not appear to remove it.
router.delete('/secrets/:key', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  await settings.load();

  const key = 'mail.' + String(req.params.key || '').replace(/[^a-zA-Z]/g, '');
  if (!settings.SECRETS.has(key)) return fail(res, 'NOT_FOUND', 'that is not a mail credential');

  if (settings.source(key) === 'environment') {
    return fail(res, 'PERMISSION_DENIED',
      'that credential comes from the deployment environment and cannot be removed here', 403);
  }

  await db.run('DELETE FROM instance_settings WHERE `key` = ?', [key]);
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, 'clear_secret', 'instance', ?, NULL, ?)`,
    [uuid(), req.user.id, key, now()]
  );
  await settings.load(true);

  res.json({ ok: true, key, set: false, source: settings.source(key) });
}));

module.exports = router;
