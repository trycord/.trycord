// The events, on a desk.
//
// An event has a title, a description, a start and an end, the timezone it was
// written in, a location, a capacity, the RSVPs and a reminder.
//
// The instants are stored in UTC and the timezone is stored beside them, so an
// event is one moment in time and every reader can see it in their own local
// time. The desk shows both: the time the event was written in, and the time
// it is where the reader is.
//
// An RSVP is one answer per member: changing it replaces the previous answer
// rather than adding to it. The attendance list is read as one line per member
// for the same reason.
//
// The counts of an attendance list are public even when the names are not: a
// member learns that twenty people are coming without learning who they are.
// The desk shows exactly what the server sent and says so when the names are
// withheld.
//
// Creating an event needs MANAGE_CHANNELS; answering one needs SEND_MESSAGES.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { card, row, blank, fault, fold, hold, facts } from '../../ui/page.js';
import { openDialog, toast, errorToast } from '../../ui/overlays.js';
import { relativeTime } from '../../../packages/format.js';
import { path } from '../../../packages/nav.js';
import { State } from '../../../packages/store.js';
import {
  Workspace, RSVP_STATUSES, RSVP_LABELS, ATTENDANCE_VISIBILITY_LABELS,
  mayManageStructure, mayPost, paramId,
  eventRoute, formatInstant, readerZone, attendanceCounts, attendanceRows,
  instantInZone, toZoneInput,
} from '../../../packages/workspace.js';

// -- the list ------------------------------------------------------------------

export function eventsList(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'rowlist' });
  const canManage = mayManageStructure(serverId);

  const node = card({
    label: 'Events',
    glyph: 'calendar',
    note: 'what the community does at a time',
    actions: canManage
      ? el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => openEventEditor(serverId, null),
      }, icon('plus', { size: 14 }), 'New event')
      : null,
    body: host,
    flush: true,
  });

  const load = async () => {
    host.replaceChildren(hold('Reading the events'));
    try {
      const events = await Workspace.events(serverId);
      host.replaceChildren(...(events.length
        ? events.map((event) => row({
          lead: el('span', { class: 'role-dot' }, icon('calendar', { size: 15 })),
          title: event.title,
          sub: (event.startsAtLocal || '') + (event.timezone ? ' · ' + event.timezone : ''),
          meta: event.capacity ? 'up to ' + event.capacity : null,
          href: path(eventRoute(serverId, event.id)),
          link: true,
        }))
        : [blank({
          glyph: 'calendar',
          title: 'No events yet',
          text: 'An event is something the community does at a time.',
        })]));
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  return { node, onMount: load, cleanup() {} };
}

// -- one event -------------------------------------------------------------------

export function eventsDetail(ctx) {
  const serverId = ctx.serverId;
  const eventId = paramId(ctx.params, 'event');

  if (!eventId) {
    return {
      node: blank({
        glyph: 'calendar',
        title: 'No event open',
        text: 'Choose an event on the left to see it.',
      }),
      onMount: async () => {},
      cleanup() {},
    };
  }

  const canPost = mayPost(serverId);
  const me = State.user && State.user.id;

  let event = null;
  let attendance = null;
  let mine = null;         // the reader's own answer, when it is known

  const head = el('div', { class: 'fold fold--tight' });
  const rsvp = el('div', { class: 'fold fold--tight' });
  const people = el('div', { class: 'rowlist' });
  const counts = el('div', { class: 'fold fold--tight' });

  const node = fold([
    card({
      label: 'The event',
      glyph: 'calendar',
      actions: mayManageStructure(serverId)
        ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => openEventEditor(serverId, event, load),
        }, icon('edit', { size: 14 }), 'Edit')
        : null,
      body: fold([head, rsvp], { tight: true }),
    }),
    card({ label: 'Attendance', glyph: 'users', body: fold([counts, people], { tight: true }), flush: true }),
  ], { wide: true });

  const paintHead = () => {
    const zone = event.timezone || 'UTC';
    head.replaceChildren(
      el('h2', { class: 'pagehead-title' }, event.title),
      event.description ? el('p', { class: 'form-note' }, event.description) : null,
      el('p', { class: 'form-note' },
        'Starts ' + (event.startsAtLocal || formatInstant(event.startsAt, zone))
        + ' · ends ' + (event.endsAtLocal || formatInstant(event.endsAt, zone))),
      el('p', { class: 'form-note' },
        'That is the time it was written in (' + zone + '). '
        + 'Where you are, it is ' + formatInstant(event.startsAt, readerZone()) + '.'),
      el('p', { class: 'form-note' },
        [
          event.locationUrl ? 'At ' + event.locationUrl : null,
          event.voiceChannelId ? 'In a voice room' : null,
          event.capacity ? 'Up to ' + event.capacity + ' people' : null,
        ].filter(Boolean).join(' · ') || 'No location was given.'),
    );
  };

  const paintCounts = () => {
    const tally = attendanceCounts(attendance);
    counts.replaceChildren(facts([
      { value: String(tally.going), label: 'going' },
      { value: String(tally.maybe), label: 'maybe' },
      { value: String(tally.declined), label: 'not going' },
    ]));
  };

  const paintPeople = () => {
    const rows = attendanceRows(attendance);
    if (!rows.length) {
      people.replaceChildren(el('p', { class: 'form-note' },
        attendance && attendance.attendanceVisibility === 'organisers'
          ? 'The names are not shown for this event. The counts above are what everybody sees.'
          : 'Nobody has answered yet.'));
      return;
    }
    people.replaceChildren(...rows.map((entry) => row({
      lead: el('span', { class: 'role-dot' }, icon('user', { size: 15 })),
      title: entry.displayName || entry.username || 'A member',
      sub: RSVP_LABELS[entry.status] || entry.status,
      meta: relativeTime(entry.createdAt),
    })));
  };

  const paintRsvp = () => {
    if (!canPost) {
      rsvp.replaceChildren(el('p', { class: 'form-note' },
        'Answering an event needs the permission to post in this community.'));
      return;
    }
    rsvp.replaceChildren(el('div', { class: 'rowtools' },
      ...RSVP_STATUSES.map((status) => el('button', {
        class: 'btn btn--sm ' + (mine && mine.status === status ? 'btn--primary' : 'btn--ghost'),
        type: 'button',
        'aria-pressed': mine && mine.status === status ? 'true' : 'false',
        onClick: () => answer(status),
      }, RSVP_LABELS[status]))));
  };

  // An answer replaces the previous one: the server keeps one row per member
  // per event, so answering again changes the answer rather than adding to it.
  const answer = async (status) => {
    try {
      const sent = await Workspace.rsvpEvent(serverId, eventId, status);
      mine = sent;
      toast('You are ' + RSVP_LABELS[status].toLowerCase());
      paintRsvp();
      await loadAttendance();
    } catch (error) {
      errorToast(error);
    }
  };

  const loadAttendance = async () => {
    try {
      attendance = await Workspace.eventAttendance(serverId, eventId);
      const rows = attendanceRows(attendance);
      const own = rows.find((entry) => String(entry.userId) === String(me));
      if (own) mine = own;
      paintCounts();
      paintPeople();
      paintRsvp();
    } catch (error) {
      people.replaceChildren(fold([fault(error, loadAttendance)]));
    }
  };

  const load = async () => {
    head.replaceChildren(hold('Opening the event'));
    try {
      event = await Workspace.event(serverId, eventId);
      paintHead();
      paintRsvp();
      await loadAttendance();
    } catch (error) {
      head.replaceChildren(fold([fault(error, load)]));
    }
  };

  return {
    node,
    onMount: load,
    cleanup() {},
  };
}

