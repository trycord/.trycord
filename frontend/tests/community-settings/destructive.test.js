// The destructive things ask first.
//
// Deleting a community, lifting a ban, removing a member and burning a
// secret are the actions that cannot be undone. Each of them says what it
// does before it does it, and nothing is sent to the server until the
// reader has said yes.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find, buttonByText, openOverlays,
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

// The dialogs that are open.
function dialogs() {
  return find(document.body, (node) => node.classList && node.classList.contains('dialog'));
}

// The button of a dialog that confirms it.
function confirmButton(dialog, label) {
  const buttons = find(dialog, (node) => node.tagName === 'BUTTON');
  return buttons.find((button) => (button.textContent || '').indexOf(label) !== -1) || null;
}

test('deleting the community asks first', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('ownership')(communityContext());
  await view.onMount();

  const remove = buttonByText(view.node, 'Delete community');
  assert.ok(remove, 'the console cannot delete the community');
  remove.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const open = dialogs();
  assert.equal(open.length, 1, 'deleting did not ask');
  assert.match(open[0].textContent, /Delete this community\?/);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0,
    'the community was deleted before anybody said yes');
});

test('the question says what it does', async () => {
  openOverlays();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('ownership')(communityContext());
  await view.onMount();

  buttonByText(view.node, 'Delete community').click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const open = dialogs();
  assert.match(open[0].textContent, /does not come back|not reversible/i,
    'the question did not say what deleting means');
});

test('saying yes does what was asked', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('ownership')(communityContext());
  await view.onMount();

  buttonByText(view.node, 'Delete community').click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const open = dialogs();
  const yes = confirmButton(open[0], 'Delete community');
  assert.ok(yes, 'the dialog has no way to confirm');
  yes.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1,
    'saying yes did not delete the community');
});

test('lifting a ban asks first', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes({
    'http://localhost/api/servers/s1/bans': {
      json: [{ userId: 'u2', username: 'ada', displayName: 'Ada', reason: 'Spam' }],
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('moderation')(communityContext());
  await view.onMount();

  const lift = buttonByText(view.node, 'Lift');
  assert.ok(lift, 'the console cannot lift a ban');
  lift.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const open = dialogs();
  assert.equal(open.length, 1, 'lifting a ban did not ask');
  assert.equal(calls.filter((call) => call.url.indexOf('/unban') !== -1).length, 0,
    'the ban was lifted before anybody said yes');
});

test('removing a member asks first', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('moderation')(communityContext());
  await view.onMount();

  const remove = buttonByText(view.node, 'Remove');
  assert.ok(remove, 'the console cannot remove a member');
  remove.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const open = dialogs();
  assert.equal(open.length, 1, 'removing a member did not ask');
  assert.equal(calls.filter((call) => call.url.indexOf('/kick') !== -1).length, 0,
    'the member was removed before anybody said yes');
});

test('burning a secret asks first', async () => {
  openOverlays();
  const calls = installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('integrations')(communityContext());
  await view.onMount();

  const replace = buttonByText(view.node, 'Replace');
  assert.ok(replace, 'the console cannot replace a secret');
  replace.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const open = dialogs();
  assert.equal(open.length, 1, 'replacing a secret did not ask');
  assert.equal(calls.filter((call) => call.url.indexOf('rotate-secret') !== -1).length, 0,
    'the secret was replaced before anybody said yes');
});
