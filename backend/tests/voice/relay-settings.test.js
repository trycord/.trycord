// The relay's own configuration.
//
// The relay is a service of the instance, and its configuration - the address
// it binds, the port it binds it on, the address the clients are given, the
// realm its credentials are issued in, and the key they are minted under -
// is a setting of the instance. An administrator changes it in the voice
// console, and the relay runs with what was changed.
//
// It used to be read from the environment and from nowhere else, so a
// console that showed a port was showing a number nobody read. That is the
// failure this checks for.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, registerUser } = require('../helpers/instance');

test('the relay runs with the configuration the instance saved', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const settings = require('../../src/services/settings');
  const config = require('../../src/services/voice/config');
  const registry = require('../../src/services/voice/registry');
  await settings.load();

  // What the relay runs with, before anything is saved.
  const before = config.inHouseRelay();
  assert.equal(Number(before.port), 3478, 'the relay did not start on the default port');
  assert.equal(before.realm, 'trycord-turn', 'the relay did not start on the default realm');

  // The console offers the relay's own settings, and only to the mesh.
  //
  // The mesh is the only provider that runs a relay, so a port that belonged
  // to the Cloudflare provider or to the third-party one would be a setting
  // that changes nothing.
  const described = registry.describe('mesh');
  const names = described.fields.map((field) => field.name);
  for (const name of ['turnPort', 'turnHost', 'turnRealm', 'publicUrl']) {
    assert.ok(names.indexOf(name) !== -1, 'the mesh console does not offer ' + name);
  }
  assert.ok(described.secrets.some((secret) => secret.name === 'stunkey'),
    'the mesh console does not offer the stunkey');

  const cloudflare = registry.describe('cloudflare');
  const cloudflareNames = cloudflare.fields.map((field) => field.name);
  assert.equal(cloudflareNames.indexOf('turnPort'), -1,
    'the Cloudflare console offers a port, and it runs no relay');

  // A saved value is the value the relay runs with.
  //
  // The write names the voice console as the owner, because that is the
  // console that owns these settings.
  const saved = await settings.save({
    'voice.mesh.turnPort': 3479,
    'voice.mesh.turnHost': '127.0.0.1',
    'voice.mesh.turnRealm': 'a-realm-of-its-own',
  }, owner.user.id, { owner: 'admin.voice' });
  assert.equal(saved.ok, true, 'the configuration was refused: '
    + (saved.problems || []).join('; '));

  const after = config.inHouseRelay();
  assert.equal(Number(after.port), 3479, 'the relay did not take the port that was saved');
  assert.equal(after.realm, 'a-realm-of-its-own', 'the relay did not take the realm that was saved');
  assert.equal(after.host, '127.0.0.1', 'the relay did not take the address that was saved');

  // The general configuration may write the same setting, and there is still
  // one row for it: the value the relay reads is the one that was written
  // last, whichever console wrote it.
  const written = await settings.save({ 'voice.mesh.turnPort': 3480 }, owner.user.id);
  assert.equal(written.ok, true, 'the general configuration could not write the setting');
  assert.equal(Number(config.inHouseRelay().port), 3480,
    'the relay did not take the value that was written');
});

test('the voice process shows the configuration and mints a credential', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  const voice = require('../../src/voice/index');
  const settings = require('../../src/services/settings');
  await settings.load();

  // The configuration page carries the relay's own settings.
  const page = voice.renderConfigPage({});
  for (const name of ['voice.mesh.turnHost', 'voice.mesh.turnPort', 'voice.mesh.turnRealm',
    'voice.mesh.publicUrl', 'voice.mesh.stunkey']) {
    assert.ok(page.indexOf(name) !== -1, 'the configuration page does not carry ' + name);
  }
  // The key is never shown, only whether one is set.
  assert.equal(page.indexOf('stunkey" type="password"') !== -1, true,
    'the key is not a masked field');

  // The credential page mints a credential, and shows it once.
  const minted = voice.renderCredentialsPage({
    credential: {
      username: '1792617932:a-host',
      password: '4dd3947eb3c5f1e4834728eec39102dc',
      realm: 'trycord-turn',
      hours: 24,
      url: 'turn:192.168.1.146:3478',
    },
    name: 'a-host',
    hours: 24,
  });
  assert.match(minted, /1792617932:a-host/);
  assert.match(minted, /4dd3947eb3c5f1e4834728eec39102dc/);
  assert.match(minted, /turn:192\.168\.1\.146:3478/);
});

test('a credential minted for the instance is the hash another host computes', async (t) => {
  const instance = await startInstance({ jobs: false, env: { TRYCORD_TURN_STUNKEY: 'a-stunkey-for-the-test-only' } });
  t.after(() => instance.stop());

  const turn = require('../../src/services/turn');
  const crypto = require('node:crypto');

  const minted = turn.issueCredentials('another-host', 3600);
  const expected = crypto.createHash('md5')
    .update(minted.username + ':trycord-turn:a-stunkey-for-the-test-only', 'utf8')
    .digest('hex');
  assert.equal(minted.password, expected,
    'the credential is not the hash a host with the stunkey would compute');
  assert.equal(minted.ttl, 3600);
});
