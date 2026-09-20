// Safety harness for the desktop auto-updater. No Electron, no network:
// verifies the dev/offline path never throws, never loads electron-updater,
// registers its IPC bridge, and classifies failures correctly.
// Run: node scripts/test-updater-safety.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initUpdater, classifyError } = require('../updater');

// 1. Failure classification (drives friendly UI vs raw diagnostics).
assert.strictEqual(
  classifyError(new Error('Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1.0.1/latest.yml): HttpError: 404')),
  'missing-metadata'
);
assert.strictEqual(classifyError(new Error('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')), 'missing-metadata');
assert.strictEqual(classifyError(new Error('getaddrinfo ENOTFOUND github.com')), 'offline');
assert.strictEqual(classifyError(new Error('net::ERR_INTERNET_DISCONNECTED')), 'offline');
assert.strictEqual(classifyError(new Error('something unexpected')), 'unknown');
assert.strictEqual(classifyError(null), 'unknown');

// 2. Dev-mode init with stubbed Electron primitives.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-updater-test-'));
const handled = {};
const ipcMain = { handle: (ch, fn) => { handled[ch] = fn; } };
const logs = [];
const app = {
  isPackaged: false,
  getVersion: () => '9.9.9-test',
  getPath: () => scratch,
};

(async () => {
  const api = initUpdater({ app, ipcMain, getWindow: () => null, log: (m) => logs.push(m) });
  assert.ok(api && typeof api.checkForUpdates === 'function', 'init returns api');
  for (const ch of ['trycord:get-version', 'trycord:updater-provider', 'trycord:updater-prefs', 'trycord:updater-prefs-set', 'trycord:updater-check', 'trycord:updater-install']) {
    assert.ok(handled[ch], 'IPC handler registered: ' + ch);
  }
  assert.strictEqual(await handled['trycord:get-version'](), '9.9.9-test');
  const provider = await handled['trycord:updater-provider']();
  assert.strictEqual(provider.provider, 'github');
  assert.strictEqual(provider.owner, 'LanxTheShowmaker');
  assert.strictEqual(provider.repo, '.trycord');

  // Dev check must resolve without contacting any server.
  await api.checkForUpdates('harness');
  assert.ok(logs.some((m) => m.includes('dev mode')), 'dev mode logged, no update contact');

  // Prefs round-trip (persisted under userData, i.e. scratch dir).
  const p1 = await handled['trycord:updater-prefs']();
  assert.strictEqual(p1.channel, 'latest');
  await handled['trycord:updater-prefs-set'](null, { channel: 'beta', autoInstall: false });
  const p2 = await handled['trycord:updater-prefs']();
  assert.strictEqual(p2.channel, 'beta');
  assert.strictEqual(p2.autoInstall, false);
  // Invalid channel values are ignored, never stored.
  await handled['trycord:updater-prefs-set'](null, { channel: 'evil' });
  const p3 = await handled['trycord:updater-prefs']();
  assert.strictEqual(p3.channel, 'beta');

  // Install with no autoUpdater active must not throw.
  await handled['trycord:updater-install']();

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('updater safety harness passed (classification, dev init, prefs, install no-op)');
})().catch((e) => {
  console.error('HARNESS FAILED: ' + ((e && e.stack) || e));
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
