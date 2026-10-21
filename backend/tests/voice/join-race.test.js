// Two joins at the same moment.
//
// A voice channel has one row per person, and the join path writes that row.
// Two joins at once - a double tap, a retry after a timeout, two tabs opening
// the same channel - both read "no row yet", and the second insert was
// refused by the uniqueness that keeps one row per person. The refusal came
// back as a duplicate key, and the join failed with it.
//
// The live instance's log showed it happening: a MySQL duplicate entry for
// (channel, user) every time the same person joined twice at once.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, registerUser } = require('../helpers/instance');
const { voiceChannel } = require('./helpers');

test('two joins at once leave one participant row', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  // The owner made the community, so they are already in it.
  const { channelId } = await voiceChannel(owner);

  const voice = require('../../src/services/voice');

  // Both joins are started before either is awaited, which is what a double
  // tap does.
  const both = await Promise.all([
    voice.recordParticipant({
      channelId, userId: owner.user.id, roomId: 'room-1', sessionId: 'session-1', provider: 'mesh',
    }),
    voice.recordParticipant({
      channelId, userId: owner.user.id, roomId: 'room-1', sessionId: 'session-1', provider: 'mesh',
    }),
  ]);

  assert.equal(both[0], both[1], 'both joins answer with the same participant');

  const rows = await instance.db.all(
    'SELECT id FROM voice_participants WHERE channel_id = ? AND user_id = ?',
    [channelId, owner.user.id]
  );
  assert.equal(rows.length, 1, 'there is one row for the person');

  const sessions = await instance.db.all(
    'SELECT id FROM voice_provider_sessions WHERE channel_id = ? AND user_id = ?',
    [channelId, owner.user.id]
  );
  assert.equal(sessions.length, 1, 'there is one provider session for the person');
});

test('a person who left can come back', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  // The owner made the community, so they are already in it.
  const { channelId } = await voiceChannel(owner);

  const voice = require('../../src/services/voice');

  await voice.recordParticipant({
    channelId, userId: owner.user.id, roomId: 'room-1', sessionId: 'session-1', provider: 'mesh',
  });
  await voice.endParticipant(channelId, owner.user.id);

  const again = await voice.recordParticipant({
    channelId, userId: owner.user.id, roomId: 'room-1', sessionId: 'session-2', provider: 'mesh',
  });
  assert.ok(again, 'the person is back in the channel');

  const rows = await instance.db.all(
    'SELECT id, session_id, left_at FROM voice_participants WHERE channel_id = ? AND user_id = ?',
    [channelId, owner.user.id]
  );
  assert.equal(rows.length, 1, 'there is still one row');
  assert.equal(rows[0].session_id, 'session-2', 'the row carries the new session');
  assert.equal(rows[0].left_at, null, 'the row says the person is here');
});
