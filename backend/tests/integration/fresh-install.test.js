// A fresh installation.
//
// The first journey: an operator who has never configured anything, a
// database that has never existed, and the first person to sign up. It is the
// journey that catches a schema that cannot be created, a boot that needs a
// setting nobody has set, and a client that is not actually served.
//
// It runs against a temporary SQLite database in a temporary directory, with
// its own signing secret, so it never touches the instance the machine is
// serving.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startInstance, registerUser } = require('../helpers/instance');

test('a fresh installation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-fresh-'));
  const instance = await startInstance({
    dir,
    env: {
      DB_CLIENT: 'sqlite',
      DB_FILE: path.join(dir, 'brand-new.db'),
      JWT_SECRET: 'a-fresh-secret-for-this-install-only',
    },
  });
  t.after(async () => {
    await instance.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  await t.test('the instance starts on a database that did not exist', async () => {
    const health = await (await fetch(instance.baseUrl + '/health')).json();
    assert.equal(health.ok, true);
    const ready = await (await fetch(instance.baseUrl + '/ready')).json();
    assert.equal(ready.ok, true, 'the database is answering');
  });

  await t.test('it describes itself, and the version is the one the manifest says', async () => {
    const meta = await (await fetch(instance.baseUrl + '/api/instance')).json();
    assert.equal(meta.instanceId, 'verification');
    assert.equal(meta.version, require('../../package.json').version);
    assert.equal(meta.protocolVersion, 'trycord-continuum/1.0');
    assert.equal(typeof meta.registration.enabled, 'boolean',
      'a client can tell whether it may register before it shows the form');
  });

  await t.test('the first account registers', async () => {
    const first = await registerUser(instance, 'firstmember');
    assert.ok(first.user.id);
    const me = await first.get('/api/users/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.username, 'firstmember');
  });

  await t.test('the first community is created and is addressable by name', async () => {
    const first = await registerUser(instance, 'owner2');
    const community = await first.post('/api/servers', { name: 'The First Community' });
    assert.equal(community.status, 200, JSON.stringify(community.data));
    assert.equal(community.data.slug, 'the-first-community');

    const channels = await first.get('/api/servers/' + community.data.serverId + '/channels');
    assert.equal(channels.status, 200);
    assert.equal(channels.data.channels.length, 1, 'a new community has one channel to land on');
  });

  await t.test('the first message is posted, and it comes back', async () => {
    const first = await registerUser(instance, 'owner3');
    const community = await first.post('/api/servers', { name: 'Second Community' });
    const channel = await first.post('/api/servers/' + community.data.serverId + '/channels', {
      name: 'general', type: 'forum',
    });
    assert.equal(channel.status, 200, JSON.stringify(channel.data));

    const message = await first.post('/api/channels/' + channel.data.id + '/messages', {
      content: 'Hello from the first install.',
    });
    assert.equal(message.status, 200, JSON.stringify(message.data));

    const history = await first.get('/api/channels/' + channel.data.id + '/messages?limit=50');
    assert.equal(history.status, 200);
    assert.ok(history.data.some((m) => m.content === 'Hello from the first install.'));

    const search = await first.get('/api/search?q=Hello');
    assert.equal(search.status, 200);
    assert.ok(Array.isArray(search.data) && search.data.length >= 1, 'the search finds it');
  });

  await t.test('the client is served, and the mobile module has its own document', async () => {
    // The public site owns the origin root, and the application is served
    // from its own mount. So the client's document is reached through an
    // application route, and the mount is read from that document's base.
    const app = await fetch(instance.baseUrl + '/home');
    assert.equal(app.status, 200, 'the application document is served');
    const appHtml = await app.text();
    const base = /<base href="([^"]*)"/.exec(appHtml);
    assert.ok(base, 'the application document carries its base');
    const mount = base[1].replace(/\/$/, '');

    // The mobile module, at the same mount plus /mobile.
    const mobile = await fetch(instance.baseUrl + mount + '/mobile/');
    assert.equal(mobile.status, 200, 'the mobile module is served');
    const mobileHtml = await mobile.text();
    const mobileBase = /<base href="([^"]*)"/.exec(mobileHtml);
    assert.ok(mobileBase, 'the mobile document carries its base');
    assert.equal(mobileBase[1], mount + '/mobile/',
      'the mobile base is the mount plus /mobile/');
  });

  await t.test('the public site is served, with the API address in it', async () => {
    const site = await fetch(instance.baseUrl + '/');
    const html = await site.text();
    // The site and the API are not always the same origin, so the address the
    // API is at has to be *in* the page for the site's own requests to find
    // it. A site that cannot find the API is the demo defect.
    assert.ok(/name="trycord-api"/.test(html),
      'the page says where the API is');
  });

  await t.test('the background job system starts with the instance', async () => {
    const jobs = require('../../src/services/jobs');
    const stats = await jobs.stats();
    assert.ok(stats.kinds.length > 0, 'the job kinds are registered: ' + JSON.stringify(stats.kinds));
  });

  await t.test('the instance answers 404 in the API envelope for a path that does not exist', async () => {
    const res = await fetch(instance.baseUrl + '/api/nothing-here');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});
