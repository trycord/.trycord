// The emojis a community gives a name to.
//
// A community's own pictures, a short name each, one picture per name:
//
//   - a manager uploads a picture under a name, and the answer is the emoji;
//   - the name is the community's to keep: a second picture under a taken
//     name is refused, not a quiet replacement;
//   - the name rules are strict, because `:name:` has to read the same
//     everywhere it is typed;
//   - a member reads the list (rendering is what the list is for) and a
//     stranger is told nothing;
//   - the picture is a real picture: what the sniffer refuses never becomes
//     an emoji, and what is too big never lands;
//   - taking a name away takes the picture with it;
//   - a short code hangs on a message as a feeling, in a channel and in a
//     conversation, and a code that is not a code is refused.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

// A 1x1 transparent PNG, small enough to pass under every cap.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function emojiForm(buffer, name, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: 'image/png' }), filename || 'sparkle.png');
  fd.append('name', name);
  return fd;
}

test('the emojis of a community', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');
  const stranger = await registerUser(instance, 'stranger');

  const community = await owner.post('/api/servers', { name: 'Marks' });
  assert.equal(community.status, 200, JSON.stringify(community.data));
  const serverId = community.data.serverId;
  await member.post('/api/servers/join/' + community.data.joinCode, {});

  await t.test('a manager names a picture, and the answer is the emoji', async () => {
    const res = await owner.post('/api/servers/' + serverId + '/emojis', emojiForm(PNG, 'Sparkle'));
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.name, 'sparkle', 'the name is kept lowercase');
    assert.equal(res.data.serverId, serverId);
    assert.ok(res.data.id, 'the emoji carries an id');
    assert.ok(res.data.mediaId, 'the emoji carries the picture it is');
    assert.equal(res.data.url, '/api/servers/media/' + res.data.mediaId);
    assert.equal(res.data.creatorId, owner.user.id);
  });

  await t.test('the picture serves through the media route', async () => {
    const list = await owner.get('/api/servers/' + serverId + '/emojis');
    const mediaId = list.data[0].mediaId;
    const img = await owner.get('/api/servers/media/' + mediaId);
    assert.equal(img.status, 200, 'the picture does not serve');
    assert.ok(String(img.headers.get('content-type') || '').startsWith('image/'),
      'the picture serves as an image');
  });

  await t.test('a member reads the list, and a stranger is told nothing', async () => {
    const mine = await member.get('/api/servers/' + serverId + '/emojis');
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    assert.equal(mine.data.length, 1);
    assert.equal(mine.data[0].name, 'sparkle');

    const outside = await stranger.get('/api/servers/' + serverId + '/emojis');
    assert.ok(outside.status >= 400, 'a stranger read the list: ' + JSON.stringify(outside.data));
  });

  await t.test('one picture per name', async () => {
    const res = await owner.post('/api/servers/' + serverId + '/emojis', emojiForm(PNG, 'sparkle'));
    assert.equal(res.status, 409, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'CONFLICT');
  });

  await t.test('a name that is not a name is refused', async () => {
    for (const bad of ['a', 'has space', 'exclamation!', ':colon:', 'UPPER-CASE', 'x'.repeat(31), '']) {
      const res = await owner.post('/api/servers/' + serverId + '/emojis', emojiForm(PNG, bad));
      assert.equal(res.status, 400, 'the name "' + bad + '" was accepted: ' + JSON.stringify(res.data));
    }
  });

  await t.test('what is not a picture never becomes one', async () => {
    const res = await owner.post('/api/servers/' + serverId + '/emojis',
      emojiForm(Buffer.from('<script>alert(1)</script>'), 'scripty'));
    assert.equal(res.status, 400, JSON.stringify(res.data));
    const list = await owner.get('/api/servers/' + serverId + '/emojis');
    assert.equal(list.data.length, 1, 'the refusal left nothing behind');
  });

  await t.test('a picture that is too big never lands', async () => {
    // PNG signature plus filler: the bytes open as a PNG, the size refuses.
    const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024, 0)]);
    const res = await owner.post('/api/servers/' + serverId + '/emojis', emojiForm(big, 'huge'));
    assert.equal(res.status, 413, JSON.stringify(res.data));
  });

  await t.test('managing is a settings question, and a member is not a manager', async () => {
    const res = await member.post('/api/servers/' + serverId + '/emojis', emojiForm(PNG, 'members'));
    assert.equal(res.status, 403, JSON.stringify(res.data));
    const removal = await member.delete('/api/servers/' + serverId + '/emojis/no-such');
    assert.equal(removal.status, 403, JSON.stringify(removal.data));
  });

  await t.test('taking a name away takes the picture with it', async () => {
    const list = await owner.get('/api/servers/' + serverId + '/emojis');
    const emoji = list.data[0];

    const res = await owner.delete('/api/servers/' + serverId + '/emojis/' + emoji.id);
    assert.equal(res.status, 200, JSON.stringify(res.data));

    const after = await owner.get('/api/servers/' + serverId + '/emojis');
    assert.equal(after.data.length, 0, 'the name is gone from the list');

    const img = await owner.get('/api/servers/media/' + emoji.mediaId);
    assert.equal(img.status, 404, 'the picture outlived the name');
  });

  await t.test('an emoji that is not there is a not-found', async () => {
    const res = await owner.delete('/api/servers/' + serverId + '/emojis/no-such-emoji');
    assert.equal(res.status, 404, JSON.stringify(res.data));
  });
});

test('a short code hangs on a message as a feeling', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const friend = await registerUser(instance, 'friend');

  const community = await owner.post('/api/servers', { name: 'Marks' });
  const serverId = community.data.serverId;
  const made = await owner.post('/api/servers/' + serverId + '/channels', { name: 'general', type: 'text' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const channelId = made.data.id;

  const posted = await owner.post('/api/channels/' + channelId + '/messages', { content: 'the work begins' });
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  const messageId = posted.data.id;

  await t.test('a code is a feeling, in a channel', async () => {
    const res = await owner.post('/api/channels/' + channelId + '/messages/' + messageId + '/reactions',
      { emoji: ':sparkle:' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.reactions[0].emoji, ':sparkle:');
  });

  await t.test('the code reads the same however it was typed', async () => {
    const res = await owner.post('/api/channels/' + channelId + '/messages/' + messageId + '/reactions',
      { emoji: ':SPARKLE:' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.reactions, [{
      emoji: ':sparkle:', count: 1, mine: true, users: [String(owner.user.id)],
    }], 'the capitalised code is the same feeling, not a second one');
  });

  await t.test('a code that is not a code is refused', async () => {
    for (const bad of [':a:', ':has space:', ':no-colon-end', ':x!:']) {
      const res = await owner.post('/api/channels/' + channelId + '/messages/' + messageId + '/reactions',
        { emoji: bad });
      assert.equal(res.status, 400, 'the code "' + bad + '" was accepted: ' + JSON.stringify(res.data));
    }
  });

  await t.test('a code is a feeling, in a conversation', async () => {
    await owner.post('/api/friends/request', { userId: friend.user.id });
    await friend.post('/api/friends/accept/' + owner.user.id, {});
    const opened = await owner.post('/api/dms', { userId: friend.user.id });
    assert.equal(opened.status, 200, JSON.stringify(opened.data));
    const sent = await owner.post('/api/dms/' + opened.data.id + '/messages', { content: 'look at this' });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));

    const res = await friend.post('/api/dms/' + opened.data.id + '/messages/' + sent.data.id + '/reactions',
      { emoji: ':sparkle:' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.reactions[0].emoji, ':sparkle:');
  });
});
