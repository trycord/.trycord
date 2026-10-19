// The database this instance stores everything in.
//
// Deliberately not part of the settings catalogue. The value that says where the
// settings are kept has to be readable before the settings can be read, so it lives
// in an independent bootstrap file (see src/db/config.js) and this router is the
// only thing that writes it.
//
// Every route is behind the platform-admin gate. A password is never returned: a
// stored one is reported as set or unset, and a write that leaves the field out
// keeps the stored one, so a form that renders a masked field cannot wipe a
// credential by being submitted.

const express = require('express');
const { fail, wrap } = require('../errors');
const rateLimit = require('../middleware/ratelimit');
const adminGuard = require('../middleware/adminGuard');
const dbConfig = require('../db/config');
const db = require('../db');
const settings = require('../services/settings');
const features = require('../features');
const backup = require('../services/backup');

const router = express.Router();
router.use(adminGuard);

// A submitted configuration, with the stored password filled back in when the form
// did not carry one. Reusing it only makes sense for the same server and database;
// pointing at a different one with the old password would be a guess.
function withStoredPassword(body) {
  const input = Object.assign({}, body);
  delete input.__confirm;
  delete input.clearPassword;
  if (input.client !== 'mysql') return input;

  if (body.clearPassword === true) { input.password = ''; return input; }
  if (input.password != null) return input;

  const previous = dbConfig.loadSaved().config;
  const sameTarget = previous && previous.client === 'mysql'
    && previous.host === String(input.host || '').trim()
    && previous.name === String(input.name || '').trim()
    && previous.user === String(input.user || '').trim();
  input.password = sameTarget ? previous.password : '';
  return input;
}

function describe() {
  const saved = dbConfig.loadSaved();
  const runtime = db.status();
  const live = db.liveConfig();
  const fromEnv = dbConfig.fromEnvironment();
  const candidate = runtime.connected ? live : (dbConfig.candidates()[0] || {}).config || null;

  // An administrator's saved configuration that is also the live one is what is in
  // force, even when the process happened to open the identical connection from the
  // environment first. Reporting "the environment" there is the one reading that
  // makes a save look like it did nothing - which is exactly how it was read.
  const savedInForce = saved.config && runtime.connected && dbConfig.same(saved.config, live);

  return {
    effective: dbConfig.mask(candidate),
    source: savedInForce ? 'instance' : runtime.source,
    dialect: runtime.dialect,
    runtime: { connected: runtime.connected, openedAt: runtime.openedAt, failures: runtime.failures },
    saved: {
      present: saved.present,
      config: dbConfig.mask(saved.config),
      previous: dbConfig.mask(saved.previous),
      savedAt: saved.savedAt || null,
      savedBy: saved.savedBy || null,
      problem: saved.problem || null,
    },
    environment: fromEnv && fromEnv.ok ? dbConfig.mask(fromEnv.config) : null,
    environmentProblem: dbConfig.environmentProblem(),
    // The file no longer agrees with what the process is connected to. That is the
    // honest signal that a restart is what makes the saved value real.
    pendingRestart: !!(saved.config && (!live || !dbConfig.same(saved.config, live))),
  };
}

router.get('/', wrap(async (req, res) => {
  res.json(describe());
}));

// Reachability, without storing anything. A failed test is an answer, not a client
// error, so it comes back 200 with ok:false.
router.post('/test', rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const check = dbConfig.validate(withStoredPassword(req.body || {}));
  if (!check.ok) return fail(res, 'VALIDATION_ERROR', check.problems.join(' '), 400);
  const reached = await dbConfig.probe(check.config);
  res.json({ ok: reached.ok, error: reached.error || null, dialect: reached.dialect || null });
}));

// Save. Reachability is proven first: a configuration that cannot be connected to
// must never replace one that works.
router.put('/', rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const body = req.body || {};
  if (body.__confirm !== true) {
    return fail(res, 'CONFIRMATION_REQUIRED', 'Changing the database interrupts service.', 400);
  }
  const check = dbConfig.validate(withStoredPassword(body));
  if (!check.ok) return fail(res, 'VALIDATION_ERROR', check.problems.join(' '), 400);

  const reached = await dbConfig.probe(check.config);
  if (!reached.ok) return fail(res, 'CONNECTION_FAILED', reached.error, 400);

  dbConfig.saveSaved(check.config, { savedBy: req.user.id });
  res.json(Object.assign(describe(), { ok: true, restartRequired: true }));
}));

// Give up the saved override. The environment decides again.
router.delete('/', rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  dbConfig.clearSaved();
  res.json(Object.assign(describe(), { ok: true, restartRequired: true }));
}));

// Put the previous configuration back. Also the way out of a saved value that
// looked reachable when it was written but is not any more.
router.post('/rollback', rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const out = dbConfig.rollbackSaved();
  if (!out.ok) return fail(res, 'NOT_FOUND', out.error, 400);
  res.json(Object.assign(describe(), { ok: true, restartRequired: true }));
}));

// Switch to the saved configuration now, without waiting for a restart.
//
// The new connection is opened and migrated before it replaces the current one, so
// a failure here leaves the running connection exactly as it was - that is the
// rollback. The settings catalogue is then re-read, because it was loaded from the
// connection that just went away.
router.post('/apply', rateLimit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const out = await db.reconnect();
  if (!out.ok) return fail(res, 'CONNECTION_FAILED', out.error, 400);
  await settings.load(true);
  features.load();
  res.json(Object.assign(describe(), { ok: true, applied: true }));
}));

// A redacted configuration snapshot, for an operator who wants to see what the
// instance is actually configured with without exposing a single credential.
//
// A secret is reported as set or unset and carries no value at all.
router.get('/backup', wrap(async (req, res) => {
  await settings.load();
  const cat = settings.catalogue();
  const safe = cat.map((c) => ({
    id: c.id,
    label: c.label,
    settings: c.settings.map((s) => (s.type === 'secret'
      ? { key: s.key, set: !!s.set, source: s.source }
      : { key: s.key, value: s.value, source: s.source })),
  }));
  res.json({
    exportedAt: new Date().toISOString(),
    dialect: db.status().dialect,
    settings: safe,
  });
}));

// The backups already on this host, newest first. Names, sizes and dates only:
// the files themselves are the operator's to move.
router.get('/backups', wrap(async (req, res) => {
  res.json({ backups: backup.list(), directory: backup.backupDirectory() });
}));

// Take a backup now. The dump is written to the backup directory, verified by
// reading it back, and reported with what it contains.
//
// A dump of the instance's rows belongs on the host: the path is returned so an
// operator can move it, and it is not served over HTTP.
router.post('/backup', rateLimit({ windowMs: 60000, max: 2 }), wrap(async (req, res) => {
  try {
    const out = await backup.create();
    res.json({ ok: true, backup: out });
  } catch (e) {
    if (e && e.result) {
      return fail(res, e.code || 'BACKUP_FAILED', e.message, 500);
    }
    return fail(res, (e && e.code) || 'BACKUP_FAILED', (e && e.message) || 'The backup did not complete.', 500);
  }
}));

module.exports = router;
