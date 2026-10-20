// The events.
//
// An event is something the community does at a time. What the checks drive is
// the answer: one answer per member, and the attendance list showing exactly
// what the server allows it to show.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';
import { api, byText, buttonNamed, textOf, waitFor, callTo, callsTo } from './helpers.js';

installDomStub();

const { eventsList, eventsDetail } = await import('../../js/features/workspace/events.js');
const { attendanceRows } = await import('../../packages/workspace.js');
const { State } = await import('../../packages/store.js');

// The store is shared with the other checks, so what these checks put in it
// is taken out again when they are done.
after(() => { State.servers = []; State.user = null; });

const EVENT = {
  id: 'event-1',
  serverId: 's1',
  title: 'The reading group',
  description: 'We read one thing together',
  startsAt: '2026-10-20T18:00:00.000Z',
  endsAt: '2026-10-20T20:00:00.000Z',
  timezone: 'Europe/Berlin',
  startsAtLocal: 'Oct 20, 2026, 8:00 PM',
  endsAtLocal: 'Oct 20, 2026, 10:00 PM',
  locationUrl: null,
  voiceChannelId: null,
  capacity: 10,
  attendanceVisibility: 'members',
  createdBy: 'ada',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

const ATTENDANCE = {
  eventId: 'event-1',
  attendanceVisibility: 'members',
  counts: { going: 2, maybe: 1, declined: 0 },
  capacity: 10,
  attendees: [
    { userId: 'me', username: 'ada', displayName: 'Ada', status: 'going', createdAt: '2026-10-02T09:00:00.000Z' },
    { userId: 'ada', username: 'grace', displayName: 'Grace', status: 'maybe', createdAt: '2026-10-02T10:00:00.000Z' },
  ],
};

const CTX = { page: { id: 'community.workspace.event' }, params: { eventId: 'event-1' }, serverId: 's1' };

function asMember() {
  State.servers = [{ id: 's1', name: 'Ember Works', permissions: ['SEND_MESSAGES', 'MANAGE_CHANNELS'] }];
  State.user = { id: 'me', username: 'ada' };
}

function routes(overrides) {
  return Object.assign({
    [api('/events')]: { json: [EVENT] },
    [api('/events/event-1')]: { json: EVENT },
    [api('/events/event-1/attendance')]: { json: ATTENDANCE },
  }, overrides || {});
}

test('the events list shows the events of the community', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = eventsList({ page: { id: 'community.workspace.events' }, params: {}, serverId: 's1' });
  await view.onMount();

  assert.ok(byText(view.node, 'The reading group').length > 0, 'the event is not listed');
  assert.ok(callTo(calls, 'GET', api('/events')), 'the events were not read');
});

test('an event shows when it is, in the zone it was written in and in the reader\'s', async () => {
  asMember();
  installFetchStub(routes());
  const view = eventsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('Europe/Berlin') !== -1, 'the zone the event was written in is not shown');
  assert.ok(text.indexOf('Where you are') !== -1, 'the reader\'s own time is not shown');
});

test('an answer replaces the previous one rather than adding to it', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = eventsDetail(CTX);
  await view.onMount();

  const going = buttonNamed(view.node, 'Going');
  assert.ok(going, 'a reader who may post cannot answer the event');
  going.click();

  const first = await waitFor(() => callTo(calls, 'POST', api('/events/event-1/rsvp')));
  assert.ok(first, 'the answer was not sent');
  assert.equal(first.body.status, 'going');

  // The reader changes their mind: the whole answer goes again, and the
  // previous one is not sent alongside it.
  const maybe = buttonNamed(view.node, 'Maybe');
  assert.ok(maybe, 'the reader cannot change their answer');
  maybe.click();

  await waitFor(() => callsTo(calls, 'POST', api('/events/event-1/rsvp')).length === 2);
  const answers = callsTo(calls, 'POST', api('/events/event-1/rsvp'));
  assert.equal(answers.length, 2, 'the second answer was not sent');
  assert.equal(answers[1].body.status, 'maybe');
  assert.deepEqual(Object.keys(answers[1].body), ['status'], 'the answer carried more than the answer');
});

test('the attendance is one line per member', async () => {
  asMember();
  // A member has one answer, so the list is read as one line per member even
  // if the server sends the same member twice.
  const rows = attendanceRows({
    attendees: [
      { userId: 'me', username: 'ada', displayName: 'Ada', status: 'going', createdAt: '2026-10-02T09:00:00.000Z' },
      { userId: 'me', username: 'ada', displayName: 'Ada', status: 'maybe', createdAt: '2026-10-03T09:00:00.000Z' },
      { userId: 'ada', username: 'grace', displayName: 'Grace', status: 'going', createdAt: '2026-10-02T10:00:00.000Z' },
    ],
  });
  assert.equal(rows.length, 2, 'the member is listed twice');
  assert.equal(rows[0].status, 'maybe', 'the later answer is not the one kept');
});

test('the attendance names the members when the server allows it', async () => {
  asMember();
  installFetchStub(routes());
  const view = eventsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('Grace') !== -1, 'a member of the attendance is not named');
  assert.ok(byText(view.node, '2').length > 0, 'the counts are not shown');
});

test('the attendance withholds the names when the event asks it to', async () => {
  asMember();
  installFetchStub(routes({
    [api('/events/event-1')]: { json: Object.assign({}, EVENT, { attendanceVisibility: 'organisers' }) },
    [api('/events/event-1/attendance')]: {
      json: {
        eventId: 'event-1',
        attendanceVisibility: 'organisers',
        counts: { going: 20, maybe: 3, declined: 1 },
        capacity: 10,
        attendees: [],
      },
    },
  }));
  const view = eventsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('The names are not shown') !== -1, 'the reader is not told the names are withheld');
  assert.ok(text.indexOf('20') !== -1, 'the counts are not shown');
  assert.equal(text.indexOf('Grace'), -1, 'a name was shown although the server withheld it');
});
