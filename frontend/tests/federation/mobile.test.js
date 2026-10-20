// The phone's federation surfaces.
//
// The same data as the desk, on a phone: a screen at a time, and sheets for
// everything that is acted on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from '../helpers/dom-stub.js';
import { find, buttonWithText, lastSheet, textOf } from './helpers.js';

installDomStub();

// The phone animates its sheets into place. The checks do not care about the
// animation, only that it is scheduled.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

const { setToken } = await import('../../packages/api.js');
const { renderFederation } = await import('../../mobile/js/views/federation.js');

const COMMUNITY = { id: 'c1', name: 'The Lantern', is_owner: true, permissions: ['*'] };

const RELAYED = {
  id: 'local-1',
  relayed: true,
  origin_instance_id: 'peer-1',
  origin_message_id: 'm-9',
  origin_community_id: 'c1',
  origin_channel_id: 'ch-3',
  author_display_name: 'Sam Elsewhere',
  content: 'a message a member of The Lantern wrote on another instance',
  created_at: '2026-02-01T09:00:00.000Z',
};

const MEMBER = {
  id: 'mem-1',
  origin_instance_id: 'peer-1',
  origin_community_id: 'c1',
  origin_user_id: 'u-9',
  username: 'sam',
  display_name: 'Sam Elsewhere',
  state: 'joined',
  updated_at: '2026-02-01T09:00:00.000Z',
};

function ownerRoutes(extra) {
  return Object.assign({
    'http://localhost/api/federation-reports/mine': { json: [] },
    'http://localhost/api/continuum/memberships': { json: [] },
    'http://localhost/api/continuum/outgoing': { json: [] },
    'http://localhost/api/servers': { json: [COMMUNITY] },
    'http://localhost/api/continuum/moderation/messages?community_id=c1': { json: [RELAYED] },
    'http://localhost/api/continuum/moderation/members?community_id=c1': { json: [MEMBER] },
  }, extra || {});
}

function openFederation() {
  return renderFederation({
    page: { id: 'federation' }, query: new URLSearchParams(), params: {}, rest: [],
  });
}

test('the phone shows the owner what the members of the community wrote elsewhere', async () => {
  setToken('owner-a');
  installFetchStub(ownerRoutes());

  const view = openFederation();
  await view.onMount();

  const text = view.node.textContent;
  assert.match(text, /Messages members wrote elsewhere/, 'the surface was not offered');
  assert.match(text, /a message a member of The Lantern wrote on another instance/,
    'the message was not listed');
  assert.match(text, /Sam Elsewhere/, 'the author was not named');
  assert.match(text, /Members who live on another instance/, 'the members were not listed');
});

test('the phone asks before taking a message back, and says what it does', async () => {
  setToken('owner-a');
  const calls = installFetchStub(ownerRoutes({
    'http://localhost/api/continuum/moderation/messages/peer-1/m-9': {
      json: {
        ok: true,
        origin_instance_id: 'peer-1',
        origin_message_id: 'm-9',
        removed: true,
        relayed: true,
        reason: null,
      },
    },
  }));

  const view = openFederation();
  await view.onMount();

  const message = find(view.node, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('a message a member of The Lantern') !== -1)[0];
  assert.ok(message, 'the message was not listed');
  message.click();

  const sheet = await waitFor(() => lastSheet(document.body));
  assert.ok(sheet, 'the message opened no sheet');
  const takeBack = buttonWithText(sheet, 'Take back');
  assert.ok(takeBack, 'there is no way to take a message back');
  takeBack.click();

  const asked = await waitFor(() => {
    const top = lastSheet(document.body);
    return top && textOf(top).indexOf('the copy over there goes too') !== -1 ? top : null;
  });
  assert.ok(asked, 'the action did not say that the copy elsewhere goes too');
  assert.ok(!calls.find((call) => call.options.method === 'DELETE'),
    'the message was taken back without asking');

  const confirm = buttonWithText(asked, 'Take it back');
  assert.ok(confirm, 'the confirmation has no button');
  confirm.click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'DELETE'
    && call.url.indexOf('/api/continuum/moderation/messages/peer-1/m-9') !== -1));
  assert.ok(sent, 'the message was never taken back');

  const reported = await waitFor(() => {
    const text = view.node.textContent;
    return text.indexOf('was told') !== -1 ? text : null;
  });
  assert.match(reported, /Taken back/, 'the server answer was not reported');
});
