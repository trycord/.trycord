// The polls.
//
// A poll is a question put to the community. What the checks drive is the
// counting: a vote replaces the previous one rather than adding to it, an
// anonymous poll names nobody, and a ranked poll is scored by position.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';
import { api, byText, buttonNamed, controlNamed, textOf, waitFor, callTo, callsTo } from './helpers.js';

installDomStub();

const { pollsList, pollsDetail } = await import('../../js/features/workspace/polls.js');
const { bordaPoints } = await import('../../packages/workspace.js');
const { State } = await import('../../packages/store.js');

// The store is shared with the other checks, so what these checks put in it
// is taken out again when they are done.
after(() => { State.servers = []; State.user = null; });

const POLL = {
  id: 'poll-1',
  serverId: 's1',
  question: 'What should we build next?',
  scoring: 'plurality',
  allowsMultiple: false,
  maxChoices: 1,
  isAnonymous: false,
  eligibility: 'members',
  quorum: null,
  opensAt: null,
  closesAt: null,
  status: 'open',
  createdBy: 'ada',
  createdAt: '2026-10-01T10:00:00.000Z',
  closedAt: null,
  options: [
    { id: 'opt-1', pollId: 'poll-1', position: 0, label: 'A bridge' },
    { id: 'opt-2', pollId: 'poll-1', position: 1, label: 'A tunnel' },
  ],
};

const RESULTS = {
  pollId: 'poll-1',
  question: POLL.question,
  status: 'open',
  scoring: 'plurality',
  closed: false,
  results: {
    options: [
      { id: 'opt-1', label: 'A bridge', votes: 3, score: 0, rank: 1 },
      { id: 'opt-2', label: 'A tunnel', votes: 1, score: 0, rank: 2 },
    ],
    ballots: 4,
    votes: 4,
    winner: 'opt-1',
    tied: [],
    quorum: { required: null, votes: 4, met: null },
    voters: [
      { userId: 'ada', username: 'ada', displayName: 'Ada', choices: ['opt-1'] },
      { userId: 'me', username: 'me', displayName: 'Me', choices: ['opt-2'] },
    ],
  },
  snapshot: null,
  recount: null,
};

const CTX = { page: { id: 'community.workspace.poll' }, params: { pollId: 'poll-1' }, serverId: 's1' };

function asMember() {
  State.servers = [{ id: 's1', name: 'Ember Works', permissions: ['SEND_MESSAGES'] }];
  State.user = { id: 'me', username: 'me' };
}

function routes(overrides) {
  return Object.assign({
    [api('/polls')]: { json: [POLL] },
    [api('/polls/poll-1')]: { json: POLL },
    [api('/polls/poll-1/results')]: { json: RESULTS },
  }, overrides || {});
}

test('the polls list shows the polls of the community', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = pollsList({ page: { id: 'community.workspace.polls' }, params: {}, serverId: 's1' });
  await view.onMount();

  assert.ok(byText(view.node, 'What should we build next?').length > 0, 'the poll is not listed');
  assert.ok(callTo(calls, 'GET', api('/polls')), 'the polls were not read');
});

test('a vote replaces the previous one rather than adding to it', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = pollsDetail(CTX);
  await view.onMount();

  const bridge = controlNamed(view.node, 'A bridge');
  assert.ok(bridge, 'the options are not offered');
  bridge.checked = true;
  bridge.dispatch('change', {});
  buttonNamed(view.node, 'Vote').click();

  const first = await waitFor(() => callTo(calls, 'POST', api('/polls/poll-1/vote')));
  assert.ok(first, 'the vote was not sent');
  assert.deepEqual(first.body.choices, ['opt-1']);

  // The reader changes their mind: the whole ballot goes again, and the
  // earlier choice is not sent with it.
  const tunnel = controlNamed(view.node, 'A tunnel');
  tunnel.checked = true;
  tunnel.dispatch('change', {});
  buttonNamed(view.node, 'Vote').click();

  await waitFor(() => callsTo(calls, 'POST', api('/polls/poll-1/vote')).length === 2);
  const votes = callsTo(calls, 'POST', api('/polls/poll-1/vote'));
  assert.equal(votes.length, 2, 'the second vote was not sent');
  assert.deepEqual(votes[1].body.choices, ['opt-2'], 'the second vote carried the first choice as well');
});

