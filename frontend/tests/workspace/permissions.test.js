// The permissions.
//
// The client asks the permission system so it does not offer what the server
// would refuse. The checks drive every surface with an account that holds
// nothing, and with one that holds what it needs, and ask what is on the
// screen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';
import { api, byText, buttonNamed, controlNamed, textOf, waitFor } from './helpers.js';

installDomStub();

const { spacesList, spacesDetail } = await import('../../js/features/workspace/spaces.js');
const { documentsList, documentsDetail } = await import('../../js/features/workspace/documents.js');
const { boardsDetail } = await import('../../js/features/workspace/boards.js');
const { eventsDetail } = await import('../../js/features/workspace/events.js');
const { pollsDetail } = await import('../../js/features/workspace/polls.js');
const { State } = await import('../../packages/store.js');

const SPACE = {
  id: 'space-1', name: 'Engineering', description: '', isPrivate: false, items: [
    { id: 'item-1', spaceId: 'space-1', kind: 'channel', targetId: 'chan-1', title: 'general', position: 0 },
    { id: 'item-2', spaceId: 'space-1', kind: 'document', targetId: 'doc-1', title: 'How we work', position: 1 },
  ],
};

const DOCUMENT = {
  id: 'doc-1', serverId: 's1', title: 'How we work', body: [{ type: 'paragraph', text: 'We write it down.' }],
  revision: 3, authorId: 'ada', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
};

const BOARD = {
  id: 'board-1', serverId: 's1', name: 'The quarter', description: '',
  columns: [{ id: 'col-1', boardId: 'board-1', name: 'To do', position: 0 }],
  milestones: [],
  cards: [{
    id: 'card-1', boardId: 'board-1', columnId: 'col-1', title: 'Write the spec', body: '',
    assigneeId: null, dueAt: null, dueTimezone: null, priority: 'normal', status: 'open',
    position: 0, version: 1, createdBy: 'ada', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
  }],
};

const CARD = Object.assign({}, BOARD.cards[0], {
  labels: [], links: [], milestones: [],
  activity: [{ id: 'act-1', cardId: 'card-1', actorId: 'ada', field: 'created', from: null, to: 'Write the spec', createdAt: '2026-10-01T10:00:00.000Z' }],
});

const EVENT = {
  id: 'event-1', serverId: 's1', title: 'The reading group', description: '',
  startsAt: '2026-10-20T18:00:00.000Z', endsAt: '2026-10-20T20:00:00.000Z', timezone: 'UTC',
  startsAtLocal: 'Oct 20, 2026, 6:00 PM', endsAtLocal: 'Oct 20, 2026, 8:00 PM',
  locationUrl: null, voiceChannelId: null, capacity: null, attendanceVisibility: 'members',
  createdBy: 'ada', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
};

const POLL = {
  id: 'poll-1', serverId: 's1', question: 'What should we build next?', scoring: 'plurality',
  allowsMultiple: false, maxChoices: 1, isAnonymous: false, eligibility: 'members', quorum: null,
  opensAt: null, closesAt: null, status: 'open', createdBy: 'ada',
  createdAt: '2026-10-01T10:00:00.000Z', closedAt: null,
  options: [{ id: 'opt-1', pollId: 'poll-1', position: 0, label: 'A bridge' }],
};

function routes() {
  return {
    [api('/spaces')]: { json: [SPACE] },
    [api('/spaces/space-1')]: { json: SPACE },
    [api('/documents')]: { json: [DOCUMENT] },
    [api('/documents/doc-1')]: { json: DOCUMENT },
    [api('/documents/doc-1/revisions')]: { json: [] },
    [api('/documents/doc-1/comments')]: { json: [] },
    [api('/documents/doc-1/links')]: { json: [] },
    [api('/boards')]: { json: [BOARD] },
    [api('/boards/board-1')]: { json: BOARD },
    [api('/boards/board-1/cards/card-1')]: { json: CARD },
    [api('/members')]: { json: { items: [], total: 0, hasMore: false } },
    [api('/events')]: { json: [EVENT] },
    [api('/events/event-1')]: { json: EVENT },
    [api('/events/event-1/attendance')]: {
      json: { eventId: 'event-1', attendanceVisibility: 'members', counts: { going: 1, maybe: 0, declined: 0 }, capacity: null, attendees: [] },
    },
    [api('/polls')]: { json: [POLL] },
    [api('/polls/poll-1')]: { json: POLL },
    [api('/polls/poll-1/results')]: {
      json: {
        pollId: 'poll-1', question: POLL.question, status: 'open', scoring: 'plurality', closed: false,
        results: {
          options: [{ id: 'opt-1', label: 'A bridge', votes: 1, score: 0, rank: 1 }],
          ballots: 1, votes: 1, winner: 'opt-1', tied: [],
          quorum: { required: null, votes: 1, met: null }, voters: [],
        },
        snapshot: null, recount: null,
      },
    },
  };
}

// An account that holds nothing.
function asReader(permissions) {
  State.servers = [{ id: 's1', name: 'Ember Works', permissions: permissions || [] }];
  State.user = { id: 'me', username: 'me' };
}

