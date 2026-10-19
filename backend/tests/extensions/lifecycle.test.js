// The extension lifecycle: install, enable, disable, update, roll back,
// remove, and the capability grants in between.
//
// The claims being measured are the ones the feature makes: an install says
// what it is granting before it grants anything, a capability that was not
// granted is refused when the extension tries to use it, a disabled
// extension does nothing, a removed extension holds nothing, and every one
// of those acts is in the audit trail.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, writeRegistry, useMirror, messagesIn, community } = require('./support');

test('the extension lifecycle', async (t) => {
  const { db, admin, ext, close } = await start();
  t.after(() => close());

  const home = await community(admin, 'Lifecycle community');

  await t.test('the consent screen says what the package asks for', async () => {
    const res = await ext.admin.get('/api/extensions/registry/trycord.welcome');
    assert.equal(res.status, 200);
    assert.equal(res.data.package.id, 'trycord.welcome');
    assert.deepEqual(res.data.package.requestedCapabilities.sort(), ['members.read', 'messages.write']);
    assert.equal(res.data.package.reviewStatus, 'approved');
  });

  await t.test('an install without a grant list is refused', async () => {
    const res = await ext.admin.post('/api/extensions/install', { id: 'trycord.welcome' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VALIDATION_ERROR');
    assert.match(res.data.error.message, /capabilities to grant/);
  });

  await t.test('an install grants only what it asked for', async () => {
    const res = await ext.admin.post('/api/extensions/install', {
      id: 'trycord.welcome',
      grants: ['members.read'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.deepEqual(res.data.requested.sort(), ['members.read', 'messages.write']);
    assert.deepEqual(res.data.granted, ['members.read']);
    assert.equal(res.data.extension.state, 'installed');

    const installed = await ext.admin.get('/api/extensions/installed');
    const welcome = installed.data.extensions.find((e) => e.id === 'trycord.welcome');
    assert.ok(welcome, 'the extension should be listed');
    assert.deepEqual(welcome.grants, ['members.read'], 'only the granted capability is held');
  });

  await t.test('a capability that was not granted is refused when the extension uses it', async () => {
    await ext.admin.post('/api/extensions/trycord.welcome/enable');

    const res = await ext.admin.post('/api/extensions/events', {
      type: 'member.joined',
      payload: { id: 'join-1', serverId: home.serverId, userId: 'someone' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const dispatched = res.data.dispatched.find((d) => d.workflowId);
    assert.ok(dispatched, 'the extension should have been woken: ' + JSON.stringify(res.data));
    assert.equal(dispatched.status, 'failed');

    const detail = await ext.admin.get('/api/extensions/workflows/runs/' + dispatched.runId);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.run.status, 'failed');
    const step = detail.data.steps.find((s) => s.action === 'message.post');
    assert.ok(step, 'the posting step should have been recorded');
    assert.equal(step.status, 'failed');
    assert.match(step.error, /has not been granted the capability "messages.write"/);

    const posted = await messagesIn(db, home.channelId);
    assert.equal(posted.length, 0, 'nothing should have been posted');
  });

  await t.test('granting the capability lets the extension act, and revoking it stops it again', async () => {
    const granted = await ext.admin.post('/api/extensions/trycord.welcome/grants', {
      capability: 'messages.write',
      reason: 'the operator agreed',
    });
    assert.equal(granted.status, 200);

    const res = await ext.admin.post('/api/extensions/events', {
      type: 'member.joined',
      payload: { id: 'join-2', serverId: home.serverId, userId: 'someone' },
    });
    const dispatched = res.data.dispatched.find((d) => d.workflowId);
    assert.equal(dispatched.status, 'succeeded');
    const posted = await messagesIn(db, home.channelId);
    assert.equal(posted.length, 1, 'the greeting should have been posted');
    assert.match(posted[0].content, /Welcome to the community/);

    const revoked = await ext.admin.del('/api/extensions/trycord.welcome/grants/messages.write');
    assert.equal(revoked.status, 200);

    const after = await ext.admin.post('/api/extensions/events', {
      type: 'member.joined',
      payload: { id: 'join-3', serverId: home.serverId, userId: 'someone' },
    });
    const refused = after.data.dispatched.find((d) => d.workflowId);
    assert.equal(refused.status, 'failed');
    const detail = await ext.admin.get('/api/extensions/workflows/runs/' + refused.runId);
    assert.match(detail.data.steps.find((s) => s.action === 'message.post').error,
      /has not been granted the capability "messages.write"/);
    assert.equal((await messagesIn(db, home.channelId)).length, 1, 'nothing more should have been posted');
  });

  await t.test('a disabled extension does nothing', async () => {
    await ext.admin.post('/api/extensions/trycord.welcome/grants', { capability: 'messages.write' });
    const disabled = await ext.admin.post('/api/extensions/trycord.welcome/disable');
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.extension.state, 'disabled');

    const res = await ext.admin.post('/api/extensions/events', {
      type: 'member.joined',
      payload: { id: 'join-4', serverId: home.serverId, userId: 'someone' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.dispatched.length, 0, 'a disabled extension should not be woken');
    assert.equal((await messagesIn(db, home.channelId)).length, 1);
  });

  await t.test('a removed extension holds nothing and is gone', async () => {
    const removed = await ext.admin.del('/api/extensions/trycord.welcome');
    assert.equal(removed.status, 200);
    assert.equal(removed.data.extension.state, 'removed');

    const detail = await ext.admin.get('/api/extensions/trycord.welcome');
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.extension.grants.filter((g) => g.active), [],
      'a removed extension should hold no capability');
  });

  await t.test('every act is in the audit trail', async () => {
    const rows = await db.all(
      'SELECT action, target_type, target_id FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at',
      ['extension', 'trycord.welcome']
    );
    const actions = rows.map((r) => r.action);
    for (const expected of [
      'EXTENSION_INSTALLED',
      'EXTENSION_ENABLED',
      'EXTENSION_DISABLED',
      'EXTENSION_REMOVED',
      'EXTENSION_CAPABILITY_GRANTED',
      'EXTENSION_CAPABILITY_REVOKED',
    ]) {
      assert.ok(actions.includes(expected), 'the audit trail should record ' + expected + ': ' + actions.join(', '));
    }
  });
});

test('an extension can be updated and rolled back', async (t) => {
  const { admin, ext, close } = await start();
  t.after(() => close());

  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-registry-'));
  const packageDocument = (version, body) => ({
    id: 'test.rollback',
    name: 'Rollback test',
    version,
    description: 'A package with two versions.',
    author: 'Test',
    maintainers: ['Test'],
    capabilities: ['messages.write'],
    compatibility: { api: '3.0', minInstance: '3.0.0', maxInstance: null },
    dependencies: {},
    trusted: false,
    reviewStatus: 'approved',
    triggers: [{
      event: 'message.created',
      conditions: [],
      steps: [{ type: 'action', action: 'log', params: { message: body } }],
    }],
  });

  writeRegistry(registryDir, [packageDocument('1.0.0', 'the first version')]);
  await useMirror(ext.admin, registryDir);

  await t.test('the first version installs', async () => {
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.rollback', grants: ['messages.write'] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.extension.version, '1.0.0');
  });

  await t.test('a newer version updates it, and the old one is still on record', async () => {
    writeRegistry(registryDir, [packageDocument('1.1.0', 'the second version')]);
    const res = await ext.admin.post('/api/extensions/test.rollback/update', {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.extension.version, '1.1.0');

    const detail = await ext.admin.get('/api/extensions/test.rollback');
    const versions = detail.data.extension.versions.map((v) => v.version).sort();
    assert.deepEqual(versions, ['1.0.0', '1.1.0']);
  });

  await t.test('a rollback puts the earlier version back', async () => {
    const res = await ext.admin.post('/api/extensions/test.rollback/rollback', { version: '1.0.0' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.extension.version, '1.0.0');

    const detail = await ext.admin.get('/api/extensions/test.rollback');
    const rolled = detail.data.extension.versions.find((v) => v.version === '1.0.0');
    assert.equal(rolled.manifest.triggers[0].steps[0].params.message, 'the first version',
      'the manifest of the version rolled back to should be the one that was approved');
  });
});

test('a package that needs something this instance does not have is refused', async (t) => {
  const { ext, close } = await start();
  t.after(() => close());

  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-registry-'));
  const base = {
    name: 'Needs a dependency',
    description: 'A package that needs another one.',
    capabilities: [],
    compatibility: { api: '3.0', minInstance: '3.0.0', maxInstance: null },
    trusted: false,
    reviewStatus: 'approved',
    triggers: [],
  };
  writeRegistry(registryDir, [
    Object.assign({}, base, { id: 'test.needs', version: '1.0.0', dependencies: { 'test.missing': '^1.0.0' } }),
    Object.assign({}, base, { id: 'test.missing', version: '1.0.0', dependencies: {} }),
  ]);
  await useMirror(ext.admin, registryDir);

  await t.test('the reason says which dependency is missing', async () => {
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.needs', grants: [] });
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.match(res.data.error.message, /test\.missing/);
    assert.match(res.data.error.message, /not installed/);
  });

  await t.test('a dependency that is installed but not enabled is still a refusal', async () => {
    const first = await ext.admin.post('/api/extensions/install', { id: 'test.missing', grants: [] });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const second = await ext.admin.post('/api/extensions/install', { id: 'test.needs', grants: [] });
    assert.equal(second.status, 400);
    assert.match(second.data.error.message, /installed but/);
  });

  await t.test('a dependency that is present and enabled is accepted', async () => {
    await ext.admin.post('/api/extensions/test.missing/enable');
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.needs', grants: [] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
  });
});
