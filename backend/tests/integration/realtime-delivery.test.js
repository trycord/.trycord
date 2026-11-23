// A post made over REST reaches a watching socket as a live event.
//
// The reported defect was an app that "only did things on a reload": the
// history read carried everything a row needs, but the live event path did
// not run for a session that began in place, and the event itself described
// no author - so the reader saw nothing until they refreshed, and initials
// even then. The client connects on sign-in now; this test holds the server
// side of the promise: whatever is written through the API arrives on the
// socket, named and faced, without a reload.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startInstance, registerUser } = require('../helpers/instance');

/** Open a socket for a signed-in account, watching one channel. */
async function openSocket(instance, api, channelId) {
  const ticket = await api.post('/api/auth/ws/ticket', {});
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  const socket = new WebSocket('ws://127.0.0.1:' + instance.port + '/?ticket=' + ticket.data.ticket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const events = [];
  socket.on('message', (raw) => {
    try { events.push(JSON.parse(raw.toString())); } catch { /* not an event */ }
  });
  if (channelId) {
    socket.send(JSON.stringify({ type: 'join', channelId }));
    // The join frame and the post must land in separate turns of the event
    // loop, so the room is joined before the message that needs it is sent.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { socket, events };
}

/** The first event of a type, waiting up to a moment for it. */
async function firstEvent(events, type, ms) {
  const deadline = Date.now() + (ms || 3000);
  for (;;) {
    const found = events.find((e) => e.type === type);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a post over REST arrives live on a watching socket', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const watcher = await registerUser(instance, 'watcher');

  const community = await owner.post('/api/servers', { name: 'Live wire' });
  const serverId = community.data.serverId;
  await watcher.post('/api/servers/join/' + community.data.joinCode, {});

  const category = await owner.post('/api/servers/' + serverId + '/categories', { name: 'Rooms' });
  const made = await owner.post('/api/servers/' + serverId + '/channels', {
    name: 'general', topic: 'The main room.', type: 'text', categoryId: category.data.id,
  });
  const channelId = made.data.id;

  const live = await openSocket(instance, watcher, channelId);
  t.after(() => live.socket.close());

  // The watcher's client posts through the ordinary REST door - the same door
  // the app's composer uses. The event must reach the other socket on its own;
  // nothing here refetches history.
  const posted = await owner.post('/api/channels/' + channelId + '/messages', { content: 'live one' });
  assert.equal(posted.status, 200, JSON.stringify(posted.data));

  const event = await firstEvent(live.events, 'message');
  assert.ok(event, 'the message event arrived without a reload');
  assert.equal(event.id, posted.data.id);
  assert.equal(event.content, 'live one');

  await t.test('the live event names its author, with a face', async () => {
    assert.equal(event.author_name, owner.user.username, 'the author is named on the event');
    assert.ok('author_avatar' in event, 'author_avatar present (null is legitimate, absent is not)');
    assert.ok('author_display' in event);
    assert.ok('author_is_bot' in event);
  });

  await t.test('an edit arrives live too, and keeps the face', async () => {
    const edited = await owner.patch('/api/channels/' + channelId + '/messages/' + posted.data.id, {
      content: 'edited live',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));

    const event = await firstEvent(live.events, 'message_updated');
    assert.ok(event, 'the edit event arrived without a reload');
    assert.equal(event.content, 'edited live');
    assert.equal(event.author_name, owner.user.username);
    assert.ok('author_avatar' in event, 'the edit event must not strip the face');
  });

  await t.test('a structural change reaches the server room', async () => {
    // The watcher's socket joins the community's room the way the client
    // does - a join-server frame - and the community itself changes on
    // another account's say-so. The rename must reach the room on its own.
    live.socket.send(JSON.stringify({ type: 'join-server', serverId }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const renamed = await owner.patch('/api/servers/' + serverId, { name: 'After the name' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

    const deadline = Date.now() + 3000;
    let found = null;
    while (!(found = live.events.find((e) => e.type === 'server_updated'))) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(found, 'the server_updated event arrived without a reload');
    assert.equal((found.server_id || found.serverId || (found.server && found.server.id)), serverId,
      'the event names the community it is about');
  });

  live.socket.close();
  // The server's cleanup for a closed socket (presence, registry) runs
  // asynchronously; letting it settle here keeps it off the instance stop,
  // where its work would arrive after the database has gone.
  await new Promise((resolve) => setTimeout(resolve, 100));
});
