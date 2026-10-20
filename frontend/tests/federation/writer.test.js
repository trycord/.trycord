// The writer's view.
//
// A member of a community that lives on another instance writes here, and the
// owner of that community answers: taken, or refused with the reason. The
// writer is never left wondering where a message went.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from '../helpers/dom-stub.js';
import { buttonWithText, lastDialog, find } from './helpers.js';

installDomStub();

const { setToken } = await import('../../packages/api.js');
const { renderFederation } = await import('../../js/features/federation.js');

// What this account wrote into a community that lives on another instance.
const OUTGOING = [
  {
    id: 'o-1',
    relayed: true,
    origin_instance_id: 'peer-1',
    origin_community_id: 'comm-1',
    origin_channel_id: 'ch-1',
    content: 'a message written in a community that lives elsewhere',
    created_at: '2026-02-01T09:00:00.000Z',
    state: 'refused',
    reason: 'that channel is not federated here',
    decided_at: '2026-02-01T09:05:00.000Z',
  },
  {
    id: 'o-2',
    relayed: true,
    origin_instance_id: 'peer-1',
    origin_community_id: 'comm-1',
    origin_channel_id: 'ch-1',
    content: 'a message that was taken in',
    created_at: '2026-02-01T09:10:00.000Z',
    state: 'accepted',
    reason: null,
  },
  {
    id: 'o-3',
    relayed: true,
    origin_instance_id: 'peer-1',
    origin_community_id: 'comm-1',
    origin_channel_id: 'ch-1',
    content: 'a message that was taken back',
    created_at: '2026-02-01T09:20:00.000Z',
    state: 'deleted',
    reason: null,
  },
];

function writerRoutes(extra) {
  return Object.assign({
    'http://localhost/api/federation-reports/mine': { json: [] },
    'http://localhost/api/continuum/memberships': {
      json: [{
        origin_instance_id: 'peer-1',
        origin_community_id: 'comm-1',
        community: { id: 'c-1', name: 'Elsewhere' },
      }],
    },
    'http://localhost/api/continuum/outgoing': { json: OUTGOING },
    'http://localhost/api/servers': { json: [] },
  }, extra || {});
}

test('the writer sees the decision the owner made, and the reason', async () => {
  setToken('writer-a');
  installFetchStub(writerRoutes());

  const view = renderFederation({
    page: { id: 'federation' }, query: new URLSearchParams(), params: {}, rest: [],
  });
  await view.onMount();

  const text = view.node.textContent;
  assert.match(text, /What you wrote in communities on other instances/,
    'the writer was not shown what they wrote');
  assert.match(text, /a message written in a community that lives elsewhere/,
    'the message was not listed');
  assert.match(text, /refused/, 'the refusal was not shown');
  assert.match(text, /that channel is not federated here/, 'the reason was not shown');
  assert.match(text, /accepted/, 'the acceptance was not shown');
  assert.match(text, /taken back/, 'the taking back was not shown');
  assert.match(text, /Elsewhere/, 'the community was not named');
});

test('the writer can take a message back, and is told that the copy goes too', async () => {
  setToken('writer-a');
  const calls = installFetchStub(writerRoutes({
    'http://localhost/api/continuum/outgoing/o-1': { json: { ok: true, id: 'o-1' } },
  }));

  const view = renderFederation({
    page: { id: 'federation' }, query: new URLSearchParams(), params: {}, rest: [],
  });
  await view.onMount();

  const takeBack = buttonWithText(view.node, 'Take back');
  assert.ok(takeBack, 'there is no way to take a message back');
  takeBack.click();

  const dialog = await waitFor(() => lastDialog(document.body));
  assert.ok(dialog, 'the action did not ask first');
  assert.match(String(dialog.textContent), /the copy over there goes too/,
    'the confirmation did not say that the copy elsewhere goes too');

  const form = find(dialog, (node) => node.tagName === 'FORM')[0];
  assert.ok(form, 'the confirmation has no form');
  form.submit();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'DELETE'
    && call.url.indexOf('/api/continuum/outgoing/o-1') !== -1));
  assert.ok(sent, 'the message was never taken back');
});
