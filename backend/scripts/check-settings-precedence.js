#!/usr/bin/env node
'use strict';

// The configuration lifecycle, against a real database.
//
// This exists because the configuration centre's whole promise is that a saved setting
// is really in force and stays that way. The ways it can be wrong are invisible from the
// outside: a save that reports success and stores nothing, an environment variable that
// quietly overrides an administrator after a restart, an invalid value that lands
// anyway, a secret that comes back over the wire.
//
//   ownership      an application setting is the instance's once it is saved
//   seeding        an environment variable supplies a value only until one is saved
//   persistence    a saved value survives a reload and a simulated restart
//   validation     an out-of-range value is refused and changes nothing
//   restart        a boot-time setting is stored now and flagged, not claimed as live
//   secrets        never returned, never in the export, locked when the deployment owns them
//   reset          removing the override restores the deployment seed or the default
//
// node scripts/check-settings-precedence.js

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-settings-' + Date.now();
process.env.DB_CLIENT = 'sqlite';
// This check owns its database. A configuration saved in the admin panel must not
// redirect it, so the saved override is ignored here.
process.env.TRYCOD_DB_ENV_ONLY = '1';
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-settings-')), 'check.db');

// The deployment variables this check sets and clears, restored afterwards.
const ENV_KEYS = ['TRYCORD_NAME', 'TRYCORD_SUPPORT_URL', 'WS_MAX_PAYLOAD', 'SMTP_PASSWORD', 'REGISTRATION_ENABLED'];
const savedEnv = {};
for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) { passed += 1; console.log('    ok   ' + label + (detail ? ': ' + detail : '')); }
  else { failed += 1; failures.push(label); console.log('    FAIL ' + label + (detail ? ': ' + detail : '')); }
}

