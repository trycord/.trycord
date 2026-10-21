// Joining, leaving and coming back.
//
// A person who has left a room and comes back to it has to be able to: the
// room keeps one row per person per channel - the time they were there is
// on the row - so a rejoin updates that row.
//
// It used to look only for a row with no leaving time, which meant a rejoin
// inserted a second row, and the insert was refused by the very uniqueness
// that was meant to keep one row per person. The refusal came back as a
// duplicate key, and the join failed with it: a person could join a room
// once and never again.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startRelay, voiceInstance, voiceChannel, joinCommunity,
} = require('./helpers');

test('a seat can be taken again', async (t) => {
  const relay = await startRelay();
  const { instance, owner, member } = await voiceInstance({
    env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
  });
  t.after(async () => { relay.close(); await instance.stop(); });

  const { channelId, joinCode } = await voiceChannel(owner);
  await joinCommunity(member, joinCode);

  await t.test('a member joins a room', async () => {
    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.ok(res.data.sessionId, 'the seat has a session');
  });

  await t.test('a member leaves a room', async () => {
    const res = await member.post('/api/voice/channels/' + channelId + '/leave', {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
  });

  await t.test('a member comes back to the room they left', async () => {
    // The join that used to fail with a duplicate key.
    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 201,
      'the member could not come back: ' + JSON.stringify(res.data));
    assert.ok(res.data.sessionId, 'the seat has a session');
  });

  await t.test('the room holds one row for the member', async () => {
    const rows = await instance.db.all(
      'SELECT COUNT(*) AS n FROM voice_participants WHERE channel_id = ? AND user_id = ?',
      [channelId, member.user.id]
    );
    assert.equal(rows[0].n, 1,
      'the room holds ' + rows[0].n + ' rows for one member');
  });

  await t.test('the row says the member is there', async () => {
    const rows = await instance.db.all(
      'SELECT left_at FROM voice_participants WHERE channel_id = ? AND user_id = ?',
      [channelId, member.user.id]
    );
    assert.equal(rows[0].left_at, null, 'the row still says the member left');
  });

  await t.test('the room roster names the member once', async () => {
    const res = await member.get('/api/voice/channels/' + channelId + '/mesh-peers');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const names = (res.data.participants || []).filter((id) => String(id) === String(member.user.id));
    assert.equal(names.length, 1,
      'the roster names the member ' + names.length + ' times');
  });

  await t.test('a member can come back again and again', async () => {
    for (let round = 0; round < 3; round += 1) {
      await member.post('/api/voice/channels/' + channelId + '/leave', {});
      const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
      assert.equal(res.status, 201,
        'round ' + round + ' failed: ' + JSON.stringify(res.data));
    }
    const rows = await instance.db.all(
      'SELECT COUNT(*) AS n FROM voice_participants WHERE channel_id = ? AND user_id = ?',
      [channelId, member.user.id]
    );
    assert.equal(rows[0].n, 1, 'the room holds ' + rows[0].n + ' rows for one member');
  });
});
