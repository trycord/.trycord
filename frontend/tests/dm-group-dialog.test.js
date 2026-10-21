// Making a group on the desk.
//
// The dialog that makes a group asked for its buttons and was not given
// them: the dialog drew a name field, a list of friends and nothing else, so
// there was no way to finish. The feature was there and could not be used.
//
// The check is on the buttons themselves, and on what the Create button
// does.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from './helpers/dom-stub.js';

installDomStub();

const { State } = await import('../packages/store.js');
const { renderDms } = await import('../js/features/dms.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function byText(node, needle) {
  return find(node, (candidate) => candidate.tagName === 'BUTTON'
    && (candidate.textContent || '').indexOf(needle) !== -1)[0] || null;
}

test('the desktop group dialog has its buttons', async (t) => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    calls.push({ address, body: options.body ? JSON.parse(options.body) : null });
    const answer = address.endsWith('/api/dms/groups')
      ? { id: 'group-1', name: 'Weekend plans', isGroup: true }
      : [];
    return {
      ok: true,
      status: address.endsWith('/api/dms/groups') ? 201 : 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => answer,
    };
  };

  State.user = { id: 'me', username: 'ada', displayName: 'Ada' };
  State.friends = [{ id: 'friend-1', username: 'lin', displayName: 'Lin' }];
  State.dms = [];

  const view = renderDms();
  await view.onMount();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const start = byText(view.node, 'New group');
  assert.ok(start, 'the group action is on the list');
  start.click();

  const dialog = await waitFor(() => document.body.querySelector('.dialog'));
  assert.ok(dialog, 'the dialog opened');

  const create = byText(dialog, 'Create');
  assert.ok(create, 'the dialog has a way to create the group');
  assert.ok(byText(dialog, 'Cancel'), 'the dialog has a way out');

  // The name and the friend.
  const name = find(dialog, (node) => node.tagName === 'INPUT')[0];
  assert.ok(name, 'the dialog asks for a name');
  name.value = 'Weekend plans';
  const friend = find(dialog, (node) => node.tagName === 'BUTTON'
    && (node.textContent || '').indexOf('Lin') !== -1)[0];
  assert.ok(friend, 'the dialog lists the friends');
  friend.click();

  create.click();
  assert.ok(await waitFor(() => calls.some((call) => call.address.endsWith('/api/dms/groups'))),
    'the group was made');
  const request = calls.find((call) => call.address.endsWith('/api/dms/groups'));
  assert.deepEqual(request.body, { name: 'Weekend plans', userIds: ['friend-1'] });
  view.cleanup();
});
