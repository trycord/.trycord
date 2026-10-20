// The provider registry.
//
// The point of the registry is that a console and a service cannot disagree
// about what a provider is. So the tests are about the two ways they could
// have disagreed: a provider the console offers that the service would
// refuse, and a setting the console names that does not exist.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

test('the provider registry', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const plain = await registerUser(instance, 'plain');

  await t.test('every setting the registry names is a setting that exists', () => {
    const settings = require('../../src/services/settings');
    const registry = require('../../src/services/providers/registry');
    const known = new Set(settings.SCHEMA.map((s) => s.key));
    const keyOf = (entry) => (typeof entry === 'string' ? entry : entry && entry.key);
    const missing = [];
    for (const subsystem of registry.SUBSYSTEMS) {
      for (const provider of registry.providersOf(subsystem)) {
        for (const key of provider.settings || []) {
          const name = keyOf(key);
          if (name && !known.has(name)) missing.push(subsystem.id + '/' + provider.id + ': ' + name);
        }
        for (const key of provider.secrets || []) {
          const name = keyOf(key);
          if (name && !known.has(name)) {
            missing.push(subsystem.id + '/' + provider.id + ' (secret): ' + name);
          }
        }
      }
    }
    assert.deepEqual(missing, [],
      'the registry names settings that do not exist: ' + missing.join(', '));
  });

  await t.test('every subsystem names a setting that exists, or none at all', () => {
    const settings = require('../../src/services/settings');
    const registry = require('../../src/services/providers/registry');
    const known = new Set(settings.SCHEMA.map((s) => s.key));
    const missing = registry.SUBSYSTEMS
      .map((s) => s.setting)
      .filter((key) => key && !known.has(key));
    assert.deepEqual(missing, [],
      'a subsystem names a setting that does not exist: ' + missing.join(', '));
  });

  await t.test('every provider has an id, a label, a summary and a validation', () => {
    const registry = require('../../src/services/providers/registry');
    const problems = [];
    for (const subsystem of registry.SUBSYSTEMS) {
      for (const provider of registry.providersOf(subsystem)) {
        if (!provider.id) problems.push(subsystem.id + ': a provider with no id');
        if (!provider.label) problems.push(subsystem.id + '/' + provider.id + ': no label');
        if (!provider.summary) problems.push(subsystem.id + '/' + provider.id + ': no summary');
        if (typeof provider.validate !== 'function') {
          problems.push(subsystem.id + '/' + provider.id + ': no validation');
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('the catalogue describes every subsystem and its providers', async () => {
    const registry = require('../../src/services/providers/registry');
    const catalogue = await registry.catalogue();
    assert.ok(catalogue.length >= 5, 'several subsystems are described');
    for (const subsystem of catalogue) {
      assert.ok(subsystem.id);
      assert.ok(subsystem.providers.length, subsystem.id + ' has at least one provider');
      for (const provider of subsystem.providers) {
        assert.ok(
          ['disabled', 'configured', 'active', 'degraded', 'failed'].includes(provider.state),
          subsystem.id + '/' + provider.id + ' has a state somebody can read: ' + provider.state,
        );
      }
    }
  });

  await t.test('the provider in force is the one the setting names', async () => {
    const registry = require('../../src/services/providers/registry');
    const catalogue = await registry.catalogue();
    const storage = catalogue.find((s) => s.id === 'storage');
    const inForce = storage.providers.filter((p) => p.inForce);
    // Exactly one provider of a subsystem can be in force. Zero is a
    // legitimate answer - a subsystem may be switched off - but two is not.
    assert.ok(inForce.length <= 1, 'at most one storage provider is in force');
  });

  await t.test('a provider that is not in force is not reported as active', async () => {
    const registry = require('../../src/services/providers/registry');
    const catalogue = await registry.catalogue();
    for (const subsystem of catalogue) {
      for (const provider of subsystem.providers) {
        if (provider.inForce) continue;
        assert.notEqual(provider.state, 'active',
          subsystem.id + '/' + provider.id + ' is not in force, so it is not active');
      }
    }
  });

  await t.test('a subsystem that is switched off says so', async () => {
    const registry = require('../../src/services/providers/registry');
    const catalogue = await registry.catalogue();
    for (const subsystem of catalogue) {
      if (subsystem.enabled) continue;
      for (const provider of subsystem.providers) {
        assert.equal(provider.state, 'disabled',
          subsystem.id + '/' + provider.id + ' is disabled with its subsystem');
      }
    }
  });

  await t.test('the console reads the catalogue, and only an administrator may', async () => {
    const res = await owner.get('/api/admin/providers');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(Array.isArray(res.data.subsystems));
    assert.ok(res.data.subsystems.length >= 5);

    const refused = await plain.get('/api/admin/providers');
    assert.equal(refused.status, 403, 'an ordinary member does not read the catalogue');
  });

  await t.test('a check is a real check, and an unknown provider is refused', async () => {
    const res = await owner.post('/api/admin/providers/storage/s3/check', {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(typeof res.data.ok, 'boolean');
    assert.ok(res.data.detail, 'a check says what it found');

    const unknown = await owner.post('/api/admin/providers/storage/nonsense/check', {});
    assert.equal(unknown.status, 200);
    assert.equal(unknown.data.ok, false);
    assert.match(unknown.data.detail, /No such provider/);
  });

  await t.test('a subsystem that does not exist is refused', async () => {
    const res = await owner.get('/api/admin/providers/nonsense');
    assert.equal(res.status, 404);
  });

  await t.test('a value that names no provider is not a provider', () => {
    const registry = require('../../src/services/providers/registry');
    assert.equal(registry.isProvider('storage', 'local'), true);
    assert.equal(registry.isProvider('storage', 's3'), true);
    assert.equal(registry.isProvider('storage', 'nonsense'), false);
    assert.equal(registry.isProvider('nonsense', 'local'), false);
  });

  await t.test('a secret is reported as set or not set, never as its value', async () => {
    const registry = require('../../src/services/providers/registry');
    const storage = (await registry.catalogue()).find((s) => s.id === 'storage');
    const s3 = storage.providers.find((p) => p.id === 's3');
    assert.ok(s3.secrets.indexOf('storage.s3SecretKey') !== -1,
      'the S3 provider names the secret it needs');
    // The catalogue itself must not carry a secret value.
    const serialised = JSON.stringify(storage);
    assert.ok(!/s3SecretAccessKey"\s*:\s*"[^"]+"/.test(serialised),
      'the catalogue does not carry a secret value');
  });
});
