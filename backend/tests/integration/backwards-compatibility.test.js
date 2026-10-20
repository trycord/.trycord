// What the older clients still do.
//
// Everything in this file worked before the 3.6 release, and it has to keep
// working. A change that fixes a fault is allowed to change what it fixes;
// it is not allowed to break the things that were already right.
//
// The three that mattered here:
//
//   1. A client that writes the voice settings through the general settings
//      route. The voice console used to write there, an older bundle still
//      in a browser's cache still writes there, and the native app may
//      write there. The general route refuses nothing, because it is an
//      existing public API and narrowing it breaks every one of those
//      clients at once.
//
//   2. A client that reads the general catalogue. It now carries the voice
//      settings with the console that owns them named, and that is additive:
//      the settings are still there, in the same shape.
//
//   3. An extension package built against the version the instance was
//      running. The extension API version used to be the application
//      version, so every package declared the application version it was
//      built for, and the packages that installed on a 3.6 instance
//      declared "3.6". Those have to keep installing.
//
// The rule everywhere: a new route may be narrow, an old route may not
// become narrow, and a check may only ever accept more than it used to.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startInstance, registerUser } = require('../helpers/instance');

const ROOT = path.join(__dirname, '..', '..');

test('what the older clients still do', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');

  await t.test('the general route still writes the voice settings', async () => {
    // This is the call the voice console used to make, and the one an older
    // bundle still makes.
    const res = await owner.put('/api/admin/settings', {
      __confirm: true,
      'voice.provider': 'mesh',
      'voice.mesh.maxParticipants': 7,
    });
    assert.equal(res.status, 200,
      'the general route refused a write that worked before: ' + JSON.stringify(res.data));

    // And the value is in force.
    const catalogue = await owner.get('/api/admin/voice/settings');
    const entry = catalogue.data.settings.find((s) => s.key === 'voice.mesh.maxParticipants');
    assert.equal(entry.value, 7, 'the write did not take');
  });

  await t.test('the general route still writes the general settings', async () => {
    const res = await owner.put('/api/admin/settings', { 'instance.name': 'Still Works' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const catalogue = await owner.get('/api/admin/settings');
    const entry = catalogue.data.categories
      .flatMap((category) => category.settings || [])
      .find((s) => s.key === 'instance.name');
    assert.equal(entry.value, 'Still Works');
  });

  await t.test('the general route still resets a voice setting', async () => {
    const res = await owner.delete('/api/admin/settings/voice.mesh.maxParticipants');
    assert.equal(res.status, 200,
      'the general route refused a reset that worked before: ' + JSON.stringify(res.data));
  });

  await t.test('the general catalogue still carries the voice settings', async () => {
    const res = await owner.get('/api/admin/settings');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const keys = res.data.categories.flatMap((category) => category.settings || []).map((s) => s.key);
    for (const key of ['voice.enabled', 'voice.provider', 'voice.screenSharing', 'voice.stageChannels']) {
      assert.ok(keys.indexOf(key) !== -1,
        'the general catalogue no longer carries ' + key);
    }
  });

  await t.test('the general catalogue says which console owns a voice setting', async () => {
    // The new fields are additive: a client that does not know them reads
    // the catalogue exactly as it did before.
    const res = await owner.get('/api/admin/settings');
    const entry = res.data.categories
      .flatMap((category) => category.settings || [])
      .find((s) => s.key === 'voice.provider');
    assert.equal(entry.canonical, 'admin.voice');
    // And the fields a client reads are all still there.
    for (const field of ['key', 'label', 'description', 'type', 'value', 'defaultValue', 'source', 'live']) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, field),
        'the catalogue entry no longer carries ' + field);
    }
  });

  await t.test('the voice console refuses a setting it does not own', async () => {
    // The new route may be narrow. It is new, so nothing depends on it
    // being wide.
    const res = await owner.put('/api/admin/voice/settings', { 'instance.name': 'Not Yours' });
    assert.equal(res.status, 400, 'the voice console changed the general configuration');
  });

  await t.test('the enforcement answer carries both names', async () => {
    // The answer used to carry `type`. It carries `type` still, and it
    // carries `actionType` as well, so a caller that reads either name
    // finds what it expects.
    const member = await registerUser(instance, 'member');
    const res = await owner.post('/api/admin/users/' + member.user.id + '/enforce', {
      actionType: 'WARNING',
      reason: 'A warning',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.actionType, 'WARNING', 'the answer has no actionType');
    assert.equal(res.data.type, 'WARNING', 'the answer has no type');
  });
});

