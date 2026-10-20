// The collaboration workspace's shared rules.
//
// A community holds five things: spaces, documents, boards, events and polls.
// Two modules draw them - three columns on a desk, one screen at a time on a
// phone - and the two are different interfaces rather than one interface at two
// widths. What they share is not the drawing but the rules: where the
// workspace lives on the server, what the things in it are called, which
// permission each write needs, and how a moment, a ballot and an answer are
// read.
//
// The package holds no element and builds no view. A shared platform that drew
// would be one module's furniture standing in the other module's house.
//
// The API calls are here rather than in the shared client because the client is
// not mine to change; they are made through the same request helper the page
// editor uses, so authorisation, error shape and timeouts are decided in one
// place exactly as they are for every other call the platform makes.

import { request } from './api.js';
import { can, isOwner } from './store.js';
import { formatDateTime } from './locale.js';

// -- the addresses -------------------------------------------------------------
//
// The workspace lives under the community it belongs to, and every surface has
// its own address. A surface that had no address of its own would be a place a
// reader could not link to and a phone could not open.

export function workspaceRoute(serverId) {
  return '/server/' + encodeURIComponent(serverId) + '/workspace';
}

export function surfaceRoute(serverId, surfaceId) {
  return workspaceRoute(serverId) + '/' + surfaceId;
}

export function spaceRoute(serverId, spaceId) {
  return surfaceRoute(serverId, 'space') + '/' + encodeURIComponent(spaceId);
}

export function documentRoute(serverId, documentId) {
  return surfaceRoute(serverId, 'document') + '/' + encodeURIComponent(documentId);
}

export function boardRoute(serverId, boardId) {
  return surfaceRoute(serverId, 'board') + '/' + encodeURIComponent(boardId);
}

export function cardRoute(serverId, boardId, cardId) {
  return boardRoute(serverId, boardId) + '/card/' + encodeURIComponent(cardId);
}

export function eventRoute(serverId, eventId) {
  return surfaceRoute(serverId, 'event') + '/' + encodeURIComponent(eventId);
}

export function pollRoute(serverId, pollId) {
  return surfaceRoute(serverId, 'poll') + '/' + encodeURIComponent(pollId);
}

// -- the five surfaces ---------------------------------------------------------

export const SURFACES = [
  {
    id: 'spaces',
    label: 'Spaces',
    icon: 'layers',
    blurb: 'Groups of references that narrow what a member may see.',
  },
  {
    id: 'documents',
    label: 'Documents',
    icon: 'file',
    blurb: 'Community pages with a revision, a history and comments.',
  },
  {
    id: 'boards',
    label: 'Boards',
    icon: 'grid',
    blurb: 'Lanes and cards, and the record of who changed what.',
  },
  {
    id: 'events',
    label: 'Events',
    icon: 'calendar',
    blurb: 'Something the community does at a time.',
  },
  {
    id: 'polls',
    label: 'Polls',
    icon: 'chart',
    blurb: 'A question put to the community, and the answer it recorded.',
  },
];

export function surfaceById(id) {
  return SURFACES.find((surface) => surface.id === id) || null;
}

// -- the vocabulary ------------------------------------------------------------
//
// The server is the authority on what these are called; the names here are the
// ones it uses, so a reader is not shown one word for a thing and another word
// for the same thing elsewhere.

export const SPACE_ITEM_KINDS = ['channel', 'document', 'board', 'resource'];
export const SPACE_ITEM_LABELS = {
  channel: 'Channel',
  document: 'Document',
  board: 'Board',
  resource: 'Link',
};

export const CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const PRIORITY_LABELS = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const CARD_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
export const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const CARD_LINK_KINDS = ['channel', 'document', 'discussion', 'event', 'message'];
export const CARD_LINK_LABELS = {
  channel: 'Channel',
  document: 'Document',
  discussion: 'Discussion',
  event: 'Event',
  message: 'Message',
};

export const RSVP_STATUSES = ['going', 'maybe', 'declined'];
export const RSVP_LABELS = {
  going: 'Going',
  maybe: 'Maybe',
  declined: 'Not going',
};

export const ATTENDANCE_VISIBILITIES = ['members', 'organisers'];
export const ATTENDANCE_VISIBILITY_LABELS = {
  members: 'Every member may see who is coming',
  organisers: 'Only the organisers may see who is coming',
};

export const POLL_SCORINGS = ['plurality', 'ranked'];
export const POLL_SCORING_LABELS = {
  plurality: 'Most votes wins',
  ranked: 'Ranked: the first choice is worth the most',
};

export const POLL_ELIGIBILITIES = ['members', 'role'];
export const POLL_ELIGIBILITY_LABELS = {
  members: 'Every member may vote',
  role: 'Only the members holding a role may vote',
};

