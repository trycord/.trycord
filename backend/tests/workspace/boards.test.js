// Boards: cards, activity, concurrency and the conversion of a message into
// a task.
//
// The concurrency rule is the interesting one: two people editing the same
// card must not lose each other's work silently. One edit lands, the other
// is refused with the version that is current.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startWorkspace, createCommunity, addMember, channelsOf, postMessage, registerUser,
} = require('./helpers');

test('boards', async (t) => {
  const ws = await startWorkspace();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'ada');
  const serverId = await createCommunity(ws, owner, 'Boards');
  const member = await addMember(ws, owner, serverId, 'bob');

  const board = await owner.post(`/api/servers/${serverId}/boards`, { name: 'Sprint' });
  assert.equal(board.status, 201, JSON.stringify(board.data));
  const boardId = board.data.id;
  const columns = board.data.columns;
  assert.equal(columns.length, 3, 'a board starts with its lanes');

  await t.test('a card is created, assigned and moved, and the activity records it', async () => {
    const created = await member.post(`/api/servers/${serverId}/boards/${boardId}/cards`, {
      title: 'Write the report',
      columnId: columns[0].id,
      assigneeId: owner.user.id,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      dueTimezone: 'Europe/Berlin',
      priority: 'high',
      labels: ['docs'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const cardId = created.data.id;
    assert.equal(created.data.assigneeId, owner.user.id);
    assert.equal(created.data.priority, 'high');
    assert.equal(created.data.version, 1);
    assert.deepEqual(created.data.labels, ['docs']);
    assert.equal(created.data.dueTimezone, 'Europe/Berlin');

    const moved = await member.post(`/api/servers/${serverId}/boards/${boardId}/cards/${cardId}/move`, {
      columnId: columns[1].id,
      version: 1,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.equal(moved.data.columnId, columns[1].id);
    assert.equal(moved.data.version, 2, 'the move is a change, so the version moves on');

    const activity = await member.get(`/api/servers/${serverId}/boards/${boardId}/cards/${cardId}/activity`);
    assert.equal(activity.status, 200);
    const fields = activity.data.map((a) => a.field);
    assert.ok(fields.includes('created'), 'the creation is in the activity');
    assert.ok(fields.includes('column'), 'the move is in the activity');
    assert.ok(activity.data.every((a) => a.actorId), 'every entry says who did it');
  });

  await t.test('two edits of the same card produce one edit and one conflict', async () => {
    const created = await member.post(`/api/servers/${serverId}/boards/${boardId}/cards`, {
      title: 'Contested',
      columnId: columns[0].id,
    });
    const cardId = created.data.id;

    const first = await member.patch(`/api/servers/${serverId}/boards/${boardId}/cards/${cardId}`, {
      title: 'Contested, edited by one person',
      version: 1,
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.version, 2);

    const second = await member.patch(`/api/servers/${serverId}/boards/${boardId}/cards/${cardId}`, {
      title: 'Contested, edited by another',
      version: 1,
    });
    assert.equal(second.status, 409, 'the second edit is refused');
    assert.equal(second.data.error.code, 'CONFLICT');
    assert.equal(second.data.error.details.currentVersion, 2);
    assert.equal(second.data.error.details.submittedVersion, 1);

    const read = await member.get(`/api/servers/${serverId}/boards/${boardId}/cards/${cardId}`);
    assert.equal(read.data.title, 'Contested, edited by one person', 'the refused edit did not land');
    assert.equal(read.data.version, 2);
  });

  await t.test('a card made from a message keeps the link back to it', async () => {
    const channels = await channelsOf(owner, serverId);
    const message = await postMessage(owner, channels[0].id, 'The login button is broken');
    assert.ok(message.id);

    const converted = await owner.post(`/api/servers/${serverId}/boards/${boardId}/cards/from-message`, {
      messageId: message.id,
    });
    assert.equal(converted.status, 201, JSON.stringify(converted.data));
    assert.equal(converted.data.sourceMessageId, message.id);
    assert.equal(converted.data.sourceChannelId, channels[0].id);
    assert.equal(converted.data.title, 'The login button is broken', 'the card starts from the message');
    assert.ok(
      converted.data.links.some((l) => l.kind === 'message' && l.targetId === message.id),
      'the card links back to the message it came from'
    );

    const activity = await owner.get(
      `/api/servers/${serverId}/boards/${boardId}/cards/${converted.data.id}/activity`
    );
    assert.ok(activity.data.some((a) => a.field === 'created from message'));
  });

  await t.test('a card from another community is refused', async () => {
    const other = await createCommunity(ws, owner, 'Other boards');
    const otherBoard = await owner.post(`/api/servers/${other}/boards`, { name: 'Elsewhere' });
    const res = await owner.post(`/api/servers/${serverId}/boards/${boardId}/cards`, {
      title: 'Out of place',
      columnId: otherBoard.data.columns[0].id,
    });
    assert.equal(res.status, 404);
  });

  await t.test('a card can be filed under a milestone and linked to a channel', async () => {
    const milestone = await owner.post(`/api/servers/${serverId}/boards/${boardId}/milestones`, {
      name: 'Release 1',
      dueAt: new Date(Date.now() + 604800000).toISOString(),
      dueTimezone: 'UTC',
    });
    assert.equal(milestone.status, 201, JSON.stringify(milestone.data));

    const created = await member.post(`/api/servers/${serverId}/boards/${boardId}/cards`, {
      title: 'Ship the release',
      columnId: columns[0].id,
    });
    const cardId = created.data.id;

    const filed = await member.post(
      `/api/servers/${serverId}/boards/${boardId}/cards/${cardId}/milestones`,
      { milestoneId: milestone.data.id }
    );
    assert.equal(filed.status, 201, JSON.stringify(filed.data));
    assert.ok(filed.data.milestones.some((m) => m.id === milestone.data.id));

    const channels = await channelsOf(owner, serverId);
    const linked = await member.post(
      `/api/servers/${serverId}/boards/${boardId}/cards/${cardId}/links`,
      { kind: 'channel', targetId: channels[0].id }
    );
    assert.equal(linked.status, 201, JSON.stringify(linked.data));
    assert.ok(linked.data.links.some((l) => l.kind === 'channel' && l.targetId === channels[0].id));
  });

  await t.test('a member of another community is refused', async () => {
    const outsider = await registerUser(ws, 'mallory');
    const list = await outsider.get(`/api/servers/${serverId}/boards`);
    assert.equal(list.status, 403);
    assert.equal(list.data.error.code, 'NOT_A_MEMBER');
  });
});
