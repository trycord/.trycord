// The localisation packs.
//
// A pack is a set of translations for one locale. It is untrusted content: it
// may say what the interface says and nothing else, and it is checked before
// it is stored.
//
// The locale is chosen in one order - the reader's preference, the instance's
// default, the browser's Accept-Language - and the answer says which of them
// was used.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startRouted, registerUser, makeAdmin } = require('../support/harness');

const FRENCH = {
  formatVersion: 1,
  locale: 'fr',
  version: '1.0.0',
  name: 'Français',
  author: 'Camille',
  reviewer: 'Alex',
  strings: {
    'nav.messages': 'Messages',
    'nav.settings': 'Réglages',
    'search.results': '{count} résultats',
  },
};

const GERMAN = {
  formatVersion: 1,
  locale: 'de',
  version: '1.0.0',
  name: 'Deutsch',
  author: 'Dieter',
  reviewer: 'Grete',
  strings: {
    'nav.messages': 'Nachrichten',
  },
};

async function setSetting(ws, key, value) {
  await ws.db.upsert(
    'instance_settings',
    ['key', 'value', 'updated_at'],
    [key, value, new Date().toISOString()],
    ['key'],
    { value: ws.db.newRef('value'), updated_at: ws.db.newRef('updated_at') }
  );
  await require('../../src/services/settings').load(true);
}

test('a localisation pack', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const admin = await registerUser(ws, 'operator');
  await makeAdmin(ws, admin.user.id);
  const reader = await registerUser(ws, 'reader');

  await t.test('a pack installs', async () => {
    const res = await admin.post('/api/localisation/packs', { pack: FRENCH });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.locale, 'fr');
    assert.equal(res.data.version, '1.0.0');
    assert.equal(res.data.reviewState, 'approved');

    const packs = await admin.get('/api/localisation/packs');
    assert.equal(packs.status, 200);
    assert.equal(packs.data.length, 1);
  });

  await t.test('an ordinary reader cannot install a pack', async () => {
    const res = await reader.post('/api/localisation/packs', { pack: GERMAN });
    assert.equal(res.status, 403);
  });

  await t.test('the instance answers in the locale it has a pack for', async () => {
    await setSetting(ws, 'localisation.defaultLocale', 'fr');
    const res = await reader.get('/api/localisation', { 'Accept-Language': 'de' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.locale, 'fr', 'the instance default wins over the browser');
    assert.equal(res.data.source, 'instance');
    assert.equal(res.data.strings['nav.messages'], 'Messages');
    assert.equal(res.data.strings['search.results'], '{count} résultats');
    assert.equal(res.data.strings['action.send'], 'Send', 'the rest stays in English');
  });

  await t.test('the browser is asked when the instance default has no pack', async () => {
    await admin.post('/api/localisation/packs', { pack: GERMAN });

    await setSetting(ws, 'localisation.defaultLocale', 'xx');
    const browser = await reader.get('/api/localisation', { 'Accept-Language': 'de' });
    assert.equal(browser.status, 200, JSON.stringify(browser.data));
    assert.equal(browser.data.locale, 'de');
    assert.equal(browser.data.source, 'browser');

    await setSetting(ws, 'localisation.defaultLocale', 'fr');
  });

  await t.test("the reader's own preference comes first", async () => {
    const preference = await reader.put('/api/localisation/preference', { locale: 'de' });
    assert.equal(preference.status, 200, JSON.stringify(preference.data));
    assert.equal(preference.data.locale, 'de');

    const res = await reader.get('/api/localisation', { 'Accept-Language': 'fr' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.locale, 'de');
    assert.equal(res.data.source, 'reader');

    // Another reader is not affected by it.
    const other = await admin.get('/api/localisation', { 'Accept-Language': 'de' });
    assert.equal(other.data.source, 'instance', 'the preference is the reader\'s own');
  });

  await t.test('a pack that would break the interface is refused', async () => {
    const broken = Object.assign({}, FRENCH, {
      locale: 'es',
      version: '1.0.0',
      strings: {
        'search.results': '{nombre} resultados',
      },
    });
    const res = await admin.post('/api/localisation/packs', { pack: broken });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /placeholders/);

    const packs = await admin.get('/api/localisation/packs');
    assert.equal(packs.data.filter((p) => p.locale === 'es').length, 0, 'it was not stored');
  });

  await t.test('a pack with a script in it is refused', async () => {
    const scripted = Object.assign({}, FRENCH, {
      locale: 'it',
      version: '1.0.0',
      strings: {
        'nav.messages': '<script>alert(1)</script>',
      },
    });
    const res = await admin.post('/api/localisation/packs', { pack: scripted });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /markup/);

    const packs = await admin.get('/api/localisation/packs');
    assert.equal(packs.data.filter((p) => p.locale === 'it').length, 0, 'it was not stored');
  });

  await t.test('a pack version this build does not know is refused by name', async () => {
    const future = Object.assign({}, FRENCH, {
      formatVersion: 2,
      locale: 'pt',
      version: '1.0.0',
    });
    const res = await admin.post('/api/localisation/packs', { pack: future });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /format version 2 is not known to this build/);
  });

  await t.test('a pack that translates a string this build does not have is refused', async () => {
    const unknown = Object.assign({}, FRENCH, {
      locale: 'nl',
      version: '1.0.0',
      strings: { 'nav.somethingNew': 'Iets' },
    });
    const res = await admin.post('/api/localisation/packs', { pack: unknown });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /nav.somethingNew/);
  });
});

test('a community pack overrides the instance\'s for that community', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const admin = await registerUser(ws, 'operator');
  await makeAdmin(ws, admin.user.id);
  const staff = await registerUser(ws, 'staff');

  const community = await (async () => {
    const res = await staff.post('/api/servers', { name: 'Localised', description: 'A community' });
    return { serverId: res.data.serverId };
  })();

  await t.test('the community\'s pack waits for a review', async () => {
    const res = await staff.post('/api/localisation/packs', {
      serverId: community.serverId,
      pack: Object.assign({}, FRENCH, { locale: 'fr', version: '2.0.0' }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.reviewState, 'pending');

    const packs = await admin.get('/api/localisation/packs');
    assert.equal(packs.data.filter((p) => p.reviewState === 'pending').length, 1);
  });

  await t.test('a pack that has not been reviewed is not served', async () => {
    const res = await staff.get('/api/localisation?serverId=' + community.serverId);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const french = res.data.locales.find((entry) => entry.locale === 'fr');
    assert.equal(french, undefined, 'a pack waiting for a review is not in force');
  });

  await t.test('a reviewed community pack overrides the instance\'s', async () => {
    const packs = await admin.get('/api/localisation/packs');
    const pending = packs.data.find((p) => p.reviewState === 'pending');
    const reviewed = await admin.post('/api/localisation/packs/' + pending.id + '/review', {
      decision: 'approved',
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.equal(reviewed.data.reviewState, 'approved');

    const res = await staff.get('/api/localisation?serverId=' + community.serverId);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const french = res.data.locales.find((entry) => entry.locale === 'fr');
    assert.ok(french, 'the community\'s pack is in force');
    assert.equal(french.scope, 'community');
    assert.equal(french.version, '2.0.0');
  });

  await t.test('a member without the permission cannot install a community pack', async () => {
    const other = await registerUser(ws, 'member');
    const res = await other.post('/api/localisation/packs', {
      serverId: community.serverId,
      pack: Object.assign({}, FRENCH, { locale: 'fr', version: '3.0.0' }),
    });
    assert.equal(res.status, 403);
  });
});