// -- the editor -------------------------------------------------------------------

// An event, made or changed.
//
// The start and the end are written in one timezone, and the instants are
// derived from it, so the event means the same moment to everybody.
function openEventEditor(serverId, event, onDone) {
  const title = el('input', { class: 'input', type: 'text', maxlength: '255', 'aria-label': 'The title of the event' });
  title.value = event ? event.title : '';
  const description = el('textarea', {
    class: 'input', rows: '3', maxlength: '10000', 'aria-label': 'What happens at the event',
  });
  description.value = event ? event.description : '';
  const starts = el('input', { class: 'input', type: 'datetime-local', 'aria-label': 'When the event starts' });
  const ends = el('input', { class: 'input', type: 'datetime-local', 'aria-label': 'When the event ends' });
  const zone = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The timezone the times are written in',
  });
  const location = el('input', {
    class: 'input', type: 'url', 'aria-label': 'Where the event is', placeholder: 'https://example.org/room',
  });
  const capacity = el('input', { class: 'input', type: 'number', min: '1', 'aria-label': 'How many people may come' });
  const visibility = el('select', { class: 'select', 'aria-label': 'Who may see who is coming' },
    ...Object.keys(ATTENDANCE_VISIBILITY_LABELS).map((value) => el('option', {
      value,
      selected: event ? event.attendanceVisibility === value : value === 'members',
    }, ATTENDANCE_VISIBILITY_LABELS[value])));
  const error = el('p', { class: 'form-error', hidden: true });

  zone.value = event ? (event.timezone || readerZone()) : readerZone();
  if (event) {
    starts.value = toZoneInput(event.startsAt, event.timezone);
    ends.value = toZoneInput(event.endsAt, event.timezone);
    if (event.locationUrl) location.value = event.locationUrl;
    if (event.capacity) capacity.value = String(event.capacity);
  }

  const dialog = openDialog({
    title: event ? 'Edit ' + event.title : 'New event',
    wide: true,
    body: el('form', {
      class: 'fold',
      onSubmit: async (submit) => {
        submit.preventDefault();
        error.hidden = true;
        if (!title.value.trim()) { error.hidden = false; error.textContent = 'Give the event a title.'; return; }
        if (!starts.value || !ends.value) {
          error.hidden = false;
          error.textContent = 'An event needs a start and an end.';
          return;
        }
        const body = {
          title: title.value.trim(),
          description: description.value,
          timezone: zone.value.trim() || readerZone(),
          startsAt: instantInZone(starts.value, zone.value.trim() || readerZone()),
          endsAt: instantInZone(ends.value, zone.value.trim() || readerZone()),
          locationUrl: location.value.trim() || null,
          capacity: capacity.value.trim() ? Number(capacity.value) : null,
          attendanceVisibility: visibility.value,
        };
        try {
          if (event) await Workspace.updateEvent(serverId, event.id, body);
          else await Workspace.createEvent(serverId, body);
          toast(event ? 'The event is saved' : 'The event is made');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The event could not be saved.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Title'), title),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Description'), description),
    el('div', { class: 'pageblock-row' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Starts'), starts),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Ends'), ends)),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Timezone'), zone),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Location'), location),
    el('div', { class: 'pageblock-row' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Capacity'), capacity),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Attendance'), visibility)),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, event ? 'Save' : 'Create')),
  });
  title.focus();
}

export default { eventsList, eventsDetail };