test('a reader who may not manage the structure is offered no structure', async () => {
  asReader([]);
  installFetchStub(routes());

  const spaces = spacesList({ page: { id: 'community.workspace.spaces' }, params: {}, serverId: 's1' });
  await spaces.onMount();
  assert.equal(buttonNamed(spaces.node, 'New space'), null, 'a space may be made by a reader who may not');

  const space = spacesDetail({ page: { id: 'community.workspace.space' }, params: { spaceId: 'space-1' }, serverId: 's1' });
  await space.onMount();
  assert.equal(buttonNamed(space.node, 'Add a reference'), null, 'a reference may be added by a reader who may not');
  assert.equal(controlNamed(space.node, 'Move How we work up'), null, 'a reference may be moved by a reader who may not');
  assert.equal(controlNamed(space.node, 'Remove general from the space'), null, 'a reference may be removed by a reader who may not');

  const board = boardsDetail({ page: { id: 'community.workspace.board' }, params: { boardId: 'board-1' }, serverId: 's1' });
  await board.onMount();
  assert.equal(buttonNamed(board.node, 'Add a card'), null, 'a card may be posted by a reader who may not');
  assert.equal(buttonNamed(board.node, 'Lane'), null, 'a lane may be made by a reader who may not');
});

test('a reader who may not write a document is offered no editor', async () => {
  asReader([]);
  installFetchStub(routes());

  const list = documentsList({ page: { id: 'community.workspace.documents' }, params: {}, serverId: 's1' });
  await list.onMount();
  assert.equal(buttonNamed(list.node, 'New document'), null, 'a document may be made by a reader who may not');

  const document = documentsDetail({ page: { id: 'community.workspace.document' }, params: { documentId: 'doc-1' }, serverId: 's1' });
  await document.onMount();
  assert.equal(buttonNamed(document.node, 'Edit'), null, 'a document may be edited by a reader who may not');
  assert.equal(buttonNamed(document.node, 'Restore'), null, 'a revision may be restored by a reader who may not');
  assert.equal(buttonNamed(document.node, 'Add'), null, 'a link may be added by a reader who may not');
});

test('a reader who may not post is offered no ballot', async () => {
  asReader([]);
  installFetchStub(routes());

  const poll = pollsDetail({ page: { id: 'community.workspace.poll' }, params: { pollId: 'poll-1' }, serverId: 's1' });
  await poll.onMount();
  assert.equal(buttonNamed(poll.node, 'Vote'), null, 'a vote may be cast by a reader who may not');

  const event = eventsDetail({ page: { id: 'community.workspace.event' }, params: { eventId: 'event-1' }, serverId: 's1' });
  await event.onMount();
  assert.equal(buttonNamed(event.node, 'Going'), null, 'an event may be answered by a reader who may not');

  const document = documentsDetail({ page: { id: 'community.workspace.document' }, params: { documentId: 'doc-1' }, serverId: 's1' });
  await document.onMount();
  assert.equal(buttonNamed(document.node, 'Comment'), null, 'a comment may be made by a reader who may not');
});

test('a reader who may post is offered the ballot, and one who may not is not', async () => {
  asReader(['SEND_MESSAGES']);
  installFetchStub(routes());

  const poll = pollsDetail({ page: { id: 'community.workspace.poll' }, params: { pollId: 'poll-1' }, serverId: 's1' });
  await poll.onMount();
  assert.ok(buttonNamed(poll.node, 'Vote'), 'a reader who may post is not offered the ballot');

  const event = eventsDetail({ page: { id: 'community.workspace.event' }, params: { eventId: 'event-1' }, serverId: 's1' });
  await event.onMount();
  assert.ok(buttonNamed(event.node, 'Going'), 'a reader who may post cannot answer an event');
});

test("a reader may act on their own card, and only a moderator on somebody else's", async () => {
  asReader(['SEND_MESSAGES']);
  installFetchStub(routes());

  // The card in these checks belongs to somebody else.
  const card = boardsDetail({ page: { id: 'community.workspace.card' }, params: { boardId: 'board-1', cardId: 'card-1' }, serverId: 's1' });
  await card.onMount();
  assert.equal(buttonNamed(card.node, 'Edit'), null, 'somebody else\'s card may be edited');

  asReader(['SEND_MESSAGES', 'MANAGE_MESSAGES']);
  const moderator = boardsDetail({ page: { id: 'community.workspace.card' }, params: { boardId: 'board-1', cardId: 'card-1' }, serverId: 's1' });
  await moderator.onMount();
  assert.ok(buttonNamed(moderator.node, 'Edit'), 'a moderator cannot act on somebody else\'s card');
});

test('a reader who may manage the structure is offered it', async () => {
  asReader(['MANAGE_CHANNELS']);
  installFetchStub(routes());

  const spaces = spacesList({ page: { id: 'community.workspace.spaces' }, params: {}, serverId: 's1' });
  await spaces.onMount();
  assert.ok(buttonNamed(spaces.node, 'New space'), 'a reader who may manage the structure is offered no space');

  const space = spacesDetail({ page: { id: 'community.workspace.space' }, params: { spaceId: 'space-1' }, serverId: 's1' });
  await space.onMount();
  assert.ok(buttonNamed(space.node, 'Add a reference'), 'a reader who may manage the structure may not add a reference');
  assert.ok(controlNamed(space.node, 'Remove general from the space'), 'a reference may not be removed');
});
