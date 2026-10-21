import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, waitFor } from './helpers/dom-stub.js';

const dom = installDomStub();
dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

const { State } = await import('../packages/store.js');
const { renderDms } = await import('../mobile/js/views/dms.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

test('a group can be created from the mobile conversation list', async () => {
  State.user = { id: 'me', username: 'ada', displayName: 'Ada' };
  State.friends = [{ id: 'friend-1', username: 'lin', displayName: 'Lin' }];
  State.dms = [];
  const calls = [];
  let navigated = null;
  window.addEventListener('trycord:navigate', (event) => { navigated = event.detail.route; });
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

  const view = renderDms();
  await view.onMount();
  const start = find(view.node, (node) => node.tagName === 'BUTTON' && node.textContent === 'New group')[0];
  assert.ok(start, 'the group action is visible without first opening a conversation');
  start.click();

  const name = await waitFor(() => find(document.body, (node) => node.tagName === 'INPUT'
    && node.getAttribute('aria-label') === 'Group name')[0]);
  assert.ok(name, 'the group name field opened');
  name.value = 'Weekend plans';
  const friend = find(document.body, (node) => node.tagName === 'BUTTON'
    && node.textContent.includes('Lin'))[0];
  assert.ok(friend, 'the friend is available to invite');
  friend.click();

  const create = find(document.body, (node) => node.tagName === 'BUTTON'
    && node.textContent === 'Create group')[0];
  assert.ok(create);
  create.click();
  assert.ok(await waitFor(() => navigated === '/dms/group-1'), 'the new group opens after it is saved');

  const request = calls.find((call) => call.address.endsWith('/api/dms/groups'));
  assert.deepEqual(request.body, { name: 'Weekend plans', userIds: ['friend-1'] });
  view.cleanup();
});
