// Templates and collections.
//
// Both belong to the reader. A collection may be shared with the community
// it belongs to, and a shared collection is visible to that community's
// members and to nobody else.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startRouted, registerUser,
  createCommunity, addMember, postMessage,
} = require('../support/harness');

test('a template is the reader\'s own', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const bob = await registerUser(ws, 'bob');

  let templateId = null;

  await t.test('a template is created with a shortcut', async () => {
    const res = await ada.post('/api/personal/templates', {
      name: 'Standup',
      body: 'Here is what I did today:',
      shortcut: 'standup',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.name, 'Standup');
    assert.equal(res.data.body, 'Here is what I did today:');
    assert.equal(res.data.shortcut, 'standup');
    templateId = res.data.id;
  });

  await t.test('the list is the owner\'s alone', async () => {
    const mine = await ada.get('/api/personal/templates');
    assert.equal(mine.status, 200);
    assert.equal(mine.data.length, 1);

    const theirs = await bob.get('/api/personal/templates');
    assert.equal(theirs.status, 200);
    assert.equal(theirs.data.length, 0);
  });

  await t.test('another reader cannot read, change or delete it', async () => {
    const read = await bob.get('/api/personal/templates/' + templateId);
    assert.equal(read.status, 404);

    const changed = await bob.patch('/api/personal/templates/' + templateId, { name: 'Theirs' });
    assert.equal(changed.status, 404);

    const removed = await bob.delete('/api/personal/templates/' + templateId);
    assert.equal(removed.status, 404);

    const still = await ada.get('/api/personal/templates');
    assert.equal(still.data.length, 1, 'the template is still there');
  });

  await t.test('a shortcut is the reader\'s own', async () => {
    const found = await ada.get('/api/personal/templates/shortcut/standup');
    assert.equal(found.status, 200, JSON.stringify(found.data));
    assert.equal(found.data.id, templateId);

    const theirs = await bob.get('/api/personal/templates/shortcut/standup');
    assert.equal(theirs.status, 404, 'a shortcut does not carry across readers');
  });

  await t.test('a shortcut cannot be taken twice', async () => {
    const res = await ada.post('/api/personal/templates', {
      name: 'Another',
      body: 'Another one',
      shortcut: 'standup',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /already in use/);
  });
});

test('a collection belongs to one community', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const community = await createCommunity(ws, ada, 'Collections');
  const bob = await addMember(ws, ada, community.serverId, 'bob');
  const outsider = await registerUser(ws, 'outsider');

  let privateId = null;
  let sharedId = null;

  await t.test('a private collection is the owner\'s alone', async () => {
    const res = await ada.post('/api/personal/collections', {
      serverId: community.serverId,
      name: 'Mine',
      visibility: 'private',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.visibility, 'private');
    privateId = res.data.id;

    const theirs = await bob.get('/api/personal/collections/' + privateId);
    assert.equal(theirs.status, 404, 'a member of the community cannot see a private collection');

    const list = await bob.get('/api/personal/collections');
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 0);
  });

  await t.test('a shared collection is visible to the community\'s members', async () => {
    const res = await ada.post('/api/personal/collections', {
      serverId: community.serverId,
      name: 'Ours',
      visibility: 'community',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    sharedId = res.data.id;

    const read = await bob.get('/api/personal/collections/' + sharedId);
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.name, 'Ours');

    const list = await bob.get('/api/personal/collections');
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].id, sharedId);
  });

  await t.test('a shared collection is visible to nobody else', async () => {
    const read = await outsider.get('/api/personal/collections/' + sharedId);
    assert.equal(read.status, 404, 'a reader outside the community sees nothing');

    const list = await outsider.get('/api/personal/collections');
    assert.equal(list.data.length, 0);
  });

  await t.test('a member cannot change the owner\'s collection', async () => {
    const renamed = await bob.patch('/api/personal/collections/' + sharedId, { name: 'Mine now' });
    assert.equal(renamed.status, 403);

    const removed = await bob.delete('/api/personal/collections/' + sharedId);
    assert.equal(removed.status, 403);

    const still = await ada.get('/api/personal/collections/' + sharedId);
    assert.equal(still.status, 200);
    assert.equal(still.data.name, 'Ours');
  });

  await t.test('what is in a collection is a reference, not a copy', async () => {
    const message = await postMessage(ada, community.channelId, 'the note worth keeping');
    const added = await ada.post('/api/personal/collections/' + sharedId + '/items', {
      itemType: 'message',
      itemId: message.id,
    });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.equal(added.data.itemType, 'message');
    assert.equal(added.data.itemId, message.id);
    assert.equal(added.data.title, null, 'the content itself is not copied into the collection');

    const read = await bob.get('/api/personal/collections/' + sharedId);
    assert.equal(read.status, 200);
    assert.equal(read.data.items.length, 1);
    assert.equal(read.data.items[0].itemId, message.id);
  });

  await t.test('a link has to be a link', async () => {
    const good = await ada.post('/api/personal/collections/' + sharedId + '/items', {
      itemType: 'link',
      itemRef: 'https://example.test/notes',
    });
    assert.equal(good.status, 201, JSON.stringify(good.data));
    assert.equal(good.data.itemRef, 'https://example.test/notes');

    const bad = await ada.post('/api/personal/collections/' + sharedId + '/items', {
      itemType: 'link',
      itemRef: 'javascript:alert(1)',
    });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error.message, /http/);
  });

  await t.test('the owner can remove what is in it', async () => {
    const list = await ada.get('/api/personal/collections/' + sharedId);
    const item = list.data.items[0];
    const removed = await ada.delete('/api/personal/collections/' + sharedId + '/items/' + item.id);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    const after = await ada.get('/api/personal/collections/' + sharedId);
    assert.equal(after.data.items.length, 1, 'only the link is left');
  });
});

