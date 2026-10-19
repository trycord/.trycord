// The registry: optional, mirrorable, and never a dependency of the instance.
//
// The claims being measured: an unreachable registry costs the operator a
// package list and nothing else; a restricted registry installs only what it
// is allowed to; an unreviewed package is refused unless the operator says
// otherwise; an approved one installs; and a signature is really checked
// when the operator asks for that.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, writeRegistry, useMirror } = require('./support');

const SECRET = 'a-shared-secret-the-operator-and-the-publisher-both-hold';

function packageDocument(overrides) {
  return Object.assign({
    id: 'test.package',
    name: 'A test package',
    version: '1.0.0',
    description: 'A package for the registry tests.',
    author: 'Test',
    maintainers: ['Test'],
    capabilities: [],
    compatibility: { api: '3.0', minInstance: '3.0.0', maxInstance: null },
    dependencies: {},
    trusted: false,
    reviewStatus: 'approved',
    triggers: [],
  }, overrides || {});
}

test('the registry is optional and the instance does not depend on it', async (t) => {
  const { admin, ext, close } = await start();
  t.after(() => close());

  await t.test('with no registry configured the core API still works', async () => {
    const policy = await ext.admin.put('/api/extensions/policy', { registryMode: 'disabled' });
    assert.equal(policy.status, 200);
    assert.equal(policy.data.policy.registryMode, 'disabled');

    const me = await admin.get('/api/users/me');
    assert.equal(me.status, 200, 'the core API should answer');
    assert.equal(me.data.username, 'root');

    const registry = await ext.admin.get('/api/extensions/registry');
    assert.equal(registry.status, 200);
    assert.equal(registry.data.registry.available, false);
    assert.deepEqual(registry.data.registry.extensions, []);
  });

  await t.test('with an unreachable registry the core API still works', async () => {
    // A mirror at a port nothing is listening on.
    const policy = await ext.admin.put('/api/extensions/policy', {
      registryMode: 'mirror',
      registryUrl: 'http://127.0.0.1:1/registry.json',
    });
    assert.equal(policy.status, 200);

    const registry = await ext.admin.get('/api/extensions/registry?refresh=1');
    assert.equal(registry.status, 200, 'the registry endpoint should answer, not fall over');
    assert.equal(registry.data.registry.available, false);
    assert.ok(registry.data.registry.error, 'the failure should be reported');

    const me = await admin.get('/api/users/me');
    assert.equal(me.status, 200, 'the core API should answer');
    const created = await admin.post('/api/servers', { name: 'Still working' });
    assert.equal(created.status, 200, 'messaging should still work');
  });

  await t.test('a workflow still runs with the registry unreachable', async () => {
    const created = await ext.admin.post('/api/extensions/workflows', {
      name: 'No registry needed',
      trigger: { type: 'manual' },
      steps: [{ type: 'action', action: 'log', params: { message: 'it ran' } }],
      grants: [],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const ran = await ext.admin.post('/api/extensions/workflows/' + created.data.workflow.id + '/run', {});
    assert.equal(ran.status, 200);
    assert.equal(ran.data.run.status, 'succeeded');
  });
});

test('a restricted registry installs only what it is allowed to', async (t) => {
  const { ext, close } = await start();
  t.after(() => close());

  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-registry-'));
  writeRegistry(registryDir, [
    packageDocument({ id: 'test.allowed' }),
    packageDocument({ id: 'test.notallowed' }),
  ]);

  await t.test('the allowlist is honoured', async () => {
    await useMirror(ext.admin, registryDir, { allowlist: ['test.allowed'] });

    const refused = await ext.admin.post('/api/extensions/install', { id: 'test.notallowed', grants: [] });
    assert.equal(refused.status, 403, JSON.stringify(refused.data));
    assert.match(refused.data.error.message, /allowlist/);

    const allowed = await ext.admin.post('/api/extensions/install', { id: 'test.allowed', grants: [] });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
  });

  await t.test('the listing says which of them may be installed', async () => {
    const listing = await ext.admin.get('/api/extensions/registry?refresh=1');
    assert.equal(listing.status, 200);
    const notAllowed = listing.data.registry.extensions.find((e) => e.id === 'test.notallowed');
    assert.equal(notAllowed.installable, false);
    assert.match(notAllowed.reason, /allowlist/);
  });
});

test('only reviewed packages are installed, unless the operator says otherwise', async (t) => {
  const { ext, close } = await start();
  t.after(() => close());

  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-registry-'));
  writeRegistry(registryDir, [
    packageDocument({ id: 'test.unreviewed', reviewStatus: 'unreviewed' }),
    packageDocument({ id: 'test.approved', reviewStatus: 'approved' }),
    packageDocument({ id: 'test.rejected', reviewStatus: 'rejected' }),
  ]);
  await useMirror(ext.admin, registryDir);

  await t.test('an unreviewed package is refused by default', async () => {
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.unreviewed', grants: [] });
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.match(res.data.error.message, /unreviewed/);
  });

  await t.test('a rejected package is refused even when unreviewed ones are allowed', async () => {
    await useMirror(ext.admin, registryDir, { allowUnreviewed: true });
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.rejected', grants: [] });
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.match(res.data.error.message, /rejected/);
  });

  await t.test('an unreviewed package installs when the operator allows it', async () => {
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.unreviewed', grants: [] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
  });

  await t.test('an approved package installs', async () => {
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.approved', grants: [] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
  });
});

test('a signature is really checked when the instance asks for one', async (t) => {
  const { ext, close } = await start();
  t.after(() => close());

  const signature = require('../../src/services/extensions/signature');
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-registry-'));

  const signed = packageDocument({ id: 'test.signed' });
  signed.signature = { keyId: 'key-1', algorithm: 'hmac-sha256', value: signature.signHmac(signed, SECRET) };
  const tampered = packageDocument({ id: 'test.tampered' });
  tampered.signature = { keyId: 'key-1', algorithm: 'hmac-sha256', value: signature.signHmac(tampered, SECRET) };
  // The document was changed after it was signed.
  tampered.description = 'Something else entirely.';

  writeRegistry(registryDir, [signed, tampered]);

  await t.test('an instance that does not require signatures installs the package', async () => {
    await useMirror(ext.admin, registryDir);
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.signed', grants: [] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
  });

  await t.test('an instance that requires a verified signature refuses one that does not have it', async () => {
    await useMirror(ext.admin, registryDir, {
      requireSignature: true,
      signingKeys: { 'key-1': { type: 'hmac-sha256', secret: SECRET } },
    });
    const unsigned = packageDocument({ id: 'test.unsigned' });
    writeRegistry(registryDir, [unsigned]);

    const res = await ext.admin.post('/api/extensions/install', { id: 'test.unsigned', grants: [] });
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.match(res.data.error.message, /verified signature/);
  });

  await t.test('a package whose signature does not match is refused', async () => {
    writeRegistry(registryDir, [tampered]);
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.tampered', grants: [] });
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.match(res.data.error.message, /verified signature/);
  });

  await t.test('a package with a good signature is accepted and reported as verified', async () => {
    const second = packageDocument({ id: 'test.signed-again' });
    second.signature = { keyId: 'key-1', algorithm: 'hmac-sha256', value: signature.signHmac(second, SECRET) };
    writeRegistry(registryDir, [second]);
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.signed-again', grants: [] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.signature.status, 'verified');
  });

  await t.test('the shipped first-party packages carry no signature, and say so', async () => {
    await useMirror(ext.admin, registryDir, { registryMode: 'builtin' });
    const listing = await ext.admin.get('/api/extensions/registry?refresh=1');
    assert.equal(listing.status, 200);
    const welcome = listing.data.registry.extensions.find((e) => e.id === 'trycord.welcome');
    assert.ok(welcome, 'the first-party registry should be served');
    assert.equal(welcome.signature.status, 'unsigned');
  });
});
