// The sandbox's limits, measured.
//
// Three limits the sandbox declares, and the two that were declared but not
// applied:
//
//   the deadline        enforced: the synchronous part by the vm timeout, the
//                       whole run by a wall clock that terminates the worker
//   the memory ceiling  enforced: the worker's resourceLimits
//   the call budget     enforced on the host side, where the extension cannot
//                       reach it, and again where the action is checked
//   the output size     was declared in the limits table and not applied at
//                       all: an extension could return as much as it liked,
//                       and the answer was copied across the thread boundary
//                       and stored as the step's output
//
// This file measures all four.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sandbox = require('../../src/services/extensions/sandbox');

test('the deadline stops a runaway extension', async () => {
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

test('the deadline stops an extension that waits for an answer that never comes', async () => {
  const started = Date.now();
  const result = await sandbox.run({
    code: 'await new Promise(() => {});',
    host: async () => ({ ok: true }),
    limits: { timeoutMs: 400 },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 5000, 'the run should have been stopped promptly, took ' + elapsed + 'ms');
});

test('the memory ceiling is real', async () => {
  const result = await sandbox.run({
    code: 'const a = []; while (true) { a.push(new Array(500000).fill("x")); }',
    host: async () => ({ ok: true }),
    limits: { timeoutMs: 30000, memoryMb: 32 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /memory limit|heap out of memory/);
});

test('the call budget is enforced even when the host does not enforce it', async () => {
  // A host that counts nothing: the budget has to hold on the sandbox's side
  // of the boundary, where the extension cannot reach it.
  let served = 0;
  const result = await sandbox.run({
    code: `
      const results = [];
      for (let i = 0; i < 8; i++) {
        try { await trycord.call('log', { message: 'call ' + i }); results.push('ok'); }
        catch (e) { results.push(e.message); }
      }
      return results;
    `,
    host: async () => { served += 1; return { ok: true }; },
    limits: { timeoutMs: 5000, callBudget: 3 },
  });

  assert.equal(result.ok, true, 'the extension should have run: ' + result.error);
  assert.equal(served, 3, 'the host should have been asked three times, not eight');
  assert.deepEqual(result.output.slice(0, 3), ['ok', 'ok', 'ok']);
  assert.match(result.output[3], /budget of 3 calls/);
  assert.match(result.output[7], /budget of 3 calls/);
});

test('the size of the output is bounded', async () => {
  const small = await sandbox.run({
    code: 'return { hello: "world" };',
    host: async () => ({ ok: true }),
    limits: { timeoutMs: 5000, outputBytes: 8000 },
  });
  assert.equal(small.ok, true, 'a small output should be fine: ' + small.error);
  assert.deepEqual(small.output, { hello: 'world' });

  const large = await sandbox.run({
    code: 'return { blob: "x".repeat(20000) };',
    host: async () => ({ ok: true }),
    limits: { timeoutMs: 5000, outputBytes: 8000 },
  });
  assert.equal(large.ok, false, 'an output over the limit should be refused');
  assert.match(large.error, /more than the 8000 bytes it may return/);
  assert.equal(large.output, null);
});
