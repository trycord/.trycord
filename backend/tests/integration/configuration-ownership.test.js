// One setting, one console.
//
// The voice settings are changed in the voice console. The general
// Configuration page shows them read-only and says where they are changed.
// A write that arrives at the general page for one of them is refused, and
// the refusal says where it belongs - and a write that arrives at the voice
// console for a setting the voice console does not own is refused too, so
// the consolidation does not become a different duplication.
//
// Before this, the voice console wrote through the general page and the
// general page refused the voice settings, so **nothing could be changed at
// all**: the voice console was broken by the rule that was meant to protect
// it.
//
// The extension API version is here too, because it is the same kind of
// mistake: it was derived from the application version, so every release
// that was numbered differently broke every installed extension.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startInstance, registerUser } = require('../helpers/instance');

const ROOT = path.join(__dirname, '..', '..');

test('one setting, one console', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');

  await t.test('the voice console changes the voice settings', async () => {
    // The provider is a consequential setting: it decides which provider
    // carries a call, and the console confirms it.
    const res = await owner.put('/api/admin/voice/settings', {
      __confirm: true,
      'voice.provider': 'mesh',
      'voice.mesh.maxParticipants': 4,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));

    // And the value is in force: the catalogue says so.
    const catalogue = await owner.get('/api/admin/voice/settings');
    assert.equal(catalogue.status, 200, JSON.stringify(catalogue.data));
    const entry = catalogue.data.settings.find((s) => s.key === 'voice.mesh.maxParticipants');
    assert.ok(entry, 'the setting is in the voice console\'s own catalogue');
    assert.equal(entry.value, 4);
  });

  await t.test('the general page refuses a voice setting, and says where it is changed', async () => {
    const res = await owner.put('/api/admin/settings', { 'voice.mesh.maxParticipants': 9 });
    assert.equal(res.status, 400, 'the general page wrote a voice setting');
    assert.match(String(res.data.error && res.data.error.message),
      /changed in Voice and video/,
      'the refusal does not say where the setting is changed: '
      + JSON.stringify(res.data));

    // And nothing was changed.
    const catalogue = await owner.get('/api/admin/voice/settings');
    const entry = catalogue.data.settings.find((s) => s.key === 'voice.mesh.maxParticipants');
    assert.equal(entry.value, 4, 'the refused write changed the value anyway');
  });

  await t.test('the general page shows the voice settings read-only, with a link', async () => {
    const catalogue = await owner.get('/api/admin/settings');
    assert.equal(catalogue.status, 200, JSON.stringify(catalogue.data));
    const entry = catalogue.data.categories
      .flatMap((category) => category.settings || [])
      .find((s) => s.key === 'voice.provider');
    assert.ok(entry, 'the voice setting is not in the catalogue at all');
    assert.equal(entry.canonical, 'admin.voice');
    assert.equal(entry.canonicalLabel, 'Voice and video');
    assert.equal(entry.canonicalRoute, '/admin/voice');
  });

  await t.test('the voice console lists every setting it owns', async () => {
    // The provider's own fields and the older keys they replaced are
    // deliberately not published in the general catalogue - they belong to
    // the voice console. They are in no catalogue at all otherwise, and a
    // console that asked for them by category never saw them.
    const catalogue = await owner.get('/api/admin/voice/settings');
    assert.equal(catalogue.status, 200, JSON.stringify(catalogue.data));
    const keys = catalogue.data.settings.map((s) => s.key);
    for (const key of ['voice.provider', 'voice.mesh.maxParticipants',
      'voice.cloudflare.appId', 'voice.sfu.token']) {
      assert.ok(keys.indexOf(key) !== -1,
        'the voice console does not list ' + key + ': ' + keys.join(', '));
    }
    // And it lists nothing it does not own.
    const settings = require(path.join(ROOT, 'src', 'services', 'settings'));
    const owned = new Set(settings.VOICE_OWNED);
    const foreign = keys.filter((key) => !owned.has(key));
    assert.deepEqual(foreign, [],
      'the voice console lists settings it does not own: ' + foreign.join(', '));
  });

  await t.test('the voice console refuses a setting it does not own', async () => {
    const res = await owner.put('/api/admin/voice/settings', { 'instance.name': 'Something else' });
    assert.equal(res.status, 400, 'the voice console changed the general configuration');
    assert.match(String(res.data.error && res.data.error.message),
      /not changed in Voice and video/,
      'the refusal does not say what is wrong: ' + JSON.stringify(res.data));
  });

  await t.test('a member cannot reach either of them', async () => {
    const general = await member.put('/api/admin/settings', { 'instance.name': 'Not yours' });
    assert.equal(general.status, 403, 'a member changed the general configuration');
    const voice = await member.put('/api/admin/voice/settings', { 'voice.provider': 'mesh' });
    assert.equal(voice.status, 403, 'a member changed the voice configuration');
  });

  await t.test('a consequential voice setting still asks to be confirmed', async () => {
    const res = await owner.put('/api/admin/voice/settings', { 'voice.enabled': false });
    assert.equal(res.status, 400, 'a consequential change was made without a confirmation');
    assert.equal(res.data.error.code, 'CONFIRMATION_REQUIRED');
  });

  await t.test('the voice console holds every voice setting', () => {
    // A voice setting that no console owns is a setting nobody can change.
    // The catalogue is the list of settings the application genuinely reads,
    // and the voice console owns every one of them that begins with voice.
    const settings = require(path.join(ROOT, 'src', 'services', 'settings'));
    const voiceKeys = settings.SCHEMA.map((s) => s.key).filter((k) => k.indexOf('voice.') === 0);
    const owned = new Set(settings.VOICE_OWNED);
    const unowned = voiceKeys.filter((key) => !owned.has(key));
    assert.deepEqual(unowned, [],
      'these voice settings are in the catalogue but no console owns them: '
      + unowned.join(', '));

    // And a console does not own a setting that does not exist.
    const known = new Set(settings.SCHEMA.map((s) => s.key));
    const stale = settings.VOICE_OWNED.filter((key) => !known.has(key));
    assert.deepEqual(stale, [],
      'the voice console owns settings that are not in the catalogue: '
      + stale.join(', '));
  });

  await t.test('a setting is declared once, not twice', () => {
    // The catalogue had the same setting in it twice, which made the
    // general page render it twice and the second copy win.
    const settings = require(path.join(ROOT, 'src', 'services', 'settings'));
    const seen = new Set();
    const duplicated = [];
    for (const entry of settings.SCHEMA) {
      if (seen.has(entry.key)) duplicated.push(entry.key);
      seen.add(entry.key);
    }
    assert.deepEqual(duplicated, [],
      'these settings are declared more than once: ' + duplicated.join(', '));
  });
});

