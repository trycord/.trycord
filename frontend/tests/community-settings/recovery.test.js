// A save that fails keeps what was typed, and says what failed.
//
// The operator has typed the rules of their community. The server refuses.
// The box must still hold what they wrote - otherwise they have to write it
// all again, and the natural thing to do is give up and leave the rules
// empty.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find, buttonByText, type,
} from './helpers.js';

const { communitySettingsSections } = await import('../../js/features/communitySettings.js');
const { State } = await import('../../packages/store.js');

// The community this console is showing.
//
// It is set before each check rather than once at the top of the file: the
// checks share a process with the others, and one file's tidy-up must not
// take another's community away.
beforeEach(() => {
  State.servers = [{ id: 's1', name: 'The Community', permissions: ['*'], is_owner: true }];
  State.user = { id: 'u1', username: 'operator' };
});

// The community, as the server holds it.
function communityJson() {
  return {
    id: 's1',
    name: 'The Community',
    description: 'A place to talk.',
    is_public: true,
    is_discoverable: true,
    federated: true,
    join_code: 'join-me',
    permissions: ['*'],
    is_owner: true,
  };
}

function nameBox(node) {
  return find(node, (candidate) =>
    candidate.tagName === 'INPUT' && candidate.getAttribute('aria-label') === 'Community name')[0] || null;
}

test('a save that fails keeps what was typed and says what failed', async () => {
  // The community is read; the write is refused.
  const calls = installFetch(communityRoutes({
    'http://localhost/api/servers/s1': (body, seen) => {
      const last = seen[seen.length - 1];
      if (last.method !== 'PATCH') return { json: communityJson() };
      return {
        ok: false,
        status: 400,
        json: { error: { code: 'VALIDATION_ERROR', message: 'The name is not one the server accepts.' } },
      };
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  const box = nameBox(view.node);
  type(box, 'A community with a new name');

  const save = buttonByText(view.node, 'Save identity');
  assert.ok(save, 'the console cannot save the identity');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(box.value, 'A community with a new name', 'what was typed was thrown away');
  assert.match(view.node.textContent, /The name is not one the server accepts\./,
    'the console did not say what failed');
  assert.ok(calls.some((call) => call.method === 'PATCH'), 'the console did not try to save');
});

test('a save that fails leaves the section dirty', async () => {
  installFetch(communityRoutes({
    'http://localhost/api/servers/s1': (body, seen) => {
      const last = seen[seen.length - 1];
      if (last.method !== 'PATCH') return { json: communityJson() };
      return {
        ok: false,
        status: 500,
        json: { error: { code: 'INTERNAL', message: 'The server fell over.' } },
      };
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  type(nameBox(view.node), 'A community with a new name');
  const save = buttonByText(view.node, 'Save identity');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(view.isDirty(), true, 'a failed save made the section look saved');
});

test('the error is announced, not only drawn', async () => {
  installFetch(communityRoutes({
    'http://localhost/api/servers/s1': (body, seen) => {
      const last = seen[seen.length - 1];
      if (last.method !== 'PATCH') return { json: communityJson() };
      return {
        ok: false,
        status: 500,
        json: { error: { code: 'INTERNAL', message: 'The server fell over.' } },
      };
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  type(nameBox(view.node), 'A community with a new name');
  buttonByText(view.node, 'Save identity').click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const alerts = find(view.node, (node) => node.getAttribute('role') === 'alert');
  assert.ok(alerts.length > 0, 'the failure was not announced');
  assert.match(alerts.map((node) => node.textContent).join(' '), /fell over/);
});
