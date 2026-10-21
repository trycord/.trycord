// The notes a community's moderators keep about the people in it.
//
// A note is a moderator's private record of what they think of a member: what
// was said, what was tried, what to watch for. So the rules are about who
// sees it:
//
//   - the member the note is about never sees it;
//   - a member of the community who cannot moderate never sees it either;
//   - and one note per member, so writing again replaces rather than piles
//     up.
//
// And every one of those rules is checked here, because a note that leaks is
// worse than no note at all.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test("a community's notes about its members", async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const moderator = await registerUser(instance, 'moderator');
  const member = await registerUser(instance, 'member');
  const stranger = await registerUser(instance, 'stranger');

  const community = await owner.post('/api/servers', {
    name: 'The notes', description: 'A community with notes.',
  });
  const serverId = community.data.serverId;

  const join = await moderator.post('/api/servers/join/' + community.data.joinCode, {});
  assert.ok(join.status < 400, 'the moderator could not join');
  await member.post('/api/servers/join/' + community.data.joinCode, {});
  await stranger.post('/api/servers/join/' + community.data.joinCode, {});

  await t.test('a note can be written about a member', async () => {
    const written = await owner.put('/api/servers/' + serverId + '/notes/' + member.user.id, {
      body: 'Spoke out of turn twice, but it was the heat of the moment.',
    });
    assert.equal(written.status, 200, JSON.stringify(written.data));
    assert.equal(written.data.note.body,
      'Spoke out of turn twice, but it was the heat of the moment.');
    assert.equal(written.data.note.userId, member.user.id);
  });

  await t.test('the note can be read back', async () => {
    const read = await owner.get('/api/servers/' + serverId + '/notes/' + member.user.id);
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.note.body,
      'Spoke out of turn twice, but it was the heat of the moment.');
    assert.ok(read.data.note.authorName, 'the note does not say who wrote it');
  });

  await t.test('writing again replaces the earlier note', async () => {
    const written = await owner.put('/api/servers/' + serverId + '/notes/' + member.user.id, {
      body: 'Settled down after somebody spoke to them.',
    });
    assert.equal(written.status, 200, JSON.stringify(written.data));

    const read = await owner.get('/api/servers/' + serverId + '/notes/' + member.user.id);
    assert.equal(read.data.note.body, 'Settled down after somebody spoke to them.');
  });

  await t.test('the member the note is about never sees it', async () => {
    const read = await member.get('/api/servers/' + serverId + '/notes/' + member.user.id);
    assert.ok(read.status === 403 || read.status === 404,
      'the member read their own note: ' + read.status);
  });

  await t.test('a member who cannot moderate never sees it', async () => {
    const read = await member.get('/api/servers/' + serverId + '/notes');
    assert.ok(read.status === 403 || read.status === 404,
      'an ordinary member read the notes: ' + read.status);
  });

  await t.test('a note cannot be written about somebody outside the community', async () => {
    const outsider = await registerUser(instance, 'outsider');
    const written = await owner.put('/api/servers/' + serverId + '/notes/' + outsider.user.id, {
      body: 'Somebody who is not here.',
    });
    assert.ok(written.status === 400 || written.status === 403 || written.status === 404,
      'a note was written about somebody who is not a member: ' + written.status);
    assert.equal(written.data.error.code, 'NOT_A_MEMBER',
      'the refusal does not say why: ' + JSON.stringify(written.data));
  });

  await t.test('a note needs some words in it', async () => {
    const written = await owner.put('/api/servers/' + serverId + '/notes/' + member.user.id, {
      body: '   ',
    });
    assert.equal(written.status, 400, JSON.stringify(written.data));
  });

  await t.test('a note has a length', async () => {
    const written = await owner.put('/api/servers/' + serverId + '/notes/' + member.user.id, {
      body: 'x'.repeat(2001),
    });
    assert.equal(written.status, 400, JSON.stringify(written.data));
  });

  await t.test('the notes of the community can be listed', async () => {
    const listed = await owner.get('/api/servers/' + serverId + '/notes');
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.equal(listed.data.notes.length, 1, 'the list is not what was written');
    assert.equal(listed.data.notes[0].userId, member.user.id);
  });

  await t.test('a note can be taken away', async () => {
    const removed = await owner.delete('/api/servers/' + serverId + '/notes/' + member.user.id);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.removed, true, 'the note was not there to take away');

    const read = await owner.get('/api/servers/' + serverId + '/notes/' + member.user.id);
    assert.equal(read.data.note, null, 'the note is still there');
  });

  await t.test('taking away a note that is not there says so', async () => {
    const removed = await owner.delete('/api/servers/' + serverId + '/notes/' + member.user.id);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.removed, false, 'it claimed to have removed something');
  });
});
