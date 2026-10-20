// The console draws every section, and every section says it is working
// rather than showing an empty form.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find,
} from './helpers.js';

installFetch(communityRoutes());

const { communitySettingsSections } = await import('../../js/features/communitySettings.js');
const { State } = await import('../../packages/store.js');

State.servers = [{ id: 's1', name: 'The Community', permissions: ['*'], is_owner: true }];
State.user = { id: 'u1', username: 'operator' };

test('every section of the console is there', () => {
  const sections = communitySettingsSections();
  const wanted = [
    'overview', 'appearance', 'channels', 'categories', 'members', 'roles',
    'invites', 'moderation', 'voice', 'ownership', 'analytics', 'integrations',
  ];
  for (const id of wanted) {
    assert.equal(typeof sections.get(id), 'function', 'the console has no ' + id + ' section');
  }
});

test('every section draws something and loads', async () => {
  const sections = communitySettingsSections();
  for (const [id, build] of sections.entries()) {
    const view = build(communityContext());
    assert.ok(view && view.node, id + ' drew nothing');
    assert.ok((view.node.textContent || '').length > 20, id + ' drew nothing worth reading');
    if (view.onMount) {
      await view.onMount();
      assert.ok((view.node.textContent || '').length > 20, id + ' drew nothing after loading');
    }
    if (view.cleanup) view.cleanup();
  }
});

test('the console draws a rail of the sections, and the one that is open is marked', () => {
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  const links = find(view.node, (node) => node.tagName === 'A' && node.getAttribute('href'));
  const addresses = links.map((link) => link.getAttribute('href'));
  assert.ok(addresses.length >= 12, 'the rail does not carry every section');
  assert.ok(addresses.some((address) => address.indexOf('/settings/voice') !== -1),
    'the rail does not carry the voice section');
  const current = find(view.node, (node) => node.getAttribute('aria-current') === 'page');
  assert.equal(current.length, 1, 'the rail does not say which section is open');
});

test('a section that is loading says so', () => {
  // The server that never answers: the section is left holding what it
  // knows, which is that it is still working.
  globalThis.fetch = () => new Promise(() => {});
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  view.onMount();
  const loading = find(view.node, (node) => node.getAttribute('aria-busy') === 'true');
  assert.ok(loading.length > 0, 'the section did not say it was working');
});

test('a section that fails to load says what failed', async () => {
  const calls = installFetch(communityRoutes({
    'http://localhost/api/servers/s1': { ok: false, status: 500, json: { error: { code: 'X', message: 'The server said no.' } } },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();
  assert.match(view.node.textContent, /The server said no\./,
    'the section did not say what failed');
  assert.ok(calls.length > 0, 'the section did not ask the server at all');
});
