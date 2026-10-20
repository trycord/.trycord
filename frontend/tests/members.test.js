// The member roster.
//
// Three things have to be true of the roster, and none of them is visible in a
// screenshot: it says who is here, it pages rather than truncating, and it
// asks the server to narrow the list rather than narrowing it in the browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { State, setPresence } = await import('../packages/store.js');
const { memberList, presenceLabel } = await import('../js/ui/members.js');

const SERVER_ID = 'server-1';
const BASE = 'http://localhost/api/servers/' + SERVER_ID + '/members';

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

function member(id, username) {
  return { id, username, display_name: username, nickname: null, is_owner: false, roles: [] };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('every member row says whether the person is online, idle or offline', async () => {
  setPresence('u1', 'online');
  setPresence('u2', 'idle');
  installFetchStub({
    [BASE + '?limit=50']: {
      json: { items: [member('u1', 'sam'), member('u2', 'rin'), member('u3', 'bea')], total: 3, hasMore: false },
    },
    'http://localhost/api/users/presence?ids=u1,u2,u3': { json: { u1: 'online', u2: 'idle', u3: 'offline' } },
  });

  const roster = memberList(SERVER_ID);
  await roster.load();

  const rows = find(roster.node, classed('member-row'));
  assert.equal(rows.length, 3, 'the roster drew the wrong number of members');

  const said = rows.map((row) => {
    const label = find(row, classed('member-presence'))[0];
    return label ? label.textContent : '';
  });
  assert.deepEqual(said, ['Online', 'Idle', 'Offline']);

  // The dot on the face carries the same answer.
  const dots = find(roster.node, (n) => n.getAttribute && n.getAttribute('class') === 'avatar-dot');
  assert.deepEqual(dots.map((dot) => dot.getAttribute('data-presence')),
    ['online', 'idle', 'offline']);

  assert.equal(presenceLabel('online'), 'Online');
  assert.equal(presenceLabel('offline'), 'Offline');
  roster.cleanup();
});

test('the roster pages rather than showing a truncated list', async () => {
  const calls = installFetchStub({
    [BASE + '?limit=50']: {
      json: { items: [member('u1', 'sam'), member('u2', 'rin')], total: 120, hasMore: true },
    },
    [BASE + '?limit=50&offset=2']: {
      json: { items: [member('u3', 'bea')], total: 120, hasMore: false },
    },
    'http://localhost/api/users/presence?ids=u1,u2,u3': { json: {} },
  });

  const roster = memberList(SERVER_ID);
  await roster.load();

  const more = find(roster.node, classed('btn'))[0];
  assert.ok(more, 'the roster offered no way to read more');
  assert.match(more.textContent || '', /Load more/);

  more.click();
  await wait(20);

  const second = calls.find((call) => call.url.indexOf('offset=2') !== -1);
  assert.ok(second, 'the second page was never asked for');
  assert.equal(find(roster.node, classed('member-row')).length, 3, 'the second page was not drawn');
  roster.cleanup();
});

test('the search is sent to the server', async () => {
  const calls = installFetchStub({
    [BASE + '?limit=50']: { json: { items: [], total: 0, hasMore: false } },
    [BASE + '?limit=50&q=rin']: { json: { items: [member('u2', 'rin')], total: 1, hasMore: false } },
    'http://localhost/api/users/presence?ids=u2': { json: {} },
  });

  const roster = memberList(SERVER_ID);
  await roster.load();

  const search = find(roster.node, classed('member-search'))[0];
  assert.ok(search, 'the roster has no search box');
  search.value = 'rin';
  search.dispatch('input', {});
  await wait(320);

  const asked = calls.find((call) => call.url.indexOf('q=rin') !== -1);
  assert.ok(asked, 'the search was not sent to the server');
  assert.equal(find(roster.node, classed('member-row')).length, 1, 'the answer was not drawn');
  roster.cleanup();
});

test('the roster says how much of it is on screen', async () => {
  installFetchStub({
    [BASE + '?limit=50']: {
      json: { items: [member('u1', 'sam'), member('u2', 'rin')], total: 120, hasMore: true },
    },
    'http://localhost/api/users/presence?ids=u1,u2': { json: {} },
  });
  const roster = memberList(SERVER_ID);
  await roster.load();
  const count = find(roster.node, classed('member-count'))[0];
  assert.equal(count.textContent, '2 of 120');
  roster.cleanup();
});
