// The phone exposes the same capabilities.
//
// The desk is a studio and the phone is a screen at a time, but they offer
// the same community: the same sections, the same rules, and the same calls.
// A capability that exists on one client and not the other is a capability
// half the people who use Trycord cannot reach.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find, openOverlays,
} from './helpers.js';

const { COMMUNITY_SECTIONS } = await import('../../packages/communitySettings.js');
const { communitySettingsSections } = await import('../../mobile/js/views/communitySettings.js');
const { communitySettingsSections: deskSections } = await import('../../js/features/communitySettings.js');
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

test('the phone offers every section the catalogue names', () => {
  const phone = communitySettingsSections();
  for (const section of COMMUNITY_SECTIONS) {
    assert.ok(phone.indexOf(section.id) !== -1, 'the phone has no ' + section.id + ' section');
  }
});

test('the phone and the desk offer the same sections', () => {
  const phone = communitySettingsSections().slice().sort();
  const desk = Array.from(deskSections().keys()).sort();
  assert.deepEqual(phone, desk, 'the two clients offer different sections');
});

test('the phone draws its console and opens a section', async () => {
  openOverlays();
  installFetch(communityRoutes());
  const { renderCommunitySettings } = await import('../../mobile/js/views/communitySettings.js');
  const view = renderCommunitySettings({
    serverId: 's1',
    params: { id: 's1' },
    rest: [],
    page: { id: 'community.settings' },
    query: new URLSearchParams('section=overview'),
  });
  assert.ok(view.node, 'the phone drew nothing');
  assert.match(view.node.textContent, /The Community/);

  await view.onMount();
  const tabs = find(view.node, (node) => node.getAttribute('role') === 'tab');
  assert.ok(tabs.length >= 12, 'the phone does not offer every section');
  assert.match(view.node.textContent, /Be kind\. No spam\./,
    'the phone did not read the guidelines back');
});

test('the phone reads the settings back as well', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes());
  const { renderCommunitySettings } = await import('../../mobile/js/views/communitySettings.js');
  const view = renderCommunitySettings({
    serverId: 's1',
    params: { id: 's1' },
    rest: [],
    page: { id: 'community.settings' },
    query: new URLSearchParams('section=overview'),
  });
  await view.onMount();
  assert.ok(calls.some((call) => call.url.indexOf('/api/servers/s1/settings') !== -1),
    'the phone did not read the settings back');
});

test('the phone does not write an unchanged box over', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes());
  const { renderCommunitySettings } = await import('../../mobile/js/views/communitySettings.js');
  const view = renderCommunitySettings({
    serverId: 's1',
    params: { id: 's1' },
    rest: [],
    page: { id: 'community.settings' },
    query: new URLSearchParams('section=overview'),
  });
  await view.onMount();

  const save = find(view.node, (node) =>
    node.tagName === 'BUTTON' && (node.textContent || '').indexOf('Save the guidelines') !== -1)[0];
  assert.ok(save, 'the phone cannot save the guidelines');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const writes = calls.filter((call) => call.method === 'PATCH');
  assert.equal(writes.length, 0, 'the phone wrote an unchanged box over');
});

test('the phone asks before it leaves a section with unsaved changes', async () => {
  openOverlays();
  installFetch(communityRoutes());
  const { renderCommunitySettings } = await import('../../mobile/js/views/communitySettings.js');
  const view = renderCommunitySettings({
    serverId: 's1',
    params: { id: 's1' },
    rest: [],
    page: { id: 'community.settings' },
    query: new URLSearchParams('section=overview'),
  });
  await view.onMount();

  const box = find(view.node, (node) =>
    node.tagName === 'TEXTAREA' && node.getAttribute('aria-label') === 'The rules of this community')[0];
  assert.ok(box, 'the phone has no box for the guidelines');
  box.value = 'New rules';
  box.dispatch('input', {});

  const tabs = find(view.node, (node) => node.getAttribute('role') === 'tab');
  const moderation = tabs.find((tab) => tab.getAttribute('data-section') === 'moderation');
  assert.ok(moderation, 'the phone does not offer the moderation section');
  moderation.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sheets = find(document.body, (node) => node.classList && node.classList.contains('m-sheet'));
  assert.ok(sheets.length > 0, 'the phone left a section with unsaved changes without asking');
  assert.match(sheets.map((sheet) => sheet.textContent).join(' '), /Leave with unsaved changes\?/);
});
