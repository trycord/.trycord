// The guidelines are read back, and an unchanged box is never written over.
//
// The rules of a community are not something to replace with an empty copy
// because nobody happened to type them in. The console reads them, shows
// them as they stand, and writes nothing until they have actually changed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find, buttonByText, type,
} from './helpers.js';

const { communitySettingsSections } = await import('../../js/features/communitySettings.js');
const { State } = await import('../../packages/store.js');

State.servers = [{ id: 's1', name: 'The Community', permissions: ['*'], is_owner: true }];
State.user = { id: 'u1', username: 'operator' };

// The box the rules are written in.
function guidelinesBox(node) {
  return find(node, (candidate) =>
    candidate.tagName === 'TEXTAREA'
    && candidate.getAttribute('aria-label') === 'The rules of this community')[0] || null;
}

test('the guidelines are read back and shown as they stand', async () => {
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  const box = guidelinesBox(view.node);
  assert.ok(box, 'the console has no box for the guidelines');
  assert.equal(box.value, 'Be kind. No spam.', 'the guidelines were not shown as they stand');
  assert.ok(calls.some((call) => call.url.indexOf('/api/servers/s1/settings') !== -1),
    'the settings were not read');
});

test('an unchanged box is not written over', async () => {
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  const save = buttonByText(view.node, 'Save guidelines');
  assert.ok(save, 'the console cannot save the guidelines');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const writes = calls.filter((call) => call.method === 'PATCH');
  assert.equal(writes.length, 0, 'an unchanged box was written over');
  assert.match(view.node.textContent, /unchanged/i, 'the console did not say what it did');
});

test('changed guidelines are written', async () => {
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  type(guidelinesBox(view.node), 'Be kind. No spam. No shouting.');
  const save = buttonByText(view.node, 'Save guidelines');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const writes = calls.filter((call) => call.method === 'PATCH');
  assert.equal(writes.length, 1, 'the guidelines were not written');
  assert.deepEqual(writes[0].body, { guidelines: 'Be kind. No spam. No shouting.' });
});

test('a document that does not parse is shown as it is, and is not overwritten', async () => {
  const calls = installFetch(communityRoutes({
    'http://localhost/api/servers/s1/settings': {
      json: {
        welcomeContent: '',
        welcomeEnabled: false,
        guidelines: '',
        notificationDefaults: 'this is not json',
        interactionSettings: '',
      },
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  const box = find(view.node, (candidate) =>
    candidate.tagName === 'TEXTAREA'
    && candidate.getAttribute('aria-label') === 'The notification defaults of this community')[0];
  assert.ok(box, 'the console has no box for the notification defaults');
  assert.equal(box.value, 'this is not json', 'the document was not shown as it is stored');
  assert.match(view.node.textContent, /not valid JSON/i, 'the console did not say what is wrong');

  // Saving the guidelines must not take the document with it.
  const save = buttonByText(view.node, 'Save guidelines');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const writes = calls.filter((call) => call.method === 'PATCH');
  for (const write of writes) {
    assert.equal(write.body.notification_defaults, undefined,
      'a document nobody was shown was written over');
  }
});
