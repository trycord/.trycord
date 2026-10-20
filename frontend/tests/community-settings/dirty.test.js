// Leaving a section with something unsaved asks first.
//
// The console is a rail of sections, so leaving one for another is a click on
// the rail. A click that throws away what somebody typed asks before it does.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find, type, openOverlays,
} from './helpers.js';

const { communitySettingsSections } = await import('../../js/features/communitySettings.js');
const { State } = await import('../../packages/store.js');

State.servers = [{ id: 's1', name: 'The Community', permissions: ['*'], is_owner: true }];
State.user = { id: 'u1', username: 'operator' };

// The dialogs that are open.
function dialogs() {
  return find(document.body, (node) => node.classList && node.classList.contains('dialog'));
}

// A link in the rail.
function railLink(node, section) {
  const links = find(node, (candidate) =>
    candidate.tagName === 'A' && (candidate.getAttribute('href') || '').indexOf('/settings/' + section) !== -1);
  return links[0] || null;
}

// The name box of the overview.
function nameBox(node) {
  return find(node, (candidate) =>
    candidate.tagName === 'INPUT' && candidate.getAttribute('aria-label') === 'Community name')[0] || null;
}

test('a section with unsaved changes says so', async () => {
  openOverlays();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  assert.equal(view.isDirty(), false, 'a section that was only read is dirty');
  type(nameBox(view.node), 'A community with a new name');
  assert.equal(view.isDirty(), true, 'the section did not notice the change');
  assert.match(view.node.textContent, /Unsaved changes/i, 'the section did not say it was dirty');
});

test('leaving a section with unsaved changes asks first', async () => {
  openOverlays();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  type(nameBox(view.node), 'A community with a new name');
  const link = railLink(view.node, 'moderation');
  assert.ok(link, 'the rail does not carry the moderation section');
  link.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const open = dialogs();
  assert.equal(open.length, 1, 'leaving did not ask');
  assert.match(open[0].textContent, /Leave with unsaved changes\?/,
    'the question did not say what was at stake');
});

test('leaving a section with nothing unsaved does not ask', async () => {
  openOverlays();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  const link = railLink(view.node, 'moderation');
  link.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(dialogs().length, 0, 'the console asked about nothing');
});

test('a section that has saved what it had is not dirty', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('overview')(communityContext());
  await view.onMount();

  const box = nameBox(view.node);
  type(box, 'A community with a new name');
  const save = find(view.node, (node) =>
    node.tagName === 'BUTTON' && (node.textContent || '').indexOf('Save identity') !== -1)[0];
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(calls.some((call) => call.method === 'PATCH'), 'the console did not save');
  assert.equal(view.isDirty(), false, 'the section still says it is dirty');
});