// The blocks a document body is made of. The same eleven the page editor
// writes, because the server accepts the same eleven and nothing else.
export const BLOCK_LABELS = {
  heading: 'Heading',
  lead: 'Description',
  paragraph: 'Paragraph',
  list: 'List',
  note: 'Note',
  link: 'Link',
  rule: 'Rule',
  image: 'Image',
  quote: 'Quotation',
  code: 'Code',
  table: 'Table',
};

// -- the permissions -----------------------------------------------------------
//
// The client asks the permission system so it does not offer what the server
// would refuse. The server refuses regardless: these are what the interface
// offers, not what the server allows.
//
//   MANAGE_CHANNELS  spaces, boards and events - the structure of the community
//   MEMORIZE        writing a document
//   SEND_MESSAGES   a card, an RSVP, a comment, a vote
//   MANAGE_MESSAGES acting on somebody else's card or comment

export function mayManageStructure(serverId) {
  return can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
}

export function mayWriteDocuments(serverId) {
  return can(serverId, 'MEMORIZE') || isOwner(serverId);
}

export function mayPost(serverId) {
  return can(serverId, 'SEND_MESSAGES') || isOwner(serverId);
}

export function mayModerate(serverId) {
  return can(serverId, 'MANAGE_MESSAGES') || isOwner(serverId);
}

// Whether the reader may act on something somebody else wrote. The author
// always may; a moderator may act on anybody's.
export function mayActOn(serverId, authorId, readerId) {
  if (authorId && readerId && String(authorId) === String(readerId)) return true;
  return mayModerate(serverId);
}

// -- reading a moment ----------------------------------------------------------

// The same instant, written in a named zone. The zone an event was written in
// is what its author meant; the reader's own zone is where they will turn up.
export function formatInstant(value, timeZone) {
  if (!value) return '';
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  if (timeZone) options.timeZone = timeZone;
  return formatDateTime(value, options);
}

// The reader's own zone, as the runtime names it.
export function readerZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// The parts of an instant, as a named zone reads them.
function zoneParts(date, timeZone) {
  const options = {
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  };
  if (timeZone) options.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  // Some builds of the runtime write midnight as the twenty-fourth hour.
  if (out.hour === '24') out.hour = '00';
  return out;
}

// The wall-clock time of an instant in a named zone, in the form a date field
// takes. The zone is the one the moment was written in, so the field shows the
// time somebody actually wrote rather than the time it happens to be here.
export function toZoneInput(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = zoneParts(date, timeZone);
  return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
}

// The instant a wall-clock time in a named zone means.
//
// A due date is a moment everybody agrees on, so the time somebody typed is
// read in the zone they wrote it in rather than in the zone the browser
// happens to be in.
export function instantInZone(value, timeZone) {
  const text = String(value || '').trim();
  if (!text) return null;
  const asUtc = new Date(text.length === 16 ? text + ':00' : text);
  if (Number.isNaN(asUtc.getTime())) return null;
  const zone = timeZone || 'UTC';
  const offset = (at) => {
    const parts = zoneParts(at, zone);
    const wall = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    return wall - at.getTime();
  };
  const first = offset(asUtc);
  let stamp = new Date(asUtc.getTime() - first);
  const second = offset(stamp);
  if (second !== first) stamp = new Date(asUtc.getTime() - second);
  return stamp.toISOString();
}

// -- an event's attendance -----------------------------------------------------

// The counts, whatever the names are withheld. The counts are public even when
// the names are not: a member learns that twenty people are coming without
// learning who they are.
export function attendanceCounts(attendance) {
  const counts = (attendance && attendance.counts) || {};
  return {
    going: Number(counts.going || 0),
    maybe: Number(counts.maybe || 0),
    declined: Number(counts.declined || 0),
  };
}

// The attendance list, one line per member.
//
// A member has one answer to an event: a second RSVP replaces the first rather
// than adding to it. The list is read as one line per member so a reader never
// sees themselves twice, whichever way the server ordered the rows.
export function attendanceRows(attendance) {
  const rows = attendance && Array.isArray(attendance.attendees) ? attendance.attendees : [];
  const byMember = new Map();
  for (const row of rows) {
    if (!row || row.userId === undefined || row.userId === null) continue;
    const key = String(row.userId);
    const seen = byMember.get(key);
    if (!seen || answeredLater(row, seen)) byMember.set(key, row);
  }
  return Array.from(byMember.values());
}

// Which of two answers for the same member is the later one.
function answeredLater(a, b) {
  const left = Date.parse(a.updatedAt || a.createdAt || '') || 0;
  const right = Date.parse(b.updatedAt || b.createdAt || '') || 0;
  return left > right;
}

// -- a poll's scoring ----------------------------------------------------------

