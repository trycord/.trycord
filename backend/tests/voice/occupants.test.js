// Who is in a voice room, and how the reader learns it.
//
// A room that lists "Unknown" for everybody tells the reader nothing, and a
// channel list that does not say who is in a room makes a member join a room
// to find out. Both are checked here: the server names the people, and the
// channel list carries them.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  voiceInstance, voiceChannel, joinCommunity, startRelay,
} = require('./helpers');

test('the people in a voice room', async (t) => {
  await t.test('the room names the people in it', async () => {
    const relay = await startRelay();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const joined = await member.post('/api/voice/channels/' + channelId + '/mesh-join', {});
    assert.equal(joined.status, 201, JSON.stringify(joined.data));

    const peers = await member.get('/api/voice/channels/' + channelId + '/mesh-peers');
    assert.equal(peers.status, 200, JSON.stringify(peers.data));
    const people = peers.data.people;
    assert.ok(Array.isArray(people), 'the peers answer carries the people');
    const mine = people.find((person) => person.userId === member.user.id);
    assert.ok(mine, 'the reader is in the list of people');
    assert.equal(mine.username, 'member');
    assert.ok(mine.displayName, 'the person is named');
  });

  await t.test('the channel list carries the people in its voice channels', async () => {
    const relay = await startRelay();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const { serverId, channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);
    await member.post('/api/voice/channels/' + channelId + '/mesh-join', {});

    const tree = await member.get('/api/servers/' + serverId + '/channels');
    assert.equal(tree.status, 200, JSON.stringify(tree.data));
    const channel = tree.data.channels.find((entry) => entry.id === channelId);
    assert.ok(channel, 'the voice channel is in the list');
    assert.ok(Array.isArray(channel.participants), 'the voice channel carries its people');
    assert.equal(channel.participants.length, 1, 'one person is in the room');
    assert.equal(channel.participants[0].username, 'member');

    // A text channel has nobody in it, so it says nothing.
    const text = await owner.post('/api/servers/' + serverId + '/channels', {
      name: 'Words', type: 'text',
    });
    assert.equal(text.status, 200, JSON.stringify(text.data));
    const after = await member.get('/api/servers/' + serverId + '/channels');
    const words = after.data.channels.find((entry) => entry.id === text.data.id);
    assert.ok(words, 'the text channel is in the list');
    assert.equal(words.participants, undefined,
      'a text channel does not carry a list of people');
  });
});
