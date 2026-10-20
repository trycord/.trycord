// The cross-instance reports.
//
// A report carries a reference and a reason, and nothing else. The reporter
// is told what crossed and what did not, in the server's own words, and this
// screen shows that text rather than a paraphrase of it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  await wait(20);

  const text = view.node.textContent || '';
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
  await wait(20);

  assert.match(view.node.textContent || '', /This message breaks the rules of the community/);
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
  await wait(20);

  // The community on the other instance, and what was relayed into it.
  const followed = find(view.node, classed('federation-row'))[0];
  assert.ok(followed, 'the communities on other instances were not listed');
  followed.click();
  await wait(30);

  const relayed = find(document.body, classed('dialog'))[0];
  assert.ok(relayed, 'the relayed messages were not shown');
  assert.match(relayed.textContent || '', /a message that arrived here/);

  const report = find(relayed, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('Report') !== -1)[0];
  assert.ok(report, 'there is no way to report a relayed message');
  report.click();
  await wait(20);

  const dialogs = find(document.body, classed('dialog'));
  const reportDialog = dialogs[dialogs.length - 1];
  const reason = find(reportDialog, (node) => node.tagName === 'INPUT')[0];
  reason.value = 'This message breaks the rules of the community';
  const form = find(reportDialog, (node) => node.tagName === 'FORM')[0];
  form.submit();
  await wait(40);

  const posted = calls.find((call) => call.url.indexOf('/api/federation-reports') !== -1
    && call.options.method === 'POST');
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
  await wait(20);

  const text = view.node.textContent || '';
  assert.match(text, /A message here breaks the rules/);
  assert.match(text, /actionable/);
});
