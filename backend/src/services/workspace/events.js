// Events: something the community does at a time.
//
// An event has a title, a description, a start and an end, the timezone it
// was written in, a location (a link the member opens, or a voice room in
// this community), a capacity, the RSVPs and a reminder.
//
// The instants are stored in UTC and the timezone is stored beside them, so
// the event is one moment in time and every reader can see it in their own
// local time. The timezone name is validated against the runtime's list, so
// an event cannot carry a zone that does not exist.
//
// The location of an event is a link or a voice room. A link is stored and
// handed back to the member; the server never fetches it, embeds it or
// proxies it, and a voice room is a channel of this community that the event
// reserves.
const db = require('../../db');
const { now, uuid } = require('../../util');
const { fail, text, required, instant, optionalInstant, positiveInt, oneOf, httpUrl } = require('./common');
const { assertTimeZone, formatInZone } = require('./time');
const jobs = require('../jobs');
const notifications = require('../notifications');

const RSVP_STATUSES = ['going', 'maybe', 'declined'];
const ATTENDANCE_VISIBILITIES = ['members', 'organisers'];
const VOICE_CHANNEL_TYPES = ['voice', 'stage'];

function shape(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    spaceId: row.space_id || null,
    title: row.title,
    description: row.description || '',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    startsAtLocal: formatInZone(row.starts_at, row.timezone),
    endsAtLocal: formatInZone(row.ends_at, row.timezone),
    locationUrl: row.location_url || null,
    voiceChannelId: row.voice_channel_id || null,
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    attendanceVisibility: row.attendance_visibility,
    reminderAt: row.reminder_at || null,
    reminderJobId: row.reminder_job_id || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeRsvp(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function eventOf(serverId, eventId) {
  const row = await db.get('SELECT * FROM events WHERE id = ? AND server_id = ?', [eventId, serverId]);
  if (!row) fail('NOT_FOUND', 'event not found');
  return row;
}

async function list(serverId) {
  const rows = await db.all('SELECT * FROM events WHERE server_id = ? ORDER BY starts_at ASC, id ASC', [serverId]);
  return rows.map(shape);
}

async function get(serverId, eventId) {
  return shape(await eventOf(serverId, eventId));
}

// The voice room an event reserves has to be a voice channel of this
// community. A text channel is not a room.
async function assertVoiceChannel(serverId, channelId) {
  if (!channelId) return null;
  const ch = await db.get('SELECT * FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
  if (!ch) fail('NOT_FOUND', 'voice channel not found in this community');
  if (!VOICE_CHANNEL_TYPES.includes(ch.type)) {
    fail('VALIDATION_ERROR', 'that channel is not a voice channel');
  }
  return ch.id;
}

async function create(serverId, actorId, input) {
  const title = required(input.title, 255, 'title');
  const timezone = assertTimeZone(input.timezone, 'timezone');
  const startsAt = instant(input.startsAt, 'startsAt');
  const endsAt = instant(input.endsAt, 'endsAt');
  if (new Date(endsAt) <= new Date(startsAt)) fail('VALIDATION_ERROR', 'the event ends before it starts');
  const voiceChannelId = await assertVoiceChannel(serverId, input.voiceChannelId);
  const capacity = positiveInt(input.capacity, 'capacity');
  const visibility = oneOf(input.attendanceVisibility, ATTENDANCE_VISIBILITIES, 'attendanceVisibility', 'members');
  let space = null;
  if (input.spaceId) {
    space = await db.get('SELECT id FROM spaces WHERE id = ? AND server_id = ?', [input.spaceId, serverId]);
    if (!space) fail('NOT_FOUND', 'space not found in this community');
  }
  const reminderAt = optionalInstant(input.reminderAt, 'reminderAt');
  if (reminderAt && new Date(reminderAt) > new Date(startsAt)) {
    fail('VALIDATION_ERROR', 'the reminder is after the event starts');
  }
  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO events (id, server_id, space_id, title, description, starts_at, ends_at, timezone, location_url,'
    + ' voice_channel_id, capacity, attendance_visibility, reminder_at, created_by, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, serverId, space ? space.id : null, title, text(input.description, 10000, 'description'),
      startsAt, endsAt, timezone, input.locationUrl ? httpUrl(input.locationUrl) : null,
      voiceChannelId, capacity, visibility, reminderAt, actorId, ts, ts]
  );
  const row = await db.get('SELECT * FROM events WHERE id = ?', [id]);
  if (reminderAt) {
    const jobId = await scheduleReminder(row);
    await db.run('UPDATE events SET reminder_job_id = ? WHERE id = ?', [jobId, id]);
  }
  return get(serverId, id);
}

async function update(serverId, eventId, actorId, input) {
  const row = await eventOf(serverId, eventId);
  const sets = [];
  const vals = [];
  // The two instants are checked together, against the values the event will
  // have after the write - a start that is moved past the end is refused
  // before anything is written.
  const startsAt = input.startsAt === undefined ? row.starts_at : instant(input.startsAt, 'startsAt');
  const endsAt = input.endsAt === undefined ? row.ends_at : instant(input.endsAt, 'endsAt');
  if (new Date(endsAt) <= new Date(startsAt)) fail('VALIDATION_ERROR', 'the event ends before it starts');
  if (input.title !== undefined) {
    sets.push('title = ?');
    vals.push(required(input.title, 255, 'title'));
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    vals.push(text(input.description, 10000, 'description'));
  }
  if (input.timezone !== undefined) {
    sets.push('timezone = ?');
    vals.push(assertTimeZone(input.timezone, 'timezone'));
  }
  if (input.startsAt !== undefined) {
    sets.push('starts_at = ?');
    vals.push(startsAt);
  }
  if (input.endsAt !== undefined) {
    sets.push('ends_at = ?');
    vals.push(endsAt);
  }
  if (input.locationUrl !== undefined) {
    sets.push('location_url = ?');
    vals.push(input.locationUrl ? httpUrl(input.locationUrl) : null);
  }
  if (input.voiceChannelId !== undefined) {
    sets.push('voice_channel_id = ?');
    vals.push(await assertVoiceChannel(serverId, input.voiceChannelId));
  }
  if (input.capacity !== undefined) {
    sets.push('capacity = ?');
    vals.push(positiveInt(input.capacity, 'capacity'));
  }
  if (input.attendanceVisibility !== undefined) {
    sets.push('attendance_visibility = ?');
    vals.push(oneOf(input.attendanceVisibility, ATTENDANCE_VISIBILITIES, 'attendanceVisibility'));
  }
  if (input.reminderAt !== undefined) {
    sets.push('reminder_at = ?');
    vals.push(optionalInstant(input.reminderAt, 'reminderAt'));
  }
  if (!sets.length) fail('VALIDATION_ERROR', 'nothing to update');
  vals.push(row.id);
  await db.run(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`, vals);
  const updated = await eventOf(serverId, row.id);
  if (updated.reminder_at) {
    const jobId = await scheduleReminder(updated);
    await db.run('UPDATE events SET reminder_job_id = ? WHERE id = ?', [jobId, updated.id]);
  }
  return get(serverId, row.id);
}

// The reminder, scheduled through the durable job system.
//
// The job is a row in the jobs table: it survives a restart, it is retried
// until it succeeds, and a worker picks it up when its time comes.
async function scheduleReminder(event) {
  const at = new Date(event.reminder_at).getTime();
  if (Number.isNaN(at)) return null;
  return jobs.enqueue(
    'workspace_event_reminder',
    { eventId: event.id },
    { runAfterMs: Math.max(at - Date.now(), 0), maxAttempts: 3 }
  );
}

// The reminder handler. Registered by the server at boot; the exact
// jobs.register(...) call is in the report.
async function reminderJob({ eventId }) {
  const event = await db.get('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!event) return { skipped: 'event not found' };
  const attendees = await db.all(
    "SELECT user_id FROM event_rsvps WHERE event_id = ? AND status = 'going'",
    [event.id]
  );
  for (const attendee of attendees) {
    try {
      await notifications.create(attendee.user_id, 'mention', event.created_by, event.id);
    } catch (e) {
      console.warn('[workspace] could not send the reminder for event ' + event.id + ': ' + (e && e.message));
    }
  }
  return { notified: attendees.length };
}

// An RSVP. One row per member per event: changing the answer replaces the
// previous one rather than adding to it.
async function rsvp(serverId, eventId, actorId, status) {
  const event = await eventOf(serverId, eventId);
  const answer = oneOf(status, RSVP_STATUSES, 'status');
  if (answer === 'going' && event.capacity) {
    const others = await db.get(
      "SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ? AND status = 'going' AND user_id <> ?",
      [event.id, actorId]
    );
    if (Number(others.n) >= Number(event.capacity)) {
      fail('CONFLICT', 'the event is full');
    }
  }
  const ts = now();
  const existing = await db.get(
    'SELECT * FROM event_rsvps WHERE event_id = ? AND user_id = ?',
    [event.id, actorId]
  );
  if (existing) {
    await db.run(
      'UPDATE event_rsvps SET status = ?, updated_at = ? WHERE id = ?',
      [answer, ts, existing.id]
    );
  } else {
    await db.run(
      'INSERT INTO event_rsvps (id, event_id, server_id, user_id, status, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), event.id, serverId, actorId, answer, ts, ts]
    );
  }
  const row = await db.get('SELECT * FROM event_rsvps WHERE event_id = ? AND user_id = ?', [event.id, actorId]);
  return shapeRsvp(row);
}

// The attendance list.
//
// A member of the community may see who is coming. When the event asks for
// organiser-only attendance, the counts are still public but the names are
// not: a member sees that twenty people are coming without learning who they
// are.
async function attendance(serverId, eventId, isOrganiser) {
  const event = await eventOf(serverId, eventId);
  const rows = await db.all(
    `SELECT r.*, u.username AS username, u.display_name AS display_name
     FROM event_rsvps r JOIN users u ON u.id = r.user_id
     WHERE r.event_id = ? ORDER BY r.created_at ASC, r.id ASC`,
    [event.id]
  );
  const counts = { going: 0, maybe: 0, declined: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  const namesAllowed = event.attendance_visibility === 'members' || isOrganiser;
  return {
    eventId: event.id,
    attendanceVisibility: event.attendance_visibility,
    counts,
    capacity: event.capacity === null || event.capacity === undefined ? null : Number(event.capacity),
    // The names are only there when the event allows this reader to see them.
    attendees: namesAllowed
      ? rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name || row.username,
        status: row.status,
        createdAt: row.created_at,
      }))
      : [],
  };
}

module.exports = {
  RSVP_STATUSES, ATTENDANCE_VISIBILITIES,
  list, get, create, update, rsvp, attendance, reminderJob,
};
