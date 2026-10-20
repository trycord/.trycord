// The cross-instance reports.
//
// A report carries a reference and a reason, and nothing else. The reporter
// is told what crossed and what did not, in the server's own words, and this
// screen shows that text rather than a paraphrase of it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from './helpers/dom-stub.js';

installDomStub();

const { setToken } = await import('../packages/api.js');
const { renderFederation } = await import('../js/features/federation.js');
const { adminFederation } = await import('../js/features/adminFederation.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

// The disclosure, as the server writes it.
const DISCLOSURE = {
  shared: [
    'the identity of the instance the report comes from',
    'the identifier of the community and the channel the content is in',
    'the identifier of the reported content',
    'the reason for the report',
    'the identifier of your account on the instance the report comes from',
  ],
  notShared: [
    'the content itself',
    'your name, your email address, your profile, or anything else about you',
  ],
};

test('the reporter is told what crossed and what did not', async () => {
  setToken('reader-a');
  installFetchStub({
    'http://localhost/api/federation-reports/mine': {
      json: [{
        id: 'r1',
        reason: 'This message breaks the rules of the community',
        contentType: 'message',
        status: 'DELIVERED',
        createdAt: '2026-02-01T09:00:00.000Z',
        disclosure: DISCLOSURE,
      }],
    },
    'http://localhost/api/continuum/memberships': { json: [] },
  });

  const view = renderFederation({ page: { id: 'federation' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  const text = await waitFor(() => {
    const drawn = view.node.textContent || '';
    return drawn.indexOf('What crosses with a report') !== -1 ? drawn : null;
  });
  assert.ok(text, 'the reporter was not told what crosses');
  for (const line of DISCLOSURE.shared) {
    assert.ok(text.indexOf(line) !== -1, 'the reporter was not told what crosses: ' + line);
  }
  for (const line of DISCLOSURE.notShared) {
    assert.ok(text.indexOf(line) !== -1, 'the reporter was not told what does not cross: ' + line);
  }
  assert.match(text, /What crosses with a report/);
  assert.match(text, /What does not cross/);
});

test('the report itself is listed for the reader who filed it', async () => {
  setToken('reader-a');
  installFetchStub({
    'http://localhost/api/federation-reports/mine': {
      json: [{
        id: 'r1',
        reason: 'This message breaks the rules of the community',
        contentType: 'message',
        status: 'DELIVERED',
        createdAt: '2026-02-01T09:00:00.000Z',
        disclosure: DISCLOSURE,
      }],
    },
    'http://localhost/api/continuum/memberships': { json: [] },
  });

  const view = renderFederation({ page: { id: 'federation' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  const drawn = await waitFor(() => {
    const text = view.node.textContent || '';
    return text.indexOf('This message breaks the rules of the community') !== -1 ? text : null;
  });
  assert.ok(drawn, 'the report was not listed');
});

test('a report carries a reference and a reason, and nothing else', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/federation-reports/mine': { json: [] },
    'http://localhost/api/continuum/memberships': {
      json: [{
        origin_instance_id: 'peer-1',
        origin_community_id: 'comm-1',
        community: { id: 'c-1', name: 'Elsewhere' },
      }],
    },
    'http://localhost/api/continuum/communities/peer-1/comm-1/messages': {
      json: [{
        id: 'local-1',
        relayed: true,
        origin_instance_id: 'peer-1',
        origin_message_id: 'm-9',
        origin_community_id: 'comm-1',
        origin_channel_id: 'ch-3',
        content: 'a message that arrived here',
        author_display_name: 'Someone',
      }],
    },
    'http://localhost/api/federation-reports': {
      json: { id: 'r2', status: 'DELIVERED', disclosure: DISCLOSURE },
    },
  });

  const view = renderFederation({ page: { id: 'federation' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  // The community on the other instance, and what was relayed into it.
  const followed = await waitFor(() => find(view.node, classed('federation-row'))[0]);
  assert.ok(followed, 'the communities on other instances were not listed');
  followed.click();

  const relayed = await waitFor(() => find(document.body, classed('dialog'))
    .filter((node) => String(node.textContent).indexOf('a message that arrived here') !== -1)[0]);
  assert.ok(relayed, 'the relayed messages were not shown');

  const report = find(relayed, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('Report') !== -1)[0];
  assert.ok(report, 'there is no way to report a relayed message');
  report.click();

  const form = await waitFor(() => {
    const dialogs = find(document.body, classed('dialog'));
    const reportDialog = dialogs[dialogs.length - 1];
    if (!reportDialog || String(reportDialog.textContent).indexOf('Report to the other instance') === -1) return null;
    return find(reportDialog, (node) => node.tagName === 'FORM')[0];
  });
  assert.ok(form, 'the report dialog did not open');
  const dialog = form.parentNode;
  const reason = find(dialog, (node) => node.tagName === 'INPUT')[0];
  reason.value = 'This message breaks the rules of the community';
  form.submit();

  const posted = await waitFor(() => calls.find((call) => call.url.indexOf('/api/federation-reports') !== -1
    && call.options.method === 'POST'));
  assert.ok(posted, 'the report was never filed');
  assert.equal(posted.body.targetInstanceId, 'peer-1');
  assert.equal(posted.body.communityId, 'comm-1');
  assert.equal(posted.body.channelId, 'ch-3');
  assert.equal(posted.body.contentId, 'm-9');
  assert.equal(posted.body.reason, 'This message breaks the rules of the community');
  assert.equal(posted.body.content, undefined, 'the content of the message crossed with the report');
});

test('the instance reads the reports that arrived here', async () => {
  setToken('reader-a');
  installFetchStub({
    'http://localhost/api/federation-reports?limit=100': {
      json: [{
        id: 'r3',
        originInstanceId: 'peer-1',
        contentType: 'message',
        reason: 'A message here breaks the rules',
        status: 'RECEIVED',
        actionable: 1,
        receivedAt: '2026-02-01T09:00:00.000Z',
      }],
    },
  });

  const view = adminFederation();
  await view.onMount();

  const text = await waitFor(() => {
    const drawn = view.node.textContent || '';
    return drawn.indexOf('A message here breaks the rules') !== -1 ? drawn : null;
  });
  assert.ok(text, 'the reports that arrived were not listed');
  assert.match(text, /actionable/);
});
