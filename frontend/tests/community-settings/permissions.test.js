// The controls the server would refuse are not offered.
//
// A permission that is always refused is worse than no control at all: the
// operator presses it, waits, and is told no. So the console offers only
// what the reader may actually do - and the server refuses the rest anyway,
// which is what the checks in the backend prove.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find, buttonByText, openOverlays,
} from './helpers.js';

const { communitySettingsSections } = await import('../../js/features/communitySettings.js');
const { State } = await import('../../packages/store.js');

// An account that is in the community and can do almost nothing in it.
function asMember() {
  State.servers = [{ id: 's1', name: 'The Community', permissions: ['SEND_MESSAGES'], is_owner: false }];
  State.user = { id: 'u1', username: 'operator' };
}

// The owner, who may do everything.
function asOwner() {
  State.servers = [{ id: 's1', name: 'The Community', permissions: ['*'], is_owner: true }];
  State.user = { id: 'u1', username: 'operator' };
}

test('a member who cannot manage roles is offered no role controls', async () => {
  openOverlays();
  asMember();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('roles')(communityContext());
  await view.onMount();

  assert.equal(buttonByText(view.node, 'Give the role'), null,
    'the console offered to give a role to somebody');
  assert.equal(buttonByText(view.node, 'Remove'), null,
    'the console offered to remove a role');
});

test('the permission catalogue is still there to read', async () => {
  openOverlays();
  asMember();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('roles')(communityContext());
  await view.onMount();

  assert.match(view.node.textContent, /MANAGE_SERVER/,
    'the catalogue of permissions was not shown');
  assert.match(view.node.textContent, /Full server control/,
    'the catalogue did not say what the permissions mean');
});

test('a member who cannot manage channels is offered no overrides', async () => {
  openOverlays();
  asMember();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('categories')(communityContext());
  await view.onMount();

  assert.equal(find(view.node, (node) =>
    node.tagName === 'SELECT' && (node.getAttribute('aria-label') || '').indexOf('category to change') !== -1).length, 0,
  'the console offered to change what a category allows');
});

test('a member who cannot moderate is offered no ban controls', async () => {
  openOverlays();
  asMember();
  installFetch(communityRoutes({
    'http://localhost/api/servers/s1/bans': {
      json: [{ userId: 'u2', username: 'ada', displayName: 'Ada', reason: 'Spam' }],
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('moderation')(communityContext());
  await view.onMount();

  assert.equal(buttonByText(view.node, 'Lift'), null,
    'the console offered to lift a ban');
  assert.match(view.node.textContent, /cannot lift bans/i,
    'the console did not say why the ban list is empty');
});

test('the owner is offered all of it', async () => {
  openOverlays();
  asOwner();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('roles')(communityContext());
  await view.onMount();

  assert.ok(buttonByText(view.node, 'Give the role'), 'the owner was offered no role controls');
});