test('the extension API accepts everything it accepted before', async (t) => {
  const packages = require(path.join(ROOT, 'src', 'services', 'extensions', 'packages'));
  const version = require(path.join(ROOT, 'src', 'version'));

  await t.test('a package that declares the application version is accepted', () => {
    // Before the extension API had a version of its own, the check was
    // "does this package declare the application version?". So a package
    // that declares the application version installed, and it has to keep
    // installing - otherwise every extension people had was uninstalled by
    // the fix.
    const application = version.VERSION.split('.').slice(0, 2).join('.');
    const report = packages.compatibilityReport({ api: application });
    assert.equal(report.ok, true,
      'a package built against the application version was refused: ' + report.reason);
  });

  await t.test('a package that declares the extension surface is accepted', () => {
    const report = packages.compatibilityReport({ api: version.EXTENSION_API_VERSION });
    assert.equal(report.ok, true, report.reason);
  });

  await t.test('every version the old rule accepted is still accepted', () => {
    // The old rule was exact equality with the application version, so the
    // old rule accepted exactly one version. The new rule has to accept
    // that one, and it does.
    const application = version.VERSION.split('.').slice(0, 2).join('.');
    assert.equal(packages.compatibilityReport({ api: application }).ok, true);
  });

  await t.test('a version the old rule refused is still refused', () => {
    // The old rule refused anything that was not the application version,
    // including another generation and a newer version of this one.
    const application = version.VERSION.split('.').slice(0, 2).join('.');
    const parts = application.split('.');
    assert.equal(packages.compatibilityReport({ api: (Number(parts[0]) + 1) + '.0' }).ok, false,
      'another generation was accepted');
    assert.equal(packages.compatibilityReport({ api: parts[0] + '.' + (Number(parts[1]) + 1) }).ok, false,
      'a newer version of this generation was accepted');
    assert.equal(packages.compatibilityReport({ api: '9.9' }).ok, false,
      'a version from the future was accepted');
  });

  await t.test('the rule is never narrower than the one it replaced', () => {
    // Every version in the generation, at or below the application version,
    // is accepted. That is a superset of the old rule.
    const application = version.VERSION.split('.').slice(0, 2).join('.');
    const major = Number(application.split('.')[0]);
    const minor = Number(application.split('.')[1]);
    for (let m = 0; m <= minor; m++) {
      const api = major + '.' + m;
      assert.equal(packages.compatibilityReport({ api }).ok, true,
        'extension API ' + api + ' was refused, and the old rule accepted '
        + application);
    }
  });
});

test('the instance answers its own origin', async (t) => {
  const { corsOptions, originCovers } = require(path.join(ROOT, 'src', 'origins'));

  await t.test('the cors options still work without the instance\'s own origin', async () => {
    // The second argument is new and optional. A caller that passes only the
    // allowlist - which is what every caller did before - still works.
    const options = corsOptions(['https://trycord.dev']);
    const allowed = await new Promise((resolve) => {
      options.origin('https://trycord.dev', (err, ok) => resolve(ok));
    });
    assert.equal(allowed, true, 'the allowlist stopped working');
  });

  await t.test('the instance\'s own origin is answered', async () => {
    const allowed = [];
    const options = corsOptions(['https://trycord.dev'], ['https://api.trycord.dev']);
    await new Promise((resolve) => {
      options.origin('https://api.trycord.dev', (err, ok) => { allowed.push(ok); resolve(); });
    });
    assert.equal(allowed[0], true, 'the instance refused its own origin');
  });

  await t.test('an origin that is not on the list is still refused', async () => {
    const allowed = [];
    const options = corsOptions(['https://trycord.dev'], ['https://api.trycord.dev']);
    await new Promise((resolve) => {
      options.origin('https://elsewhere.example', (err, ok) => { allowed.push(ok); resolve(); });
    });
    assert.equal(allowed[0], false, 'an origin that is not on the list was allowed');
  });

  await t.test('the instance\'s own origin is covered by the same rules', () => {
    assert.equal(originCovers('https://api.trycord.dev', 'https://api.trycord.dev'), true);
    assert.equal(originCovers('https://api.trycord.dev', 'https://other.trycord.dev'), false);
  });
});