// The points a ballot at a position is worth, the way a ranked poll is scored:
// the first choice of a ballot is worth the number of options, the second one
// fewer, and the last one a point. A ballot that does not rank an option scores
// nothing for it.
export function bordaPoints(rank, optionCount) {
  const position = Number(rank);
  const total = Number(optionCount);
  if (!Number.isInteger(position) || position < 1) return 0;
  if (!Number.isInteger(total) || total < 1) return 0;
  if (position > total) return 0;
  return total - position + 1;
}

// The order two options stand in when their scores are level: the one with more
// first preferences, then more second preferences, and so on down the ballot.
// The last step - the order the options were given in - is the server's, so it
// is not repeated here: this decides what is left to the server.
export function preferByPosition(a, b) {
  const left = a || [];
  const right = b || [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const mine = Number(left[index] || 0);
    const theirs = Number(right[index] || 0);
    if (mine !== theirs) return theirs - mine;
  }
  return 0;
}

// -- the API --------------------------------------------------------------------
//
// The workspace answers under the community it belongs to. These are the calls
// the two modules make, made through the shared request helper so that a
// refusal arrives as the same error envelope every other refusal arrives as.

const root = (serverId) => '/api/servers/' + encodeURIComponent(serverId);

export const Workspace = {
  // Spaces.
  spaces: (serverId) => request('GET', root(serverId) + '/spaces'),
  space: (serverId, spaceId) => request('GET', root(serverId) + '/spaces/' + encodeURIComponent(spaceId)),
  createSpace: (serverId, body) => request('POST', root(serverId) + '/spaces', { body }),
  updateSpace: (serverId, spaceId, body) =>
    request('PATCH', root(serverId) + '/spaces/' + encodeURIComponent(spaceId), { body }),
  deleteSpace: (serverId, spaceId) =>
    request('DELETE', root(serverId) + '/spaces/' + encodeURIComponent(spaceId)),
  addSpaceItem: (serverId, spaceId, body) =>
    request('POST', root(serverId) + '/spaces/' + encodeURIComponent(spaceId) + '/items', { body }),
  removeSpaceItem: (serverId, spaceId, itemId) =>
    request('DELETE', root(serverId) + '/spaces/' + encodeURIComponent(spaceId)
      + '/items/' + encodeURIComponent(itemId)),
  reorderSpaceItems: (serverId, spaceId, orderedIds) =>
    request('POST', root(serverId) + '/spaces/' + encodeURIComponent(spaceId) + '/reorder',
      { body: { orderedIds } }),

  // Documents.
  documents: (serverId, options) => {
    const opts = options || {};
    const query = new URLSearchParams();
    if (opts.limit) query.set('limit', String(opts.limit));
    if (opts.offset) query.set('offset', String(opts.offset));
    const qs = query.toString();
    return request('GET', root(serverId) + '/documents' + (qs ? '?' + qs : ''));
  },
  searchDocuments: (serverId, q, limit) => {
    const query = new URLSearchParams({ q: String(q || '') });
    if (limit) query.set('limit', String(limit));
    return request('GET', root(serverId) + '/documents/search?' + query.toString());
  },
  document: (serverId, documentId) =>
    request('GET', root(serverId) + '/documents/' + encodeURIComponent(documentId)),
  createDocument: (serverId, body) => request('POST', root(serverId) + '/documents', { body }),
  saveDocument: (serverId, documentId, body) =>
    request('PUT', root(serverId) + '/documents/' + encodeURIComponent(documentId), { body }),
  documentRevisions: (serverId, documentId, limit) =>
    request('GET', root(serverId) + '/documents/' + encodeURIComponent(documentId) + '/revisions'
      + (limit ? '?limit=' + encodeURIComponent(String(limit)) : '')),
  documentRevision: (serverId, documentId, revision) =>
    request('GET', root(serverId) + '/documents/' + encodeURIComponent(documentId)
      + '/revisions/' + encodeURIComponent(String(revision))),
  compareDocument: (serverId, documentId, from, to) =>
    request('GET', root(serverId) + '/documents/' + encodeURIComponent(documentId) + '/compare'
      + '?from=' + encodeURIComponent(String(from)) + '&to=' + encodeURIComponent(String(to))),
  restoreDocument: (serverId, documentId, revision) =>
    request('POST', root(serverId) + '/documents/' + encodeURIComponent(documentId) + '/restore',
      { body: { revision } }),
  documentComments: (serverId, documentId) =>
    request('GET', root(serverId) + '/documents/' + encodeURIComponent(documentId) + '/comments'),
  addDocumentComment: (serverId, documentId, body) =>
    request('POST', root(serverId) + '/documents/' + encodeURIComponent(documentId) + '/comments', { body }),
  resolveDocumentComment: (serverId, documentId, commentId, resolved) =>
    request('POST', root(serverId) + '/documents/' + encodeURIComponent(documentId)
      + '/comments/' + encodeURIComponent(commentId) + '/resolve', { body: { resolved } }),
  documentLinks: (serverId, documentId) =>
    request('GET', root(serverId) + '/documents/' + encodeURIComponent(documentId) + '/links'),
  addDocumentLink: (serverId, documentId, body) =>
    request('POST', root(serverId) + '/documents/' + encodeURIComponent(documentId) + '/links', { body }),

  // Boards.
  boards: (serverId) => request('GET', root(serverId) + '/boards'),
  board: (serverId, boardId) => request('GET', root(serverId) + '/boards/' + encodeURIComponent(boardId)),
  createBoard: (serverId, body) => request('POST', root(serverId) + '/boards', { body }),
  createBoardColumn: (serverId, boardId, body) =>
    request('POST', root(serverId) + '/boards/' + encodeURIComponent(boardId) + '/columns', { body }),
  createBoardMilestone: (serverId, boardId, body) =>
    request('POST', root(serverId) + '/boards/' + encodeURIComponent(boardId) + '/milestones', { body }),
  card: (serverId, boardId, cardId) =>
    request('GET', root(serverId) + '/boards/' + encodeURIComponent(boardId)
      + '/cards/' + encodeURIComponent(cardId)),
  cardActivity: (serverId, boardId, cardId) =>
    request('GET', root(serverId) + '/boards/' + encodeURIComponent(boardId)
      + '/cards/' + encodeURIComponent(cardId) + '/activity'),
  createCard: (serverId, boardId, body) =>
    request('POST', root(serverId) + '/boards/' + encodeURIComponent(boardId) + '/cards', { body }),
  cardFromMessage: (serverId, boardId, body) =>
    request('POST', root(serverId) + '/boards/' + encodeURIComponent(boardId) + '/cards/from-message',
      { body }),
  updateCard: (serverId, boardId, cardId, body) =>
    request('PATCH', root(serverId) + '/boards/' + encodeURIComponent(boardId)
      + '/cards/' + encodeURIComponent(cardId), { body }),
  moveCard: (serverId, boardId, cardId, body) =>
    request('POST', root(serverId) + '/boards/' + encodeURIComponent(boardId)
      + '/cards/' + encodeURIComponent(cardId) + '/move', { body }),
  addCardLink: (serverId, boardId, cardId, body) =>
    request('POST', root(serverId) + '/boards/' + encodeURIComponent(boardId)
      + '/cards/' + encodeURIComponent(cardId) + '/links', { body }),
  attachCardMilestone: (serverId, boardId, cardId, milestoneId) =>
    request('POST', root(serverId) + '/boards/' + encodeURIComponent(boardId)
      + '/cards/' + encodeURIComponent(cardId) + '/milestones', { body: { milestoneId } }),

  // Events.
  events: (serverId) => request('GET', root(serverId) + '/events'),
  event: (serverId, eventId) => request('GET', root(serverId) + '/events/' + encodeURIComponent(eventId)),
  createEvent: (serverId, body) => request('POST', root(serverId) + '/events', { body }),
  updateEvent: (serverId, eventId, body) =>
    request('PATCH', root(serverId) + '/events/' + encodeURIComponent(eventId), { body }),
  rsvpEvent: (serverId, eventId, status) =>
    request('POST', root(serverId) + '/events/' + encodeURIComponent(eventId) + '/rsvp', { body: { status } }),
  eventAttendance: (serverId, eventId) =>
    request('GET', root(serverId) + '/events/' + encodeURIComponent(eventId) + '/attendance'),

  // Polls.
  polls: (serverId) => request('GET', root(serverId) + '/polls'),
  poll: (serverId, pollId) => request('GET', root(serverId) + '/polls/' + encodeURIComponent(pollId)),
  createPoll: (serverId, body) => request('POST', root(serverId) + '/polls', { body }),
  votePoll: (serverId, pollId, choices) =>
    request('POST', root(serverId) + '/polls/' + encodeURIComponent(pollId) + '/vote', { body: { choices } }),
  pollResults: (serverId, pollId, recount) =>
    request('GET', root(serverId) + '/polls/' + encodeURIComponent(pollId) + '/results'
      + (recount ? '?recount=1' : '')),
  closePoll: (serverId, pollId) =>
    request('POST', root(serverId) + '/polls/' + encodeURIComponent(pollId) + '/close'),
};

export default {
  Workspace, SURFACES, surfaceById,
  workspaceRoute, surfaceRoute, spaceRoute, documentRoute, boardRoute, cardRoute,
  eventRoute, pollRoute,
  mayManageStructure, mayWriteDocuments, mayPost, mayModerate, mayActOn,
  formatInstant, readerZone, toZoneInput, instantInZone,
  attendanceCounts, attendanceRows,
  bordaPoints, preferByPosition,
};