test('the count shown is the count the server worked out', async () => {
  asMember();
  // The server counts three votes for the bridge. The client keeps no tally of
  // its own, so the number on the screen is the server's.
  installFetchStub(routes());
  const view = pollsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('3 votes') !== -1, 'the count the server worked out is not shown');
  assert.ok(text.indexOf('A bridge') !== -1, 'the option is not shown');
});

test('an anonymous poll names nobody', async () => {
  asMember();
  installFetchStub(routes({
    [api('/polls/poll-1')]: { json: Object.assign({}, POLL, { isAnonymous: true }) },
  }));
  const view = pollsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('This poll is anonymous') !== -1, 'the reader is not told the poll names nobody');
  assert.equal(text.indexOf('Ada'), -1, 'a voter was named although the poll is anonymous');
  assert.equal(text.indexOf('Grace'), -1, 'a voter was named although the poll is anonymous');
});

test('a ranked poll is scored by position', async () => {
  asMember();
  const ranked = Object.assign({}, POLL, {
    scoring: 'ranked',
    options: [
      { id: 'opt-1', pollId: 'poll-1', position: 0, label: 'A bridge' },
      { id: 'opt-2', pollId: 'poll-1', position: 1, label: 'A tunnel' },
      { id: 'opt-3', pollId: 'poll-1', position: 2, label: 'A ferry' },
    ],
  });
  const scored = {
    pollId: 'poll-1',
    question: POLL.question,
    status: 'open',
    scoring: 'ranked',
    closed: false,
    results: {
      options: [
        { id: 'opt-1', label: 'A bridge', votes: 3, score: 7, rank: 1 },
        { id: 'opt-2', label: 'A tunnel', votes: 3, score: 5, rank: 2 },
        { id: 'opt-3', label: 'A ferry', votes: 3, score: 3, rank: 3 },
      ],
      ballots: 3,
      votes: 9,
      winner: 'opt-1',
      tied: [],
      quorum: { required: null, votes: 3, met: null },
      voters: [],
    },
    snapshot: null,
    recount: null,
  };
  const calls = installFetchStub(routes({
    [api('/polls/poll-1')]: { json: ranked },
    [api('/polls/poll-1/results')]: { json: scored },
  }));
  const view = pollsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('7 points') !== -1, 'the score is not shown');
  assert.ok(text.indexOf('position 1') !== -1, 'the position is not shown');
  assert.ok(text.indexOf('the first choice is worth 3 points') !== -1,
    'the client does not say what a position is worth');

  // The ranking is a ballot, so the client sends the options in the order the
  // reader set.
  const lower = controlNamed(view.node, 'Rank A tunnel lower');
  assert.ok(lower, 'the ranking cannot be changed');
  lower.click();
  buttonNamed(view.node, 'Vote').click();

  const voted = await waitFor(() => callTo(calls, 'POST', api('/polls/poll-1/vote')));
  assert.ok(voted, 'the ranked ballot was not sent');
  assert.deepEqual(voted.body.choices, ['opt-1', 'opt-3', 'opt-2']);
});

test('the points of a position are the ones the server scores by', () => {
  // The first choice of a ballot is worth the number of options, the second
  // one fewer, and the last one a point.
  assert.equal(bordaPoints(1, 3), 3);
  assert.equal(bordaPoints(2, 3), 2);
  assert.equal(bordaPoints(3, 3), 1);
  assert.equal(bordaPoints(4, 3), 0, 'a position past the last one is worth nothing');
  assert.equal(bordaPoints(0, 3), 0, 'a position before the first one is worth nothing');
});

test('the results of an open poll are hidden from a reader the server hides them from', async () => {
  asMember();
  installFetchStub(routes({
    [api('/polls/poll-1/results')]: {
      ok: false,
      status: 403,
      json: {
        error: {
          code: 'PERMISSION_DENIED',
          message: 'the results of this poll are not visible until it closes',
        },
      },
    },
  }));
  const view = pollsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('The results are not visible yet') !== -1, 'the refusal is not shown as what it is');
  assert.ok(text.indexOf('until the poll closes') !== -1, 'the reader is not told why');
});
