// The capability catalogue is published.
//
// A grant picker that cannot see the vocabulary has to ask an administrator
// to type a name they may not know, and the server refuses the name it does
// not know with a reason that is less useful than a list.
//
// The catalogue is the same list the permission model enforces, so a client
// that described a capability from its own copy would eventually describe it
// wrongly. The route publishes the server's own.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./support');

test('the capability catalogue', async (t) => {
  const { admin, ext, close } = await start();
  t.after(() => close());

  await t.test('a signed-in account can read the catalogue', async () => {
    const res = await ext.admin.get('/api/extensions/capabilities');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(Array.isArray(res.data.capabilities), 'the answer is not a list');
    assert.ok(res.data.capabilities.length, 'the catalogue is empty');
  });

  await t.test('every capability says what it is and what it risks', async () => {
    const res = await ext.admin.get('/api/extensions/capabilities');
    for (const entry of res.data.capabilities) {
      assert.equal(typeof entry.id, 'string', 'a capability has no id');
      assert.ok(entry.id, 'a capability has an empty id');
      assert.equal(typeof entry.label, 'string', entry.id + ' has no label');
      assert.ok(entry.label, entry.id + ' has an empty label');
      assert.equal(typeof entry.description, 'string', entry.id + ' has no description');
      assert.ok(entry.description, entry.id + ' has an empty description');
      assert.ok(entry.risk, entry.id + ' does not say what it risks');
    }
  });

  await t.test('the catalogue is the one the permission model enforces', async () => {
    // The route publishes the service's own catalogue, so a capability the
    // server would refuse cannot appear in the list, and a capability in the
    // list is one the server knows.
    const catalogue = require('../../src/services/extensions/capabilities');
    const res = await ext.admin.get('/api/extensions/capabilities');
    const served = res.data.capabilities.map((entry) => entry.id).sort();
    const known = catalogue.catalogue().map((entry) => entry.id).sort();
    assert.deepEqual(served, known,
      'the published catalogue is not the one the permission model enforces');
  });

  await t.test('an account that is not signed in is refused', async () => {
    // The catalogue is published to a signed-in account, because knowing what
    // a thing may ask for is not the same as being allowed to ask for it.
    // The token is taken away rather than a second client made, so the
    // request is the one a stranger would make.
    ext.admin.setToken(null);
    const res = await ext.admin.get('/api/extensions/capabilities');
    assert.equal(res.status, 401, 'the catalogue was readable without a session');
  });
});
