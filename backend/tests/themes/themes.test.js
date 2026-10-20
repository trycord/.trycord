// The theme packages.
//
// A theme is values: colours, a schema version and a compatibility
// declaration. It cannot carry a script, and a package that declares a
// schema version this build does not know is refused by name.
//
// Import validates, export produces a package, and a rollback puts back the
// theme that was in force before the last change.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startRouted, registerUser, makeAdmin } = require('../support/harness');

const THEME = {
  schemaVersion: 1,
  name: 'Ember Noir',
  version: '1.0.0',
  compatibility: { minSchemaVersion: 1 },
  tokens: {
    accent: '#FF4D24',
    pg: '#121317',
    base: '#18191D',
    txt: '#F4F5F7',
  },
};

const SECOND = {
  schemaVersion: 1,
  name: 'Paper',
  version: '1.0.0',
  compatibility: { minSchemaVersion: 1 },
  tokens: {
    accent: '#2F6FED',
    pg: '#FFFFFF',
    base: '#F6F7F9',
    txt: '#121317',
  },
};

test('a theme package', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const admin = await registerUser(ws, 'operator');
  await makeAdmin(ws, admin.user.id);
  const reader = await registerUser(ws, 'reader');

  let themeId = null;

  await t.test('a theme imports and is in force', async () => {
    const res = await admin.post('/api/themes/import', { theme: THEME });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.name, 'Ember Noir');
    assert.equal(res.data.schemaVersion, 1);
    themeId = res.data.id;

    const active = await admin.get('/api/themes');
    assert.equal(active.status, 200, JSON.stringify(active.data));
    assert.ok(active.data.active, 'a theme is in force');
    assert.equal(active.data.active.id, themeId);
    assert.equal(active.data.active.tokens.accent, '#FF4D24');
  });

  await t.test('an ordinary reader cannot import a theme', async () => {
    const res = await reader.post('/api/themes/import', { theme: SECOND });
    assert.equal(res.status, 403);
  });

  await t.test('a theme exports as a package and round-trips', async () => {
    const exported = await admin.get('/api/themes/' + themeId + '/export');
    assert.equal(exported.status, 200, JSON.stringify(exported.data));
    assert.deepEqual(exported.data, THEME);

    // The exported package imports again, unchanged.
    const again = await admin.post('/api/themes/import', { theme: exported.data });
    assert.equal(again.status, 201, JSON.stringify(again.data));
    assert.equal(again.data.name, THEME.name);
    assert.equal(again.data.version, THEME.version);
  });

  await t.test('a theme that declares an unknown schema version is refused by name', async () => {
    const future = Object.assign({}, THEME, { schemaVersion: 4, name: 'From The Future' });
    const res = await admin.post('/api/themes/import', { theme: future });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /schema version 4 is not known to this build/);

    const list = await admin.get('/api/themes');
    const stored = list.data.themes.filter((row) => row.name === 'From The Future');
    assert.equal(stored.length, 0, 'it was not stored');
  });

  await t.test('a theme cannot carry a script', async () => {
    const scripted = Object.assign({}, THEME, {
      name: 'Scripted',
      script: 'fetch("https://example.test/steal")',
    });
    const res = await admin.post('/api/themes/import', { theme: scripted });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /not a field a theme package may carry/);
  });

  await t.test('a token that is not a colour is refused', async () => {
    const injected = Object.assign({}, THEME, {
      name: 'Injected',
      tokens: { accent: 'red; background: url(https://example.test/x)' },
    });
    const res = await admin.post('/api/themes/import', { theme: injected });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /not a colour/);
  });

  await t.test('a rollback returns to the theme that was in force before', async () => {
    const imported = await admin.post('/api/themes/import', { theme: SECOND });
    assert.equal(imported.status, 201, JSON.stringify(imported.data));

    let active = await admin.get('/api/themes');
    assert.equal(active.data.active.id, imported.data.id, 'the new theme is in force');

    const rolled = await admin.post('/api/themes/rollback', {});
    assert.equal(rolled.status, 200, JSON.stringify(rolled.data));
    assert.equal(rolled.data.name, 'Ember Noir', 'the previous theme is in force again');

    active = await admin.get('/api/themes');
    assert.equal(active.data.active.tokens.accent, '#FF4D24');
  });
});

test('a community theme needs the community\'s permission', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'owner');
  const member = await registerUser(ws, 'member');
  const community = await (async () => {
    const res = await owner.post('/api/servers', { name: 'Themed', description: 'A community' });
    return { serverId: res.data.serverId };
  })();

  await t.test('a member without the permission cannot install a theme', async () => {
    const res = await member.post('/api/themes/import', {
      serverId: community.serverId,
      theme: THEME,
    });
    assert.equal(res.status, 403);
  });

  await t.test('the community\'s owner can', async () => {
    const res = await owner.post('/api/themes/import', {
      serverId: community.serverId,
      theme: THEME,
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));

    const active = await owner.get('/api/themes?serverId=' + community.serverId);
    assert.equal(active.status, 200, JSON.stringify(active.data));
    assert.equal(active.data.active.name, 'Ember Noir');
  });
});
