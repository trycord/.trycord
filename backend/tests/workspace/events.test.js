// Events: the time, the place, the RSVPs and the reminder.
//
// The instants are UTC and the timezone is kept beside them, so an event
// written in Berlin is the same moment as the one written in Lisbon, and the
// reader can see it in their own time. The reminder is a durable job, not a
// timer in a request handler.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startWorkspace, createCommunity, addMember, channelsOf, registerUser,
} = require('./helpers');

test('events', async (t) => {
  const ws = await startWorkspace();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'ada');
  const serverId = await createCommunity(ws, owner, 'Events');
  const member = await addMember(ws, owner, serverId, 'bob');

  const startsAt = new Date(Date.now() + 3600000).toISOString();
  const endsAt = new Date(Date.now() + 7200000).toISOString();

  await t.test('an event is created with its timezone', async () => {
    const created = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'Planning',
      description: 'What we do next.',
      startsAt,
      endsAt,
      timezone: 'Europe/Berlin',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.startsAt, startsAt, 'the instant is stored as it was given');
    assert.equal(created.data.timezone, 'Europe/Berlin');
    assert.ok(created.data.startsAtLocal, 'the event is rendered in its own timezone');
    assert.equal(created.data.startsAtLocal, new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(startsAt)));
  });

  await t.test('a timezone that does not exist is refused', async () => {
    const res = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'Nowhere',
      startsAt,
      endsAt,
      timezone: 'Mars/Olympus',
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VALIDATION_ERROR');
  });

  await t.test('an RSVP is recorded and the attendance list shows it', async () => {
    const created = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'Standup',
      startsAt,
      endsAt,
      timezone: 'UTC',
    });
    const eventId = created.data.id;

    const rsvp = await member.post(`/api/servers/${serverId}/events/${eventId}/rsvp`, { status: 'going' });
    assert.equal(rsvp.status, 200, JSON.stringify(rsvp.data));
    assert.equal(rsvp.data.status, 'going');

    // Answering again replaces the answer rather than adding to it.
    const changed = await member.post(`/api/servers/${serverId}/events/${eventId}/rsvp`, { status: 'maybe' });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.status, 'maybe');

    const attendance = await member.get(`/api/servers/${serverId}/events/${eventId}/attendance`);
    assert.equal(attendance.status, 200);
    assert.equal(attendance.data.counts.going, 0);
    assert.equal(attendance.data.counts.maybe, 1);
    assert.ok(attendance.data.attendees.some((a) => a.userId === member.user.id));
  });

  await t.test('a reminder is scheduled through the job system', async () => {
    const reminderAt = new Date(Date.now() + 600000).toISOString();
    const created = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'With a reminder',
      startsAt,
      endsAt,
      timezone: 'UTC',
      reminderAt,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.reminderAt, reminderAt);
    assert.ok(created.data.reminderJobId, 'the event says which job will remind them');

    // The job is a durable row, not a timer in the request.
    const job = await ws.db.get('SELECT * FROM jobs WHERE id = ?', [created.data.reminderJobId]);
    assert.ok(job, 'the reminder job is in the jobs table');
    assert.equal(job.kind, 'workspace_event_reminder');
    assert.deepEqual(JSON.parse(job.payload), { eventId: created.data.id });
  });

  await t.test('a voice room is reserved by reference, not by proxying anything', async () => {
    const created = await owner.post(`/api/servers/${serverId}/channels`, { name: 'meeting-room', type: 'voice' });
    const voiceChannelId = created.data.id;
    const event = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'Voice call',
      startsAt,
      endsAt,
      timezone: 'UTC',
      voiceChannelId,
    });
    assert.equal(event.status, 201, JSON.stringify(event.data));
    assert.equal(event.data.voiceChannelId, voiceChannelId);

    // A text channel is not a room.
    const channels = await channelsOf(owner, serverId);
    const wrong = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'Not a room',
      startsAt,
      endsAt,
      timezone: 'UTC',
      voiceChannelId: channels[0].id,
    });
    assert.equal(wrong.status, 400);
  });

  await t.test('an event with a capacity refuses the answer that would fill it', async () => {
    const created = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'Small room',
      startsAt,
      endsAt,
      timezone: 'UTC',
      capacity: 1,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.capacity, 1);

    const first = await owner.post(`/api/servers/${serverId}/events/${created.data.id}/rsvp`, { status: 'going' });
    assert.equal(first.status, 200);

    const second = await member.post(`/api/servers/${serverId}/events/${created.data.id}/rsvp`, { status: 'going' });
    assert.equal(second.status, 409, 'the room is full');
    assert.equal(second.data.error.code, 'CONFLICT');

    // Answering "maybe" is still an answer, and it is not the one that fills
    // the room.
    const maybe = await member.post(`/api/servers/${serverId}/events/${created.data.id}/rsvp`, { status: 'maybe' });
    assert.equal(maybe.status, 200);
  });

  await t.test('the attendance list is not exposed to a member of another community', async () => {
    const created = await owner.post(`/api/servers/${serverId}/events`, {
      title: 'Closed door',
      startsAt,
      endsAt,
      timezone: 'UTC',
    });
    const outsider = await registerUser(ws, 'mallory');
    const res = await outsider.get(`/api/servers/${serverId}/events/${created.data.id}/attendance`);
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'NOT_A_MEMBER');
  });
});
