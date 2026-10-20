// The run history of an extension's workflow.
//
// An extension's workflow *definition* may be read by anybody - that is the
// design, and it is what lets a reader see what an installed extension does.
// Its run history is a different thing: a run records the event that woke it,
// and the payload of a message event carries the message.
//
// The route that lists a workflow's runs reused the rule that governs reading
// the workflow, so every signed-in account could read the history of every
// extension - and therefore the content of the messages that flowed through
// it. The single-run route already applied the right rule (the owner and the
// administrator); the list route now applies the same one.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, writeRegistry, useMirror } = require('../extensions/support');

test('the run history of an extension is the operator\'s', async (t) => {
  const { db, admin, ext, close } = await start();
  t.after(() => close());

  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-registry-'));
  writeRegistry(registryDir, [{
    id: 'test.trusted',
    name: 'A trusted package',
    version: '1.0.0',
    description: 'A package that runs code on the server.',
    author: 'Test',
    maintainers: ['Test'],
    capabilities: [],
    compatibility: { api: '3.0', minInstance: '3.0.0', maxInstance: null },
    dependencies: {},
    trusted: true,
    reviewStatus: 'approved',
    entry: { file: 'index.js', source: 'return { ok: true };' },
    triggers: [{ event: 'message.created', conditions: [], steps: [{ type: 'code' }] }],
  }]);
  await useMirror(ext.admin, registryDir, { allowTrusted: true });

  const installed = await ext.admin.post('/api/extensions/install', { id: 'test.trusted', grants: [] });
  assert.equal(installed.status, 201, JSON.stringify(installed.data));
  await ext.admin.post('/api/extensions/test.trusted/enable');

  const workflows = await db.all('SELECT id FROM workflows WHERE extension_id = ?', ['test.trusted']);
  assert.equal(workflows.length, 1, 'the package should have created one workflow');
  const workflowId = workflows[0].id;

  // A message event whose payload carries the content of the message.
  const secret = 'the sentence that should not be readable by a stranger';
  const published = await ext.admin.post('/api/extensions/events', {
    type: 'message.created',
    payload: { id: 'message-1', serverId: 'server-1', channelId: 'channel-1', content: secret },
  });
  assert.equal(published.status, 200, JSON.stringify(published.data));

  await t.test('the operator reads the history', async () => {
    const res = await ext.admin.get('/api/extensions/workflows/' + workflowId + '/runs');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.runs.length >= 1);
    assert.ok(JSON.stringify(res.data.runs).includes(secret),
      'the operator should see the payload the run recorded');
  });

  await t.test('another account does not', async () => {
    const res = await ext.stranger.get('/api/extensions/workflows/' + workflowId + '/runs');
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'PERMISSION_DENIED');
    assert.ok(!JSON.stringify(res.data).includes(secret),
      'the run history must not leak to another account');
  });

  await t.test('the single run is refused as well', async () => {
    const runs = await db.all(
      'SELECT id FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1',
      [workflowId]
    );
    assert.equal(runs.length, 1);
    const res = await ext.stranger.get('/api/extensions/workflows/runs/' + runs[0].id);
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.ok(!JSON.stringify(res.data).includes(secret),
      'the run must not leak to another account');
  });

  await t.test('the definition is still readable, which is the design', async () => {
    const res = await ext.stranger.get('/api/extensions/workflows/' + workflowId);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.workflow.id, workflowId);
  });
});
