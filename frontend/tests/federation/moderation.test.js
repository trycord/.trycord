// The owner's moderation surface.
//
// The owner of a community of this instance sees what its members wrote on
// other instances, and has four decisions about it: take a message back, and
// mute, remove or restore a member. A reader who may moderate nothing is
// offered nothing at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from '../helpers/dom-stub.js';
import { find, buttonWithText, lastDialog, textOf } from './helpers.js';

installDomStub();

const { setToken } = await import('../../packages/api.js');
const { renderFederation } = await import('../../js/features/federation.js');
const { adminFederation } = await import('../../js/features/adminFederation.js');

const COMMUNITY = { id: 'c1', name: 'The Lantern', is_owner: true, permissions: ['*'] };

// A message a member of The Lantern wrote on another instance.
const RELAYED = {
  id: 'local-1',
  relayed: true,
  origin_instance_id: 'peer-1',
  origin_message_id: 'm-9',
  origin_community_id: 'c1',
  origin_channel_id: 'ch-3',
  author_origin_id: 'peer-user-1',
  author_username: 'sam',
  author_display_name: 'Sam Elsewhere',
  content: 'a message a member of The Lantern wrote on another instance',
  created_at: '2026-02-01T09:00:00.000Z',
  deleted: false,
};

// A member of The Lantern who lives on another instance.
const MEMBER = {
  id: 'mem-1',
  origin_instance_id: 'peer-1',
  origin_community_id: 'c1',
  origin_user_id: 'u-9',
  username: 'sam',
  display_name: 'Sam Elsewhere',
  state: 'joined',
  joined_at: '2026-02-01T09:00:00.000Z',
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

test('the owner sees what the members of the community wrote on other instances', async () => {
  setToken('owner-a');
  installFetchStub(ownerRoutes());

  const view = openFederation();
  await view.onMount();

  const text = view.node.textContent;
  assert.match(text, /What members wrote elsewhere/, 'the moderation surface was not offered');
  assert.match(text, /a message a member of The Lantern wrote on another instance/,
    'the message was not listed');
  assert.match(text, /Sam Elsewhere/, 'the author was not named');
  assert.match(text, /peer-1/, 'the instance it was written on was not named');
  assert.match(text, /Members who live on another instance/,
    'the members of the community were not listed');
});

test('taking a message back asks first, and says that the copy elsewhere goes too', async () => {
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

  const takeBack = buttonWithText(view.node, 'Take back');
  assert.ok(takeBack, 'there is no way to take a message back');
  takeBack.click();

  const dialog = await waitFor(() => lastDialog(document.body));
  assert.ok(dialog, 'the action did not ask first');
  assert.match(textOf(dialog), /the copy over there goes too/,
    'the confirmation did not say that the copy elsewhere goes too');
  assert.ok(!calls.find((call) => call.options.method === 'DELETE'),
    'the message was taken back without asking');

  const form = find(dialog, (node) => node.tagName === 'FORM')[0];
  assert.ok(form, 'the confirmation has no form');
  const reason = find(form, (node) => node.tagName === 'INPUT')[0];
  reason.value = 'It breaks the rules of this community';
  form.submit();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'DELETE'
    && call.url.indexOf('/api/continuum/moderation/messages/peer-1/m-9') !== -1));
  assert.ok(sent, 'the message was never taken back');
  assert.equal(sent.body.reason, 'It breaks the rules of this community');

  const reported = await waitFor(() => {
    const text = view.node.textContent;
    return text.indexOf('Taken back') !== -1 ? text : null;
  });
  assert.match(reported, /was told/, 'the server answer was not reported');
});

test('muting, removing and restoring a member each report what the server answered', async () => {
  setToken('owner-a');
  const states = { mute: 'muted', remove: 'removed', restore: 'joined' };
  const calls = installFetchStub(ownerRoutes({
    'http://localhost/api/continuum/moderation/members/peer-1/u-9': (body) => ({
      json: {
        ok: true,
        origin_instance_id: 'peer-1',
        origin_user_id: 'u-9',
        origin_community_id: 'c1',
        state: states[body.action] || 'joined',
        relayed: true,
        reason: null,
      },
    }),
  }));

  const view = openFederation();
  await view.onMount();

  for (const action of ['Mute', 'Remove', 'Restore']) {
    const button = await waitFor(() => buttonWithText(view.node, action));
    assert.ok(button, 'there is no way to ' + action.toLowerCase() + ' a member');
    button.click();

    const dialog = await waitFor(() => lastDialog(document.body));
    assert.ok(dialog, 'the ' + action.toLowerCase() + ' did not ask first');
    const form = find(dialog, (node) => node.tagName === 'FORM')[0];
    assert.ok(form, 'the confirmation has no form');
    form.submit();

    const sent = await waitFor(() => calls.find((call) => call.options.method === 'POST'
      && call.url.indexOf('/api/continuum/moderation/members/peer-1/u-9') !== -1
      && call.body.action === action.toLowerCase()));
    assert.ok(sent, 'the member was never ' + action.toLowerCase() + 'd');
    assert.equal(sent.body.community_id, 'c1', 'the decision named no community');

    const reported = await waitFor(() => {
      const text = view.node.textContent;
      return text.indexOf('was told') !== -1 ? text : null;
    });
    assert.match(reported, /Sam Elsewhere/, 'the server answer was not reported');
    assert.match(reported, /was told/, 'the server answer was not reported');
  }
});

test('a reader who may moderate nothing is offered no moderation controls', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/federation-reports/mine': { json: [] },
    'http://localhost/api/continuum/memberships': { json: [] },
    'http://localhost/api/continuum/outgoing': { json: [] },
    'http://localhost/api/servers': {
      json: [{
        id: 'c1',
        name: 'The Lantern',
        is_owner: false,
        permissions: ['SEND_MESSAGES', 'READ_MESSAGES'],
      }],
    },
  });

  const view = openFederation();
  await view.onMount();

  const text = view.node.textContent;
  assert.ok(text.indexOf('What members wrote elsewhere') === -1,
    'the moderation surface was offered to a reader');
  assert.ok(text.indexOf('Members who live on another instance') === -1,
    'the members of a community were offered to a reader');
  assert.ok(!calls.find((call) => call.url.indexOf('/api/continuum/moderation/') !== -1),
    'the reader was asked for the moderation surface');
});

test('the instance administrator moderates every community of the instance', async () => {
  setToken('admin-a');
  installFetchStub({
    'http://localhost/api/federation-reports?limit=100': { json: [] },
    'http://localhost/api/admin/servers?limit=100': { json: [{ id: 'c1', name: 'The Lantern' }] },
    'http://localhost/api/continuum/moderation/messages': { json: [RELAYED] },
    'http://localhost/api/continuum/moderation/members': { json: [MEMBER] },
  });

  const view = adminFederation();
  await view.onMount();

  const text = view.node.textContent;
  assert.match(text, /a message a member of The Lantern wrote on another instance/,
    'the message was not listed');
  assert.match(text, /The Lantern/, 'the community was not named');
  assert.match(text, /Sam Elsewhere/, 'the member was not listed');
});
