// The settings studio.
//
// Two faults are checked here, and both were invisible on the screen: a
// switch that could be turned on but never off, and a privacy page that
// referred to a list it never drew.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { switchControl, setSwitch, switchValue } = await import('../js/ui/primitives.js');
const { privacyView } = await import('../js/features/settingsSafety.js');
const { notificationsView } = await import('../js/features/settingsNotices.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

test('a switch can be turned on and off again', () => {
  const seen = [];
  const control = switchControl(false, (on) => seen.push(on), 'A setting');
  assert.equal(control.getAttribute('aria-checked'), 'false');

  control.click();
  assert.deepEqual(seen, [true]);
  assert.equal(control.getAttribute('aria-checked'), 'true');

  control.click();
  assert.deepEqual(seen, [true, false]);
  assert.equal(control.getAttribute('aria-checked'), 'false');
});

test('a switch can be put where the server says it is', () => {
  const control = switchControl(true, () => {}, 'A setting');
  assert.equal(switchValue(control), true);
  setSwitch(control, false);
  assert.equal(switchValue(control), false);
  assert.equal(control.getAttribute('aria-checked'), 'false');
});

test('the privacy page draws the blocked list and the reports', async () => {
  const calls = installFetchStub({
    'http://localhost/api/me/privacy': {
      json: { friendRequests: 'friends', dms: 'anyone', presence: 'anyone', discoverable: false },
    },
    'http://localhost/api/me/blocks': { json: [{ id: 'u1', username: 'noisy' }] },
    'http://localhost/api/reports/mine': { json: [{ id: 'r1', reason: 'spam' }] },  });

  const view = privacyView();
  await view.onMount();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const text = view.node.textContent || '';
  assert.match(text, /noisy/, 'the blocked list was not drawn');
  assert.match(text, /spam/, 'the reports were not drawn');
  assert.ok(calls.some((call) => call.url.indexOf('/api/me/privacy') !== -1), 'the policy was not read');
});

test('the privacy page shows the reach the reader chose', async () => {
  installFetchStub({
    'http://localhost/api/me/privacy': {
      json: { friendRequests: 'friends', dms: 'nobody', presence: 'anyone', discoverable: false },
    },
    'http://localhost/api/me/blocks': { json: [] },
    'http://localhost/api/reports/mine': { json: [] },
  });

  const view = privacyView();
  await view.onMount();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const selects = find(view.node, (node) => node.tagName === 'SELECT');
  const values = selects.map((select) => select.value);
  assert.deepEqual(values, ['friends', 'nobody', 'anyone']);
});

test('the notifications page shows the do-not-disturb state it was given', async () => {
  installFetchStub({
    'http://localhost/api/me/wellbeing': { json: { dndEnabled: true, quietStart: 1320, quietEnd: 420 } },
    'http://localhost/api/mutes': { json: [] },
  });

  const view = notificationsView();
  await view.onMount();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const control = find(view.node, (node) => node.getAttribute && node.getAttribute('role') === 'switch')[0];
  assert.ok(control, 'the do-not-disturb switch is not there');
  assert.equal(control.getAttribute('aria-checked'), 'true');
});
