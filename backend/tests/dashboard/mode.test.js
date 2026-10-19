'use strict';

// The dashboard mode, measured on its own.
//
// The mode decides which deployment runs, so a wrong value has to stop the
// boot with a message an operator can act on. A silent fallback to a mode
// that happens to work is the failure this file is here to prevent.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMode, resolveMode, MODES, DEFAULT_MODE, MODE_VARIABLE, describe, describeLine,
} = require('../../src/dashboard/mode');
const dashboardMode = require('../../src/dashboard/mode');

test('the dashboard mode', async (t) => {
  await t.test('the two documented modes are accepted', () => {
    assert.equal(parseMode('bundled'), 'bundled');
    assert.equal(parseMode('separate'), 'separate');
    assert.deepEqual(MODES, ['bundled', 'separate']);
  });
  await t.test('an empty value means bundled', () => {
    assert.equal(parseMode(''), 'bundled');
    assert.equal(parseMode('   '), 'bundled');
    assert.equal(parseMode(undefined), 'bundled');
    assert.equal(parseMode(null), 'bundled');
    assert.equal(DEFAULT_MODE, 'bundled');
  });

  await t.test('any other value is refused, and the message says what to do', () => {
    const bad = ['something', 'solo', 'yes', '1', 'BUNDLED', 'Separate', 'bundled,separate'];
    for (const value of bad) {
      let thrown = null;
      try {
        parseMode(value);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, 'DASHBOARD_MODE=' + value + ' must be refused, not defaulted');
      const message = thrown.message;
      assert.ok(message.includes(MODE_VARIABLE),
        'the message names the variable: ' + message);
      assert.ok(message.includes(value),
        'the message names the offending value: ' + message);
      assert.ok(message.includes('bundled') && message.includes('separate'),
        'the message names both accepted values: ' + message);
    }
  });

  await t.test('the mode is read from the environment', () => {
    assert.equal(resolveMode({ DASHBOARD_MODE: 'separate' }), 'separate');
    assert.equal(resolveMode({ DASHBOARD_MODE: 'bundled' }), 'bundled');
    assert.equal(resolveMode({}), 'bundled');
    assert.equal(resolveMode({ DASHBOARD_MODE: '' }), 'bundled');
    assert.throws(() => resolveMode({ DASHBOARD_MODE: 'something' }), /DASHBOARD_MODE/);
  });

  await t.test('the resolved mode is exported, and an unusable one is refused', () => {
    const saved = process.env.DASHBOARD_MODE;
    try {
      process.env.DASHBOARD_MODE = 'separate';
      assert.equal(dashboardMode.mode, 'separate');
      process.env.DASHBOARD_MODE = 'bundled';
      assert.equal(dashboardMode.mode, 'bundled');
      delete process.env.DASHBOARD_MODE;
      assert.equal(dashboardMode.mode, 'bundled', 'an unset environment means bundled');
      process.env.DASHBOARD_MODE = 'something';
      assert.throws(() => dashboardMode.mode, /DASHBOARD_MODE/,
        'an unusable environment is refused, not defaulted');
    } finally {
      if (saved === undefined) delete process.env.DASHBOARD_MODE;
      else process.env.DASHBOARD_MODE = saved;
    }
  });

  await t.test('what is in force is reported', () => {
    const bundled = describe({ mode: 'bundled', apiUrl: 'https://api.example.com' });
    assert.equal(bundled.mode, 'bundled');
    assert.equal(bundled.servedBy, 'main-process');
    assert.equal(bundled.adminApiPath, '/api/admin');
    assert.equal(bundled.dashboardPath, '/admin');

    const separate = describe({
      mode: 'separate',
      apiUrl: 'https://api.example.com',
      dashboardUrl: 'https://dashboard.example.com/admin',
    });
    assert.equal(separate.servedBy, 'separate-service');
    assert.equal(separate.apiUrl, 'https://api.example.com');
    assert.equal(separate.dashboardUrl, 'https://dashboard.example.com/admin');

    assert.match(describeLine(bundled), /bundled/);
    assert.match(describeLine(bundled), /main process/);
    assert.match(describeLine(separate), /separate/);
    assert.match(describeLine(separate), /separate dashboard service/);
  });
});