async function main() {
  const db = require('../src/db');
  await db.connect();
  const settings = require('../src/services/settings');

  const adminId = 'admin-' + Date.now();
  await db.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [adminId, 'settings-admin', 'x', new Date().toISOString()]
  );
  await db.run('INSERT INTO admins (user_id, created_at) VALUES (?, ?)',
    [adminId, new Date().toISOString()]);

  const byKey = (key) => {
    for (const cat of settings.catalogue()) {
      const found = (cat.settings || []).find((s) => s.key === key);
      if (found) return found;
    }
    return null;
  };

  // -- A: an application setting is saved, survives a reload, and is the one in force --
  console.log('\n  editing an application setting');
  await settings.load(true);
  ok('a fresh instance starts on the schema default',
    settings.get('instance.name') === 'Trycord', settings.get('instance.name'));

  const saved = await settings.save({ 'instance.name': 'Ember Hollow' }, adminId);
  ok('the save reports what changed', saved.ok && saved.changed.includes('instance.name'),
    JSON.stringify(saved.changed));
  ok('the effective value is the saved one',
    settings.get('instance.name') === 'Ember Hollow', settings.get('instance.name'));
  ok('the catalogue attributes it to the instance',
    settings.source('instance.name') === 'instance', settings.source('instance.name'));

  // A restart is a re-load against the same database: the saved value must win again.
  await settings.load(true);
  ok('a reload keeps the saved value', settings.get('instance.name') === 'Ember Hollow',
    settings.get('instance.name'));

  // -- B: the environment seeds a setting, and stops deciding once it is saved -------
  console.log('\n  the environment seeds, the instance decides');
  process.env.TRYCORD_SUPPORT_URL = 'https://seed.example.com/help';
  await settings.load(true);
  ok('an unsaved setting takes the environment value',
    settings.get('instance.supportUrl') === 'https://seed.example.com/help',
    settings.get('instance.supportUrl'));
  ok('and is reported as coming from the environment',
    settings.source('instance.supportUrl') === 'environment', settings.source('instance.supportUrl'));
  ok('but it is still editable', byKey('instance.supportUrl').locked === false);

  await settings.save({ 'instance.supportUrl': 'https://instance.example.com/help' }, adminId);
  await settings.load(true);
  ok('after a save the instance value wins over the seed',
    settings.get('instance.supportUrl') === 'https://instance.example.com/help',
    settings.get('instance.supportUrl'));
  ok('and the source is the instance',
    settings.source('instance.supportUrl') === 'instance', settings.source('instance.supportUrl'));
  ok('the seed is remembered, not applied',
    byKey('instance.supportUrl').seededFrom === 'TRYCORD_SUPPORT_URL',
    String(byKey('instance.supportUrl').seededFrom));

  // -- C: an invalid value is refused and nothing changes ---------------------------
  console.log('\n  refusing an invalid value');
  const tooSmall = await settings.save({ 'content.maxUploadBytes': 1 }, adminId);
  ok('a value below the minimum is refused', tooSmall.ok === false);
  ok('the reason names the bound',
    tooSmall.problems.some((p) => /at least/.test(p)), (tooSmall.problems || []).join('; '));
  ok('the previous effective value is untouched',
    settings.get('content.maxUploadBytes') === 8388608, String(settings.get('content.maxUploadBytes')));

  const junk = await settings.save({ 'not.a.setting': 'x' }, adminId);
  ok('an unknown key is refused', junk.ok === false && junk.problems.some((p) => /unknown/.test(p)),
    (junk.problems || []).join('; '));

  // -- E: a restart-required setting is stored but reported as pending --------------
  console.log('\n  a setting the application reads once at boot');
  const bootTime = await settings.save({ 'messaging.maxPayload': 131072 }, adminId);
  ok('it saves', bootTime.ok === true);
  ok('the store holds the new value',
    settings.get('messaging.maxPayload') === 131072, String(settings.get('messaging.maxPayload')));
  ok('the status reports it as waiting for a restart',
    settings.status().pendingRestart.includes('messaging.maxPayload'),
    JSON.stringify(settings.status().pendingRestart));
  ok('the catalogue flags it as restart-required',
    byKey('messaging.maxPayload').restartRequired === true);
  ok('a live setting is not flagged as pending',
    byKey('instance.name').pendingRestart === false);

  // -- D: secrets never reach the client -------------------------------------------
  console.log('\n  secrets stay server-side');
  await settings.save({ 'mail.smtpPassword': 'relay-secret-value' }, adminId);
  const dump = JSON.stringify(settings.catalogue());
  ok('no secret value appears in the catalogue', !dump.includes('relay-secret-value'));
  ok('the catalogue reports a secret as set',
    byKey('mail.smtpPassword').set === true && byKey('mail.smtpPassword').type === 'secret');
  const exported = JSON.stringify(Object.fromEntries(
    settings.SCHEMA.map((s) => [s.key, settings.SECRETS.has(s.key) ? '<placeholder>' : settings.serialise(settings.get(s.key))])
  ));
  ok('no secret value appears in an export', !exported.includes('relay-secret-value'));

  process.env.SMTP_PASSWORD = 'from-the-deployment';
  await settings.load(true);
  ok('a deployment-set secret is locked',
    byKey('mail.smtpPassword').locked === true && settings.source('mail.smtpPassword') === 'environment');
  let refused = null;
  try { await settings.reset('mail.smtpPassword', adminId); } catch (e) { refused = e; }
  ok('and cannot be reset here', refused !== null && refused.code === 'LOCKED');
  delete process.env.SMTP_PASSWORD;
  await settings.load(true);

  // -- F: reset restores the seed, or the default ----------------------------------
  console.log('\n  resetting to the deployment value');
  await settings.reset('instance.supportUrl', adminId);
  await settings.load(true);
  ok('resetting restores the environment seed',
    settings.get('instance.supportUrl') === 'https://seed.example.com/help',
    settings.get('instance.supportUrl'));
  ok('and the source goes back to the environment',
    settings.source('instance.supportUrl') === 'environment', settings.source('instance.supportUrl'));

  delete process.env.TRYCORD_SUPPORT_URL;
  await settings.load(true);
  ok('with no seed it returns to the schema default',
    settings.get('instance.supportUrl') === '', '[' + settings.get('instance.supportUrl') + ']');

  // A concurrent edit is refused rather than silently overwriting the newer value.
  console.log('\n  two administrators, one setting');
  await settings.load(true);
  const seen = settings.get('instance.name');
  await db.run("UPDATE instance_settings SET value = ? WHERE `key` = 'instance.name'", ['Edited elsewhere']);
  let conflict = null;
  try { await settings.save({ 'instance.name': 'Mine' }, adminId); } catch (e) { conflict = e; }
  ok('a stale write is refused', conflict !== null && conflict.code === 'CONFLICT',
    conflict && conflict.message);
  await settings.load(true);
  ok('the newer stored value survives', settings.get('instance.name') === 'Edited elsewhere',
    settings.get('instance.name'));

  await db.close();
  console.log(failed
    ? '\n  settings lifecycle check FAILED - ' + failed + ' of ' + (passed + failed) + ' assertions failed\n'
    : '\n  settings lifecycle check passed - ' + passed + ' assertions\n');
  return failed ? 1 : 0;
}

main()
  .then((code) => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.exit(code);
  })
  .catch((e) => { console.error(e); process.exit(1); });
