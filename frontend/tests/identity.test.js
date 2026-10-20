// Identity: who somebody is, and where their picture lives.
//
// The API is not consistent about the names it uses for the same thing, and
// every surface that read one of them by hand was a surface where the
// picture silently did not appear. So the name is resolved in one place, and
// this is that place.
//
// The three things about a person are kept apart: the display name is what
// they chose, the username is their address, and the id is the account.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  avatarUrlOf, bannerUrlOf, serverIconOf, serverBannerOf,
  displayNameOf, usernameOf,
} from '../packages/identity.js';

test('identity', async (t) => {
  await t.test('the picture of a person is found under any of the names', () => {
    const path = '/api/media/avatar/abc';
    for (const user of [
      { avatarUrl: path },
      { avatar_url: path },
      { authorAvatar: path },
      { author_avatar: path },
      { avatar: path },
    ]) {
      assert.equal(avatarUrlOf(user), path, JSON.stringify(user));
    }
  });

  await t.test('a person with no picture has none', () => {
    for (const user of [null, undefined, {}, { avatarUrl: null }, { avatarUrl: '' }]) {
      assert.equal(avatarUrlOf(user), null, JSON.stringify(user));
    }
  });

  await t.test('an absolute address is kept as it is', () => {
    assert.equal(avatarUrlOf({ avatarUrl: 'https://cdn.example.test/a.png' }),
      'https://cdn.example.test/a.png');
  });

  await t.test('a reference that is neither a path nor an address is dropped', () => {
    // A picture that is not there is better shown as initials than as a
    // broken image.
    for (const value of ['javascript:alert(1)', 'data:image/png;base64,xx', 'avatar.png', 'file:///etc/passwd']) {
      assert.equal(avatarUrlOf({ avatarUrl: value }), null, value);
    }
  });

  await t.test('a path on this instance is kept', () => {
    assert.equal(avatarUrlOf({ avatarUrl: '/api/media/avatar/abc' }), '/api/media/avatar/abc');
  });

  await t.test('the banner of a person is found under any of the names', () => {
    const path = '/api/media/banner/abc';
    assert.equal(bannerUrlOf({ bannerUrl: path }), path);
    assert.equal(bannerUrlOf({ banner_url: path }), path);
    assert.equal(bannerUrlOf({ banner: path }), path);
    assert.equal(bannerUrlOf({}), null);
  });

  await t.test('the picture of a community is found under any of the names', () => {
    const path = '/api/media/icon/abc';
    assert.equal(serverIconOf({ icon_url: path }), path);
    assert.equal(serverIconOf({ iconUrl: path }), path);
    assert.equal(serverIconOf({ icon: path }), path);
    assert.equal(serverIconOf({}), null);
  });

  await t.test('the cover of a community is found under any of the names', () => {
    const path = '/api/media/serverbanner/abc';
    assert.equal(serverBannerOf({ banner_url: path }), path);
    assert.equal(serverBannerOf({ bannerUrl: path }), path);
    assert.equal(serverBannerOf({}), null);
  });

  await t.test('the name, the address and the account are three things', () => {
    const user = {
      id: 'u1', username: 'ada', displayName: 'Ada Lovelace', nickname: 'Countess',
    };
    assert.equal(displayNameOf(user), 'Ada Lovelace');
    assert.equal(usernameOf(user), 'ada');
    assert.equal(user.id, 'u1');
  });

  await t.test('a nickname is a display name when there is no other', () => {
    assert.equal(displayNameOf({ nickname: 'Countess', username: 'ada' }), 'Countess');
  });

  await t.test('a person with no name at all has an empty one', () => {
    assert.equal(displayNameOf(null), '');
    assert.equal(displayNameOf({}), '');
    assert.equal(usernameOf(null), '');
  });
});
