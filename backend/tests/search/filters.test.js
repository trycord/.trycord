// The search filters.
//
// A filter narrows what a reader may see. It never widens it: the permission
// check is in the same statement as the filters, so a filter that names a
// community the reader is not in answers nothing rather than everything.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startRouted, apiClient, registerUser,
  createCommunity, addMember, createChannel, postMessage,
} = require('../support/harness');

// The index follows a message asynchronously, so a test waits for the row
// rather than guessing how long that takes.
async function waitForIndex(ws, messageId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = await ws.db.get(
      'SELECT COUNT(*) AS n FROM message_search_words WHERE message_id = ?',
      [messageId]
    );
    if (row && row.n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the message was never indexed');
}

function contents(rows) {
  return rows.map((row) => row.content);
}

test('the search filters', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const community = await createCommunity(ws, ada, 'Search');
  const bob = await addMember(ws, ada, community.serverId, 'bob');
  const stranger = await registerUser(ws, 'stranger');

  const { serverId, channelId } = community;
  const other = await createChannel(ada, serverId, 'Announcements');

  const first = await postMessage(ada, channelId, 'the release notes are ready');
  await waitForIndex(ws, first.id);
  const second = await postMessage(bob, channelId, 'the release notes need a review');
  await waitForIndex(ws, second.id);
  const elsewhere = await postMessage(ada, other.id, 'the release notes for tomorrow');
  await waitForIndex(ws, elsewhere.id);

  await t.test('a plain search finds the messages', async () => {
    const res = await ada.get('/api/search?q=release notes');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(Array.isArray(res.data));
    assert.equal(res.data.length, 3);
  });

  await t.test('from: names the author', async () => {
    const res = await ada.get('/api/search?q=release notes from:bob');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(contents(res.data), ['the release notes need a review']);
  });

  await t.test('a quoted value is one value', async () => {
    const res = await ada.get('/api/search?q=release notes from:"bob"');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(contents(res.data), ['the release notes need a review']);
  });

  await t.test('a quoted channel name works', async () => {
    const res = await ada.get('/api/search?q=release notes in:"announcements"');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(contents(res.data), ['the release notes for tomorrow']);
  });

  await t.test('before: and after: are a range', async () => {
    const before = await ada.get('/api/search?q=release notes before:2000-01-01');
    assert.equal(before.status, 200);
    assert.equal(before.data.length, 0, 'nothing was written before 2000');

    const after = await ada.get('/api/search?q=release notes after:2000-01-01');
    assert.equal(after.status, 200);
    assert.equal(after.data.length, 3, 'everything was written after 2000');

    const between = await ada.get('/api/search?q=release notes after:2999-01-01');
    assert.equal(between.status, 200);
    assert.equal(between.data.length, 0);
  });

  await t.test('has:file finds the messages that carry a file', async () => {
    const withFile = await postMessage(ada, channelId, 'the release notes carry a document');
    await waitForIndex(ws, withFile.id);
    await ws.db.run(
      'INSERT INTO attachments (id, message_id, channel_id, uploader_id, filename, mime, size, url, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['att-1', withFile.id, channelId, ada.user.id, 'notes.pdf', 'application/pdf', 12,
        '/api/attachments/att-1', new Date().toISOString()]
    );

    const res = await ada.get('/api/search?q=release notes has:file');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(contents(res.data), ['the release notes carry a document']);
  });

  await t.test('type: answers from the attachment and the embed', async () => {
    const withImage = await postMessage(ada, channelId, 'the release notes have a picture');
    await waitForIndex(ws, withImage.id);
    await ws.db.run(
      'INSERT INTO attachments (id, message_id, channel_id, uploader_id, filename, mime, size, url, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['att-2', withImage.id, channelId, ada.user.id, 'picture.png', 'image/png', 12,
        '/api/attachments/att-2', new Date().toISOString()]
    );

    const withLink = await postMessage(ada, channelId, 'the release notes have a link');
    await waitForIndex(ws, withLink.id);
    await ws.db.run(
      'INSERT INTO message_embeds (id, message_id, url, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['emb-1', withLink.id, 'https://example.test/release', 'link', 'ok', new Date().toISOString()]
    );

    const images = await ada.get('/api/search?q=release notes type:image');
    assert.equal(images.status, 200, JSON.stringify(images.data));
    assert.deepEqual(contents(images.data), ['the release notes have a picture']);

    const links = await ada.get('/api/search?q=release notes type:link');
    assert.equal(links.status, 200, JSON.stringify(links.data));
    assert.deepEqual(contents(links.data), ['the release notes have a link']);
  });

  await t.test('is:unread answers from the read cursor', async () => {
    // Its own channel and its own words, so the answer is about these two
    // messages and nothing else.
    const channel = await createChannel(ada, serverId, 'Unread');
    const read = await postMessage(ada, channel.id, 'the ledger entry was read already');
    await waitForIndex(ws, read.id);
    const unread = await postMessage(ada, channel.id, 'the ledger entry is unread');
    await waitForIndex(ws, unread.id);

    const cursor = await ada.post('/api/search/read-cursor', {
      channelId: channel.id,
      readAt: read.created_at,
    });
    assert.equal(cursor.status, 200, JSON.stringify(cursor.data));

    const res = await ada.get('/api/search?q=ledger entry is:unread');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(contents(res.data), ['the ledger entry is unread']);

    // The cursor is the reader's own: another reader has read nothing.
    const other = await bob.get('/api/search?q=ledger entry is:unread');
    assert.equal(other.status, 200, JSON.stringify(other.data));
    assert.equal(other.data.length, 2, 'a reader with no cursor has read nothing');
  });

  await t.test('an unknown filter is a search term', async () => {
    const res = await ada.get('/api/search?q=colour:red');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.length, 0, 'nothing was written about a colour');
    const filters = JSON.parse(res.headers.get('x-trycord-search-filters') || '{}');
    assert.deepEqual(filters, {}, 'no filter was understood');
  });

  await t.test('a filter with a value the filter does not accept is refused', async () => {
    const res = await ada.get('/api/search?q=release notes type:sound');
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VALIDATION_ERROR');
    assert.match(res.data.error.message, /image, video, link, code/);
  });

  await t.test('a filter cannot widen what a reader may see', async () => {
    const res = await stranger.get('/api/search?q=release notes from:ada');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.length, 0, 'a reader outside the community is told nothing');

    const inOther = await stranger.get('/api/search?q=release notes in:announcements');
    assert.equal(inOther.status, 200);
    assert.equal(inOther.data.length, 0);
  });

  await t.test('a member sees the community they are in', async () => {
    const res = await bob.get('/api/search?q=release notes');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.length >= 1);
    for (const row of res.data) {
      assert.equal(row.server_id, serverId, 'every answer is from the community bob is in');
    }
  });
});

