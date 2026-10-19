// The sandbox: what it actually keeps out, and what it actually stops.
//
// These are the claims the documentation makes, measured. The isolation
// probes are the ones that matter: a sandboxed extension must not be able to
// reach the host's require, the host's process, or anything the host has put
// on its global object.
//
// What the sandbox does not promise is written down in docs/extensions.md,
// and it is not claimed here either: this file proves the routes that are
// closed are closed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, writeRegistry, useMirror } = require('./support');

test('the extension sandbox', async (t) => {
  const { close } = await start();
  t.after(() => close());

  const sandbox = require('../../src/services/extensions/sandbox');
  const bridge = require('../../src/services/extensions/bridge');

  await t.test('a sandboxed extension cannot reach require, process or the host global', async () => {
    // A secret on the host's global object. The sandbox must not be able to
    // see it, and must not be able to reach the object that holds it.
    globalThis.__TRYCDORD_TEST_SECRET__ = 'the-host-secret';
    try {
      const result = await sandbox.run({
        code: `
          const probes = {};
          probes.require = typeof require;
          probes.process = typeof process;
          probes.module = typeof module;
          probes.secret = typeof globalThis.__TRYCDORD_TEST_SECRET__;
          probes.globalThisIsHost = (globalThis === (function () { return this; })());
          try { globalThis.constructor.constructor('return process')(); probes.constructorEscape = 'not blocked'; }
          catch (e) { probes.constructorEscape = 'blocked: ' + e.name; }
          try { eval('1 + 1'); probes.eval = 'not blocked'; }
          catch (e) { probes.eval = 'blocked: ' + e.name; }
          try { new Function('return process')(); probes.functionConstructor = 'not blocked'; }
          catch (e) { probes.functionConstructor = 'blocked: ' + e.name; }
          try { (async () => {}).constructor('return process')(); probes.asyncConstructor = 'not blocked'; }
          catch (e) { probes.asyncConstructor = 'blocked: ' + e.name; }
          return probes;
        `,
        host: async () => ({ ok: true }),
        limits: { timeoutMs: 5000 },
      });

      assert.equal(result.ok, true, 'the extension should have run: ' + result.error);
      const probes = result.output;
      assert.equal(probes.require, 'undefined');
      assert.equal(probes.process, 'undefined');
      assert.equal(probes.module, 'undefined');
      assert.equal(probes.secret, 'undefined');
      assert.match(probes.constructorEscape, /^blocked: /);
      assert.match(probes.eval, /^blocked: /);
      assert.match(probes.functionConstructor, /^blocked: /);
      assert.match(probes.asyncConstructor, /^blocked: /);
    } finally {
      delete globalThis.__TRYCDORD_TEST_SECRET__;
    }
  });

  await t.test('a runaway extension is stopped at its timeout', async () => {
    const started = Date.now();
    const result = await sandbox.run({
      code: 'while (true) { /* burn */ }',
      host: async () => ({ ok: true }),
      limits: { timeoutMs: 400 },
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 5000, 'the run should have been stopped promptly, took ' + elapsed + 'ms');
  });

  await t.test('a call budget is enforced', async () => {
    const budget = {
      limit: 3,
      used: 0,
      consume() {
        if (this.used >= this.limit) throw new Error('the run used its whole budget of ' + this.limit + ' calls');
        this.used += 1;
      },
    };
    const host = bridge.createHost({ grants: new Set(), budget, ctx: {} });
    const result = await sandbox.run({
      code: `
        const results = [];
        for (let i = 0; i < 5; i++) {
          try { await trycord.call('log', { message: 'call ' + i }); results.push('ok'); }
          catch (e) { results.push(e.message); }
        }
        return results;
      `,
      host,
      limits: { timeoutMs: 5000 },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.output.slice(0, 3), ['ok', 'ok', 'ok']);
    assert.match(result.output[3], /budget of 3 calls/);
    assert.match(result.output[4], /budget of 3 calls/);
    assert.equal(budget.used, 3, 'the budget should not have been spent past its limit');
  });

  await t.test('a call the extension was not granted is refused', async () => {
    const budget = { limit: 10, used: 0, consume() { this.used += 1; } };
    const host = bridge.createHost({ grants: new Set(['messages.write']), budget, ctx: {} });
    const result = await sandbox.run({
      code: `
        try { await trycord.call('member.count', { serverId: 'any' }); return 'allowed'; }
        catch (e) { return e.message; }
      `,
      host,
      limits: { timeoutMs: 5000 },
    });
    assert.equal(result.ok, true);
    assert.match(result.output, /has not been granted the capability "members.read"/);
  });

  await t.test('an extension that asks for something that is not an action is refused', async () => {
    const budget = { limit: 10, used: 0, consume() { this.used += 1; } };
    const host = bridge.createHost({ grants: new Set(), budget, ctx: {} });
    const result = await sandbox.run({
      code: `
        try { await trycord.call('rm.rf', { path: '/' }); return 'allowed'; }
        catch (e) { return e.message; }
      `,
      host,
      limits: { timeoutMs: 5000 },
    });
    assert.match(result.output, /there is no action called "rm.rf"/);
  });

  await t.test('an extension that allocates without bound is stopped by the memory ceiling', async () => {
    const result = await sandbox.run({
      code: 'const a = []; while (true) { a.push(new Array(500000).fill("x")); }',
      host: async () => ({ ok: true }),
      limits: { timeoutMs: 30000, memoryMb: 32 },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /memory limit|heap out of memory/);
  });

  await t.test('the extension can call the instance, and the answer comes back', async () => {
    const budget = { limit: 10, used: 0, consume() { this.used += 1; } };
    const host = bridge.createHost({ grants: new Set(), budget, ctx: {} });
    const result = await sandbox.run({
      code: `
        const answer = await trycord.call('log', { message: 'hello from the sandbox' });
        return { answer, hasConsole: typeof console.log };
      `,
      host,
      limits: { timeoutMs: 5000 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.output.answer.message, 'hello from the sandbox');
    assert.equal(result.output.hasConsole, 'function');
  });
});

test('a trusted extension runs its own code, and only when the operator allows it', async (t) => {
  const { db, ext, close } = await start();
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
    entry: {
      file: 'index.js',
      source: `
        const answer = await trycord.call('log', { message: 'the trusted extension ran' });
        return answer;
      `,
    },
    triggers: [{ event: 'message.created', conditions: [], steps: [{ type: 'code' }] }],
  }]);
  await useMirror(ext.admin, registryDir);

  await t.test('a trusted package is refused while the policy forbids server-side code', async () => {
    const res = await ext.admin.post('/api/extensions/install', { id: 'test.trusted', grants: [] });
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.match(res.data.error.message, /runs code on the server/);
  });

  await t.test('once the policy allows it, the code runs in the sandbox', async () => {
    await useMirror(ext.admin, registryDir, { allowTrusted: true });
    const installed = await ext.admin.post('/api/extensions/install', { id: 'test.trusted', grants: [] });
    assert.equal(installed.status, 201, JSON.stringify(installed.data));
    await ext.admin.post('/api/extensions/test.trusted/enable');

    const res = await ext.admin.post('/api/extensions/events', {
      type: 'message.created',
      payload: { id: 'trusted-1' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.dispatched[0].status, 'succeeded');

    const steps = await db.all(
      'SELECT status, error FROM workflow_run_steps WHERE type = ?', ['code']
    );
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, 'succeeded');
    assert.equal(steps[0].error, null);
  });
});