test('templates and collections go with the account', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const community = await createCommunity(ws, ada, 'Vanishing');
  const bob = await addMember(ws, ada, community.serverId, 'bob');

  await ada.post('/api/personal/templates', { name: 'Standup', body: 'Today:' });
  await ada.post('/api/personal/collections', {
    serverId: community.serverId,
    name: 'Ours',
    visibility: 'community',
  });

  const before = await ws.db.all(
    'SELECT COUNT(*) AS n FROM message_templates WHERE user_id = ?', [ada.user.id]
  );
  assert.equal(before[0].n, 1);

  await t.test('the rows go when the account is erased', async () => {
    // The erasure workflow: the reader asks, the request is processed, and
    // the account is anonymised.
    const erasure = require('../../src/services/accountDeletion');
    const request = await erasure.requestDeletion({ userId: ada.user.id, reason: 'a test' });
    await erasure.reviewRequest({ requestId: request.id, reviewerId: bob.user.id, decision: 'APPROVE' });
    await erasure.beginProcessing({ requestId: request.id, actorId: bob.user.id });
    await erasure.eraseAccount({ userId: ada.user.id, actorId: bob.user.id });

    // The sweep is what takes the reader's own rows away.
    const swept = await require('../../src/services/reader-data').sweepErasedAccounts();
    assert.ok(swept.accounts >= 1, 'the erased account was swept');

    const templates = await ws.db.all(
      'SELECT COUNT(*) AS n FROM message_templates WHERE user_id = ?', [ada.user.id]
    );
    assert.equal(templates[0].n, 0, 'the template went with the account');

    const collections = await ws.db.all(
      'SELECT COUNT(*) AS n FROM saved_collections WHERE user_id = ?', [ada.user.id]
    );
    assert.equal(collections[0].n, 0, 'the collection went with the account');
  });

  await t.test('the sweep takes the rows of an erased account away', async () => {
    const bobTemplate = await bob.post('/api/personal/templates', { name: 'Bob', body: 'Bob:' });
    assert.equal(bobTemplate.status, 201);

    const removed = await require('../../src/services/reader-data').purgeReaderData(bob.user.id);
    assert.ok(removed.message_templates >= 1, 'the sweep took the template');

    const left = await ws.db.all(
      'SELECT COUNT(*) AS n FROM message_templates WHERE user_id = ?', [bob.user.id]
    );
    assert.equal(left[0].n, 0);
  });
});