test('saved searches and the search history', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const bob = await registerUser(ws, 'bob');

  await t.test('a saved search belongs to its owner', async () => {
    const created = await ada.post('/api/search/saved', { name: 'My notes', query: 'release notes from:ada' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.name, 'My notes');
    assert.equal(created.data.query, 'release notes from:ada');

    const mine = await ada.get('/api/search/saved');
    assert.equal(mine.status, 200);
    assert.equal(mine.data.length, 1);

    const theirs = await bob.get('/api/search/saved');
    assert.equal(theirs.status, 200);
    assert.equal(theirs.data.length, 0, 'the list is the owner\'s alone');

    const read = await bob.get('/api/search/saved/' + created.data.id);
    assert.equal(read.status, 404, 'another reader cannot read it');

    const changed = await bob.patch('/api/search/saved/' + created.data.id, { name: 'Mine now' });
    assert.equal(changed.status, 404, 'another reader cannot change it');

    const removed = await bob.delete('/api/search/saved/' + created.data.id);
    assert.equal(removed.status, 404, 'another reader cannot delete it');

    const still = await ada.get('/api/search/saved');
    assert.equal(still.data.length, 1, 'the saved search is still there');
  });

  await t.test('a saved search can be renamed and deleted by its owner', async () => {
    const list = await ada.get('/api/search/saved');
    const id = list.data[0].id;
    const renamed = await ada.patch('/api/search/saved/' + id, { name: 'Renamed' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    assert.equal(renamed.data.name, 'Renamed');
    assert.equal(renamed.data.query, 'release notes from:ada', 'the query is unchanged');

    const removed = await ada.delete('/api/search/saved/' + id);
    assert.equal(removed.status, 200);
    const after = await ada.get('/api/search/saved');
    assert.equal(after.data.length, 0);
  });

  await t.test('the history is the reader\'s own, newest first', async () => {
    await ada.get('/api/search?q=first query');
    await ada.get('/api/search?q=second query');
    await ada.get('/api/search?q=third query');

    const mine = await ada.get('/api/search/history');
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.data.map((row) => row.query), ['third query', 'second query', 'first query']);

    const theirs = await bob.get('/api/search/history');
    assert.equal(theirs.status, 200);
    assert.equal(theirs.data.length, 0, 'the history is the reader\'s own');
  });

  await t.test('the history is bounded', async () => {
    await ws.db.upsert(
      'instance_settings',
      ['key', 'value', 'updated_at'],
      ['search.historyLimit', '5', new Date().toISOString()],
      ['key'],
      { value: ws.db.newRef('value'), updated_at: ws.db.newRef('updated_at') }
    );
    // The setting is read per request through the store, so it is reloaded.
    await require('../../src/services/settings').load(true);

    for (let i = 0; i < 9; i += 1) {
      await ada.get('/api/search?q=bounded query ' + i);
    }
    const history = await ada.get('/api/search/history');
    assert.equal(history.status, 200);
    assert.equal(history.data.length, 5, 'the list keeps only the last five');

    await ws.db.run('DELETE FROM instance_settings WHERE `key` = ?', ['search.historyLimit']);
    await require('../../src/services/settings').load(true);
  });

  await t.test('the history can be cleared', async () => {
    const cleared = await ada.delete('/api/search/history');
    assert.equal(cleared.status, 200);
    const history = await ada.get('/api/search/history');
    assert.equal(history.data.length, 0);
  });
});
