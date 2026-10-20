// The boards.
//
// A board holds lanes and cards. What the checks drive is the part that is
// easy to get wrong: a card states the version it was written against, so a
// move and an edit are both refused when the card has moved on.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';
import { api, byText, buttonNamed, controlNamed, fieldNamed, openForm, textOf, waitFor, callTo } from './helpers.js';

installDomStub();

const { boardsList, boardsDetail } = await import('../../js/features/workspace/boards.js');
const { State } = await import('../../packages/store.js');

// The store is shared with the other checks, so what these checks put in it
// is taken out again when they are done.
after(() => { State.servers = []; State.user = null; });

const BOARD = {
  id: 'board-1',
  serverId: 's1',
  name: 'The quarter',
  description: 'What we are doing this quarter',
  columns: [
    { id: 'col-1', boardId: 'board-1', name: 'To do', position: 0 },
    { id: 'col-2', boardId: 'board-1', name: 'In progress', position: 1 },
    { id: 'col-3', boardId: 'board-1', name: 'Done', position: 2 },
  ],
  milestones: [
    { id: 'ms-1', boardId: 'board-1', name: 'Ship it', description: 'The release', dueAt: null, dueTimezone: null },
  ],
  cards: [
    {
      id: 'card-1', boardId: 'board-1', columnId: 'col-1', title: 'Write the spec',
      body: 'What the thing does', assigneeId: null, dueAt: null, dueTimezone: null,
      priority: 'normal', status: 'open', position: 0, version: 4,
      createdBy: 'me', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
    },
    {
      id: 'card-2', boardId: 'board-1', columnId: 'col-2', title: 'Build it',
      body: '', assigneeId: null, dueAt: null, dueTimezone: null,
      priority: 'high', status: 'in_progress', position: 0, version: 1,
      createdBy: 'ada', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
    },
  ],
};

const CARD = Object.assign({}, BOARD.cards[0], {
  labels: ['spec'],
  links: [],
  milestones: [],
  activity: [
    { id: 'act-1', cardId: 'card-1', actorId: 'me', field: 'created', from: null, to: 'Write the spec', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'act-2', cardId: 'card-1', actorId: 'ada', field: 'priority', from: 'normal', to: 'high', createdAt: '2026-10-02T09:00:00.000Z' },
  ],
});

function asMember() {
  State.servers = [{ id: 's1', name: 'Ember Works', permissions: ['SEND_MESSAGES', 'MANAGE_CHANNELS'] }];
  State.user = { id: 'me', username: 'ada' };
}

function routes(overrides) {
  return Object.assign({
    [api('/boards')]: { json: [BOARD] },
    [api('/boards/board-1')]: { json: BOARD },
    [api('/boards/board-1/cards/card-1')]: { json: CARD },
    [api('/members')]: { json: { items: [{ id: 'ada', username: 'ada', display_name: 'Ada' }], total: 1, hasMore: false } },
  }, overrides || []);
}

test('the boards list shows the boards of the community', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = boardsList({ page: { id: 'community.workspace.boards' }, params: {}, serverId: 's1' });
  await view.onMount();

  assert.ok(byText(view.node, 'The quarter').length > 0, 'the board is not listed');
  assert.ok(callTo(calls, 'GET', api('/boards')), 'the boards were not read');
});

test('a board shows its lanes and the cards in them', async () => {
  asMember();
  installFetchStub(routes());
  const view = boardsDetail({ page: { id: 'community.workspace.board' }, params: { boardId: 'board-1' }, serverId: 's1' });
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('To do') !== -1, 'the first lane is not shown');
  assert.ok(text.indexOf('In progress') !== -1, 'the second lane is not shown');
  assert.ok(text.indexOf('Done') !== -1, 'the third lane is not shown');
  assert.ok(text.indexOf('Write the spec') !== -1, 'the card is not shown');
  assert.ok(text.indexOf('Build it') !== -1, 'the second card is not shown');
});

test('a card shows what changed and who changed it', async () => {
  asMember();
  installFetchStub(routes());
  const view = boardsDetail({ page: { id: 'community.workspace.card' }, params: { boardId: 'board-1', cardId: 'card-1' }, serverId: 's1' });
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('Version 4') !== -1, 'the version of the card is not shown');
  assert.ok(text.indexOf('Created: Write the spec') !== -1, 'the creation is not in the activity');
  assert.ok(text.indexOf('Changed priority from normal to high') !== -1, 'the change is not in the activity');
});

test('a card is moved to another lane', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = boardsDetail({ page: { id: 'community.workspace.card' }, params: { boardId: 'board-1', cardId: 'card-1' }, serverId: 's1' });
  await view.onMount();

  const lane = controlNamed(view.node, 'The lane to move the card into');
  assert.ok(lane, 'the card cannot be moved');
  lane.value = 'col-2';
  const move = buttonNamed(view.node, 'Move');
  assert.ok(move, 'there is no move control');
  move.click();

  const moved = await waitFor(() => callTo(calls, 'POST', api('/boards/board-1/cards/card-1/move')));
  assert.ok(moved, 'the card was not moved');
  assert.equal(moved.body.columnId, 'col-2');
  assert.equal(moved.body.version, 4, 'the move did not state the version it was written against');
});

test('an edit written against an older version is refused', async () => {
  asMember();
  const calls = installFetchStub(routes({
    [api('/boards/board-1/cards/card-1')]: (body, seen) => {
      const last = seen[seen.length - 1];
      if (last.options.method === 'PATCH') {
        return {
          ok: false,
          status: 409,
          json: {
            error: {
              code: 'CONFLICT',
              message: 'this card changed since you loaded it',
              details: { currentVersion: 9, submittedVersion: 4 },
            },
          },
        };
      }
      return { json: CARD };
    },
  }));
  const view = boardsDetail({ page: { id: 'community.workspace.card' }, params: { boardId: 'board-1', cardId: 'card-1' }, serverId: 's1' });
  await view.onMount();

  const edit = buttonNamed(view.node, 'Edit');
  assert.ok(edit, 'the author of the card cannot edit it');
  edit.click();

  const title = fieldNamed(document.body, 'The title of the card');
  assert.ok(title, 'the card editor has no title field');
  title.value = 'Write the spec again';
  openForm().submit();

  const conflict = await waitFor(() => byText(view.node, 'This card changed while you were editing it')[0]);
  assert.ok(conflict, 'the conflict was not shown');
  assert.ok(byText(view.node, 'version 9').length > 0, 'the conflict does not say which version the server holds');

  const patches = calls.filter((call) => call.options.method === 'PATCH');
  assert.equal(patches.length, 1, 'the refused edit was sent again');
  assert.equal(patches[0].body.version, 4, 'the edit did not state the version it was written against');
});

test('a card is made on a board', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = boardsDetail({ page: { id: 'community.workspace.board' }, params: { boardId: 'board-1' }, serverId: 's1' });
  await view.onMount();

  const add = buttonNamed(view.node, 'Add a card');
  assert.ok(add, 'a reader who may post cannot add a card');
  add.click();

  const title = fieldNamed(document.body, 'The title of the card');
  title.value = 'A new card';
  openForm().submit();

  const created = await waitFor(() => callTo(calls, 'POST', api('/boards/board-1/cards')));
  assert.ok(created, 'the card was not made');
  assert.equal(created.body.title, 'A new card');
  assert.equal(created.body.columnId, 'col-1', 'the card was not filed in the lane it was made in');
});
