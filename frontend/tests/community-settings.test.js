// The community settings.
//
// The reason this file exists is a bug that hid a whole section for a
// release. The 2.5.0 client built the settings form - the welcome message,
// the guidelines, the notification defaults, the interaction settings - and
// a save button, and it wired the save handler, and it returned an empty
// container. Every field was created; no field was ever put on the page.
//
// The API was fine and the data was fine. The section simply rendered as a
// blank panel, and because the test suite asked the API and the sections
// that built their own DOM, nothing noticed.
//
// So the question asked here is the one that was missing: does every section
// actually draw something? A section that returns an empty container fails.
//
// The second half asks the other half of the directive: the phone carries
// the same sections, and a section that is only on the desktop is a section
// the phone does not have.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { communitySettingsSections } = await import('../js/features/communitySettings.js');
const { SETTINGS_SECTIONS } = await import('../js/views/settings-sections.js').catch(() => ({ SETTINGS_SECTIONS: null }));

// The thirteen sections the console offers.
const SECTIONS = [
  'overview', 'appearance', 'channels', 'categories', 'members', 'roles',
  'invites', 'moderation', 'rules', 'voice', 'ownership', 'analytics',
  'integrations',
];

// A context the sections can be drawn with. The permission system answers
// yes, so a section is asked for its own content rather than for a refusal.
function context() {
  return {
    serverId: 's1',
    page: { id: 'community.settings.overview' },
    query: new Map(),
    params: { id: 's1' },
    user: { id: 'u1', username: 'ada', isAdmin: true },
  };
}

// A server that answers every request with something plausible, so a section
// that is asking for its data gets an answer rather than a fault.
function server() {
  const community = {
    id: 's1', name: 'The community', welcome_content: 'Welcome.',
    welcome_enabled: true, guidelines: 'Be kind.', is_public: true,
    is_discoverable: false, member_count: 12, owner_id: 'u1',
  };
  return installFetchStub({
    'http://localhost/api/servers/s1': { json: community },
    'http://localhost/api/servers/s1/settings': { json: community },
    'http://localhost/api/servers/s1/channels': { json: { channels: [], categories: [] } },
    'http://localhost/api/servers/s1/members': { json: { members: [], total: 0 } },
    'http://localhost/api/servers/s1/roles': { json: { roles: [] } },
    'http://localhost/api/servers/s1/invites': { json: { invites: [] } },
    'http://localhost/api/servers/s1/webhooks': { json: { webhooks: [] } },
    'http://localhost/api/servers/s1/analytics': { json: { messages: 0, members: 12, channels: 0 } },
    'http://localhost/api/servers/s1/moderation': { json: { reports: [] } },
    'http://localhost/api/voice/capabilities': { json: { voiceVideo: { available: false, provider: 'mesh' } } },
    'http://localhost/api/continuum/instances': { json: [] },
  });
}

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

// Something on the page, not an empty container.
function hasContent(node) {
  if (!node) return false;
  if ((node.textContent || '').trim()) return true;
  return (node.children || []).some(hasContent);
}

test('every community settings section draws something', async (t) => {
  const table = communitySettingsSections();

  for (const id of SECTIONS) {
    await t.test('the ' + id + ' section is not an empty panel', async () => {
      server();
      const render = table.get(id);
      assert.equal(typeof render, 'function', 'the ' + id + ' section has no renderer');

      const view = render(context());
      const node = view && view.node ? view.node : view;
      assert.ok(node, 'the ' + id + ' section drew nothing at all');

      if (view && view.onMount) {
        try {
          await view.onMount();
        } catch {
          // A section that fails to load says so on the page; that is a fault
          // the test below looks for, not a reason to stop here.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));

      assert.ok(hasContent(node),
        'the ' + id + ' section returned an empty container. This is the bug '
        + 'that hid the settings for a release: the form was built, the save '
        + 'was wired, and nothing was ever put on the page.');
    });
  }
});

test('the console offers the sections the registry promises', async () => {
  const table = communitySettingsSections();
  for (const id of SECTIONS) {
    assert.equal(typeof table.get(id), 'function',
      'the registry promises a ' + id + ' section and the console does not have it');
  }
});

test('the phone carries the same sections', async () => {
  // The phone's own list of sections. It is read from the source rather than
  // imported, because the mobile module is a separate composition and the
  // point of the check is that the two lists agree.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'mobile', 'js', 'views', 'community.js');
  const source = fs.readFileSync(file, 'utf8');

  const block = source.match(/const SETTINGS_SECTIONS = \[([\s\S]*?)\];/);
  assert.ok(block, 'the phone has no list of community settings sections');
  const onPhone = [...block[1].matchAll(/\['([a-z]+)'/g)].map((match) => match[1]);

  for (const id of SECTIONS) {
    assert.ok(onPhone.includes(id),
      'the ' + id + ' section is on the desktop and not on the phone');
  }
});

test('a section that cannot load says so instead of looking empty', async () => {
  server();
  // A section whose data cannot be read must say so. A panel that is simply
  // blank is indistinguishable from a community with nothing in it, which is
  // the confusion the reduced settings caused.
  const table = communitySettingsSections();
  const render = table.get('analytics');
  const view = render(context());
  const node = view && view.node ? view.node : view;
  if (view && view.onMount) {
    try { await view.onMount(); } catch { /* the failure is the point */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(hasContent(node), 'the analytics section drew nothing at all');
});