test('the extension API version is not the application version', async (t) => {
  await t.test('it is declared on its own', () => {
    const version = require(path.join(ROOT, 'src', 'version'));
    assert.ok(version.EXTENSION_API_VERSION,
      'the extension API version is not declared');
    assert.equal(typeof version.EXTENSION_API_VERSION, 'string');
    assert.match(version.EXTENSION_API_VERSION, /^\d+\.\d+(\.\d+)?$/,
      'the extension API version is not a version: ' + version.EXTENSION_API_VERSION);
  });

  await t.test('changing the application version does not change it', () => {
    // The extension API version was the major and minor of the application
    // release, so every extension built against 3.0 was refused by a 3.6
    // instance with "this instance implements 3.6". The two are separate
    // contracts now, and this is the check that they stay separate.
    const source = fs.readFileSync(path.join(ROOT, 'src', 'services', 'extensions', 'packages.js'), 'utf8');
    assert.ok(!/VERSION\.split\('\. '\)/.test(source),
      'the extension API version is derived from the application version again');
    assert.ok(!/VERSION\.split\("\."\)/.test(source),
      'the extension API version is derived from the application version again');
  });

  await t.test('a package built against the extension API is still accepted', async () => {
    const packages = require(path.join(ROOT, 'src', 'services', 'extensions', 'packages'));
    const version = require(path.join(ROOT, 'src', 'version'));
    const report = packages.compatibilityReport({
      api: version.EXTENSION_API_VERSION,
    });
    assert.equal(report.ok, true,
      'a package built against this extension API was refused: '
      + report.reason);
  });

  await t.test('a package built against another generation is refused', () => {
    const packages = require(path.join(ROOT, 'src', 'services', 'extensions', 'packages'));
    const version = require(path.join(ROOT, 'src', 'version'));
    const parts = version.EXTENSION_API_VERSION.split('.');
    const other = (Number(parts[0]) + 1) + '.0';
    const report = packages.compatibilityReport({ api: other });
    assert.equal(report.ok, false, 'a package from another generation was accepted');
    assert.match(report.reason, /extension API/,
      'the refusal does not say what is wrong: ' + report.reason);
  });

  await t.test('a package built against a newer surface of this generation is refused', () => {
    const packages = require(path.join(ROOT, 'src', 'services', 'extensions', 'packages'));
    const version = require(path.join(ROOT, 'src', 'version'));
    const parts = version.EXTENSION_API_VERSION.split('.');
    const newer = parts[0] + '.' + (Number(parts[1]) + 1);
    const report = packages.compatibilityReport({ api: newer });
    assert.equal(report.ok, false, 'a package from a newer surface was accepted');
    assert.match(report.reason, /newer/,
      'the refusal does not say what is wrong: ' + report.reason);
  });
});
