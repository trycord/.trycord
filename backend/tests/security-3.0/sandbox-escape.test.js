// The extension sandbox, measured rather than believed.
//
// The claim under test is the one the sandbox module makes about itself: the
// context cannot reach the host's globals, the outer Function, `process` or
// `require`. Two routes out of the context were open before this test
// existed, and both of them ran through the timer:
//
//   1. Node's setTimeout returns a Timeout object. It is a host object, so
//      its constructor's constructor is the outer Function - the very thing
//      the context's code-generation rule exists to withhold.
//   2. Node calls a timer callback with the handle as its receiver, so a
//      callback written as a plain function saw the handle as `this` and
//      reached the host through it.
//
// Both are closed now: the context is given a number instead of the handle,
// and the callback is called with no receiver. This file proves it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sandbox = require('../../src/services/extensions/sandbox');

/**
 * The probe that tries to leave the context.
 *
 * It is written as a string because the extension's source is a string: the
 * helper has to live inside the context, so it cannot be a function defined
 * out here.
 */
const PROBE = `
  const reach = (value) => {
    try {
      const F = value.constructor.constructor;
      const process = F('return process')();
      return 'reached: ' + typeof process;
    } catch (e) {
      return 'blocked: ' + (e && e.name);
    }
  };
`;

test('the extension sandbox cannot be left through the timer handle', async () => {
  const result = await sandbox.run({
    code: PROBE + `
      const handle = setTimeout(() => {}, 1);
      return {
        handleType: typeof handle,
        handleIsObject: handle !== null && typeof handle === 'object',
        escape: reach(handle),
      };
    `,
    host: async () => ({ ok: true }),
    limits: { timeoutMs: 5000 },
  });

  assert.equal(result.ok, true, 'the extension should have run: ' + result.error);
  assert.equal(result.output.handleIsObject, false,
    'the timer handle must not be handed to the context: ' + JSON.stringify(result.output));
  assert.match(result.output.escape, /^blocked: /,
    'the context must not be able to reach the outer Function');
});

test('the extension sandbox cannot be left from a timer callback', async () => {
  const result = await sandbox.run({
    code: PROBE + `
      const escape = await new Promise((resolve) => {
        setTimeout(function () { resolve(reach(this)); }, 1);
      });
      return { escape };
    `,
    host: async () => ({ ok: true }),
    limits: { timeoutMs: 5000 },
  });

  assert.equal(result.ok, true, 'the extension should have run: ' + result.error);
  assert.match(result.output.escape, /^blocked: /,
    'a timer callback must not be able to reach the outer Function');
});

test('the extension sandbox cannot reach the host at all', async () => {
  globalThis.__TRYCORD_SECURITY_PROBE__ = 'the-host-secret';
  try {
    const result = await sandbox.run({
      code: `
        const out = {
          require: typeof require,
          process: typeof process,
          module: typeof module,
          secret: typeof globalThis.__TRYCORD_SECURITY_PROBE__,
        };
        try { out.constructorEscape = (function () { return this; }).constructor.constructor('return process')(); }
        catch (e) { out.constructorEscape = 'blocked: ' + e.name; }
        try { out.evalEscape = eval('1 + 1'); }
        catch (e) { out.evalEscape = 'blocked: ' + e.name; }
        try { out.functionEscape = new Function('return process')(); }
        catch (e) { out.functionEscape = 'blocked: ' + e.name; }
        return out;
      `,
      host: async () => ({ ok: true }),
      limits: { timeoutMs: 5000 },
    });

    assert.equal(result.ok, true, 'the extension should have run: ' + result.error);
    assert.equal(result.output.require, 'undefined');
    assert.equal(result.output.process, 'undefined');
    assert.equal(result.output.module, 'undefined');
    assert.equal(result.output.secret, 'undefined');
    assert.match(result.output.constructorEscape, /^blocked: /);
    assert.match(result.output.evalEscape, /^blocked: /);
    assert.match(result.output.functionEscape, /^blocked: /);
  } finally {
    delete globalThis.__TRYCORD_SECURITY_PROBE__;
  }
});

test('a timer still fires, and a cleared timer does not', async () => {
  const result = await sandbox.run({
    code: `
      const fired = [];
      const cleared = setTimeout(function () { fired.push('cleared'); }, 30);
      setTimeout(function () { fired.push('kept'); }, 1);
      clearTimeout(cleared);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return fired;
    `,
    host: async () => ({ ok: true }),
    limits: { timeoutMs: 5000 },
  });

  assert.equal(result.ok, true, 'the extension should have run: ' + result.error);
  assert.deepEqual(result.output, ['kept'],
    'the kept timer must fire and the cleared one must not: ' + JSON.stringify(result.output));
});
