// The defects the workstreams found in the parts they could not change.
//
// Every one of these was found by an agent that had to stop at the boundary
// of its own files, and every one of them was a control that did not do what
// it said: a disabled application that kept posting, a setting that could be
// written but not read, a revision list that could not be compared, a read
// receipt that did not reach the reader's other devices.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

test('defects the workstreams reported', async (t) => {
  // The owner is a platform administrator, because the page editor is an
  // administrative surface and this test drives it.
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');

  let serverId = null;
  await t.test('a community is created for the rest of these', async () => {
    const res = await owner.post('/api/servers', { name: 'Defect Community' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    serverId = res.data.serverId;
  });

  await t.test('a disabled bot application is refused, not merely quiet', async () => {
    // An application is created, its token is taken, and it is then disabled.
    const created = await owner.post('/api/servers/' + serverId + '/apps', {
      name: 'Helper',
      description: 'A bot that posts.',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    // The token is the application's own credential, and it is the only way
    // the bot API can be reached. It is handed out once, when the application
    // is created.
    const app = created.data.app;
    assert.ok(app && app.id, 'the application is identified');
    assert.ok(app.token, 'the application is issued a token');

    const db = require('../../src/db');
    const bot = apiClient(instance.baseUrl, app.token);
    const before = await bot.get('/api/bot/channels/anything/messages');
    // Whatever the channel, an enabled application gets a channel answer and
    // a disabled one gets the refusal. The point is the difference.
    assert.ok(before.status === 403 || before.status === 404,
      'an unknown channel is refused either way: ' + before.status);
    assert.notEqual(before.data.error && before.data.error.code, 'BOT_NOT_ALLOWED',
      'an enabled application is not refused as disabled');

    await db.run("UPDATE bot_applications SET status = 'disabled' WHERE id = ?", [app.id]);

    const after = await bot.get('/api/bot/channels/anything/messages');
    assert.equal(after.status, 403,
      'a disabled application is refused, whatever the channel: ' + after.status);
    assert.equal(after.data.error.code, 'BOT_NOT_ALLOWED');
  });

  await t.test("a community's settings can be read back", async () => {
    const write = await owner.patch('/api/servers/' + serverId + '/settings', {
      guidelines: 'Be decent to each other.',
      welcome_content: 'Welcome in.',
      welcome_enabled: true,
    });
    assert.equal(write.status, 200, JSON.stringify(write.data));

    // A setting that can be written but not read is a setting the interface
    // cannot show: the box is empty and the operator's next write replaces
    // whatever was really there.
    const read = await owner.get('/api/servers/' + serverId + '/settings');
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.guidelines, 'Be decent to each other.');
    assert.equal(read.data.welcomeContent, 'Welcome in.');
    assert.equal(read.data.welcomeEnabled, true);
  });

  await t.test('a stranger cannot read a community\'s settings', async () => {
    const stranger = await registerUser(instance, 'outsider');
    const res = await stranger.get('/api/servers/' + serverId + '/settings');
    assert.ok(res.status === 403 || res.status === 404,
      'the settings are not readable from outside the community: ' + res.status);
  });

  await t.test('a revision list carries the body, so two revisions can be compared', async () => {
    // Two drafts with different content, then a publication. The list of
    // revisions is what a reader compares one against another, so it has to
    // carry the bodies and not only the dates.
    const first = await owner.put('/api/admin/pages/terms', {
      title: 'Terms of Service',
      body: [
        { type: 'heading', level: 2, text: 'First' },
        { type: 'paragraph', text: 'The first revision.' },
      ],
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));

    const second = await owner.put('/api/admin/pages/terms', {
      title: 'Terms of Service',
      body: [
        { type: 'heading', level: 2, text: 'Second' },
        { type: 'paragraph', text: 'The second revision.' },
      ],
    });
    assert.equal(second.status, 200, JSON.stringify(second.data));

    const publish = await owner.post('/api/admin/pages/terms/publish', { confirm: 'terms' });
    assert.equal(publish.status, 200, JSON.stringify(publish.data));

    const revisions = await owner.get('/api/admin/pages/terms/revisions');
    assert.equal(revisions.status, 200, JSON.stringify(revisions.data));
    assert.ok(revisions.data.length >= 2, 'there is more than one revision');

    for (const revision of revisions.data) {
      assert.ok(revision.body, 'a revision carries its body: ' + JSON.stringify(revision));
    }
    const bodies = revisions.data.map((r) => r.body);
    assert.ok(new Set(bodies).size > 1, 'the revisions are different, so they can be compared');
  });
});
