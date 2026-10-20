// A secret is shown once, and never again.
//
// The server hands out the plaintext of a webhook's secret and of a bot's
// token exactly once, and cannot read either of them back. So the console
// shows that one copy when it arrives, and afterwards shows the fact that
// there is one - never the value.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFetch, communityRoutes, communityContext, find, buttonByText, openOverlays,
} from './helpers.js';

const { communitySettingsSections } = await import('../../js/features/communitySettings.js');
const { maskSecret } = await import('../../packages/communitySettings.js');
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

test('a webhook secret is a mask, not a value', async () => {
  openOverlays();
  installFetch(communityRoutes());
  const sections = communitySettingsSections();
  const view = sections.get('integrations')(communityContext());
  await view.onMount();

  assert.match(view.node.textContent, /The signing secret/,
    'the console does not say that the webhook has a secret');
  assert.ok(view.node.textContent.indexOf(maskSecret()) !== -1,
    'the console did not mask the secret');
  assert.equal(view.node.textContent.indexOf('super-secret'), -1,
    'the console showed a secret it was not given');
});

test('a new secret is shown once, and the console does not keep it', async () => {
  openOverlays();
  installFetch(communityRoutes({
    'http://localhost/api/servers/s1/webhooks/w1/rotate-secret': {
      json: { id: 'w1', secret: 'the-new-secret' },
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('integrations')(communityContext());
  await view.onMount();

  buttonByText(view.node, 'Replace').click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const question = dialogs();
  assert.equal(question.length, 1, 'replacing a secret did not ask');
  confirmButton(question[0], 'Replace the secret').click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const shown = dialogs();
  const withSecret = shown.filter((dialog) => (dialog.textContent || '').indexOf('the-new-secret') !== -1);
  assert.equal(withSecret.length, 1, 'the new secret was not shown exactly once');
  assert.match(withSecret[0].textContent, /only time|cannot be read again|cannot show it again/i,
    'the secret was not shown as a thing that cannot be seen again');

  // The section does not keep it.
  assert.equal(view.node.textContent.indexOf('the-new-secret'), -1,
    'the console kept a copy of the secret');
  assert.ok(view.node.textContent.indexOf(maskSecret()) !== -1,
    'the console did not go back to the mask');
});

test('a bot token is a mask, not a value', async () => {
  openOverlays();
  installFetch(communityRoutes({
    'http://localhost/api/servers/s1/apps': {
      json: { apps: [{ id: 'a1', name: 'Helper', description: 'Does things', status: 'active' }] },
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('integrations')(communityContext());
  await view.onMount();

  assert.match(view.node.textContent, /The application token/,
    'the console does not say that the application has a token');
  assert.ok(view.node.textContent.indexOf(maskSecret()) !== -1,
    'the console did not mask the token');
  assert.equal(view.node.textContent.indexOf('trcd_bot_'), -1,
    'the console showed a token it was not given');
});

test('a new bot token is shown once', async () => {
  openOverlays();
  installFetch(communityRoutes({
    'http://localhost/api/servers/s1/apps': (body, seen) => {
      const last = seen[seen.length - 1];
      if (last.method === 'POST') {
        return { json: { app: { id: 'a2', name: 'Helper', token: 'trcd_bot_newtoken' } } };
      }
      return { json: { apps: [{ id: 'a1', name: 'Helper', description: 'Does things', status: 'active' }] } };
    },
  }));
  const sections = communitySettingsSections();
  const view = sections.get('integrations')(communityContext());
  await view.onMount();

  const replace = find(view.node, (node) =>
    node.tagName === 'BUTTON' && node.getAttribute('aria-label') === 'Replace application token')[0];
  assert.ok(replace, 'the console cannot replace the token');
  replace.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const question = dialogs();
  assert.equal(question.length, 1, 'replacing a token did not ask');
  confirmButton(question[0], 'Make a new one').click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const shown = dialogs().filter((dialog) => (dialog.textContent || '').indexOf('trcd_bot_newtoken') !== -1);
  assert.equal(shown.length, 1, 'the new token was not shown exactly once');
  assert.equal(view.node.textContent.indexOf('trcd_bot_newtoken'), -1,
    'the console kept a copy of the token');
});
