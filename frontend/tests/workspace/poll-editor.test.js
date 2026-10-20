// The poll editor.
//
// It threw. Every click on "New poll" raised a ReferenceError before the
// dialog was ever shown, because the editor's title line named a `poll` that
// was not in scope - the leftover of a planned edit path that was never
// finished.
//
// So the check is that the editor opens, that it says what it is doing, and
// that it edits a poll when it is given one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';

installDomStub();

const { pollsList, pollsDetail } = await import('../../js/features/workspace/polls.js');
const { State } = await import('../../packages/store.js');

State.user = { id: 'me', username: 'ada' };
State.servers = [{ id: 's1', name: 'The Community', permissions: ['*'], is_owner: true }];

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function byText(node, text) {
  const found = find(node, (candidate) => (candidate.textContent || '').indexOf(text) !== -1);
  let deepest = found[0] || null;
  for (const candidate of found) {
    if (!deepest) { deepest = candidate; continue; }
    if ((candidate.textContent || '').length < (deepest.textContent || '').length) deepest = candidate;
  }
  return deepest;
}

const context = (params) => ({
  serverId: 's1',
  page: { id: 'community.workspace.polls' },
  params: params || {},
  rest: [],
  query: new Map(),
  user: { id: 'me', username: 'ada' },
});

test('the poll editor opens', async () => {
  installFetchStub({
    'http://localhost/api/servers/s1/polls': { json: [] },
  });

  // The list, and the button that opens the editor.
  const list = pollsList(context());
  await list.onMount();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const button = find(list.node, (node) => node.tagName === 'BUTTON'
    && (node.textContent || '').indexOf('New poll') !== -1)[0];
  assert.ok(button, 'the poll list has no "New poll" button');

  // The click used to throw a ReferenceError here, before the dialog was
  // ever shown.
  let threw = null;
  try {
    button.click();
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, null,
    'opening the poll editor threw: ' + (threw && threw.message));

  // And the editor is on the page.
  const dialog = find(document.body, (node) => node.classList
    && node.classList.contains('dialog'))[0];
  assert.ok(dialog, 'the editor did not open');
  assert.match(dialog.textContent, /New poll/, 'the editor does not say what it is');
});

test('the poll editor edits a poll it is given', async () => {
  installFetchStub({
    'http://localhost/api/servers/s1/polls': { json: [] },
    'http://localhost/api/servers/s1/polls/p1': {
      json: {
        id: 'p1', question: 'Which day?', scoring: 'plurality',
        allowsMultiple: false, isAnonymous: false, status: 'open',
        createdBy: 'me', hasAnswers: false,
        options: [{ id: 'o1', label: 'Monday' }, { id: 'o2', label: 'Tuesday' }],
      },
    },
  });

  const detail = pollsDetail(context({ poll: 'p1' }));
  await detail.onMount();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const text = (detail.node.textContent || '');
  assert.match(text, /Which day\?/, 'the poll is not shown');
  assert.match(text, /Monday/, 'the options are not shown');
});
