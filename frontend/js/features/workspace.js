// The collaboration workspace, on a desk.
//
// Three columns: the doors on the left - the five things a community can hold -
// the list of what is in the chosen thing in the middle, and the thing itself
// on the right. The address holds the whole state: which surface is open and,
// inside it, which item. A workspace can therefore be linked to, and it comes
// back the way it was left.
//
// Each surface is a module of its own behind this switchboard, and each draws
// two things: the list that belongs in the middle column and the open thing
// that belongs in the right one. The server is the authority on what may be
// written and by whom; every module asks the permission system before it draws
// a control, so the desk does not offer what the server would refuse.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { card, fold, row } from '../ui/page.js';
import { path } from '../../packages/nav.js';
import {
  SURFACES, Workspace, surfaceRoute, mayManageStructure, mayModerate,
  mayPost, mayWriteDocuments,
} from '../../packages/workspace.js';
import { spacesList, spacesDetail } from './workspace/spaces.js';
import { documentsList, documentsDetail } from './workspace/documents.js';
import { boardsList, boardsDetail } from './workspace/boards.js';
import { eventsList, eventsDetail } from './workspace/events.js';
import { pollsList, pollsDetail } from './workspace/polls.js';

// The surface each address belongs to. The landing is its own thing: it is
// what the workspace opens on, and it shows what the community holds rather
// than one surface of it.
const SURFACE_OF_PAGE = {
  'community.workspace.spaces': 'spaces',
  'community.workspace.space': 'spaces',
  'community.workspace.documents': 'documents',
  'community.workspace.document': 'documents',
  'community.workspace.boards': 'boards',
  'community.workspace.board': 'boards',
  'community.workspace.card': 'boards',
  'community.workspace.events': 'events',
  'community.workspace.event': 'events',
  'community.workspace.polls': 'polls',
  'community.workspace.poll': 'polls',
};

const VIEWS = {
  spaces: { list: spacesList, detail: spacesDetail },
  documents: { list: documentsList, detail: documentsDetail },
  boards: { list: boardsList, detail: boardsDetail },
  events: { list: eventsList, detail: eventsDetail },
  polls: { list: pollsList, detail: pollsDetail },
};

// The doors: the five surfaces, with the one that is open marked. The door is
// the whole navigation of the workspace, so it is the same in every column and
// on every surface.
function workspaceRail(serverId, active) {
  const rail = el('nav', { class: 'studionav', 'aria-label': 'Workspace sections' });
  rail.appendChild(el('p', { class: 'studionav-group' }, 'Workspace'));
  for (const surface of SURFACES) {
    rail.appendChild(el('a', {
      class: 'studionav-link' + (surface.id === active ? ' studionav-link--active' : ''),
      href: path(surfaceRoute(serverId, surface.id)),
      'aria-current': surface.id === active ? 'page' : null,
    },
    icon(surface.icon, { size: 16 }),
    el('span', { class: 'studionav-label' }, surface.label)));
  }
  return rail;
}

// The permission each write needs, and what it buys. The names are the
// community's own, so a reader who has been told a permission by somebody else
// finds the same word here.
const GATES = [
  { permission: 'MANAGE_CHANNELS', what: 'manage the spaces, the boards and the events' },
  { permission: 'MEMORIZE', what: 'write a document' },
  { permission: 'SEND_MESSAGES', what: 'post a card, an RSVP, a comment and a vote' },
  { permission: 'MANAGE_MESSAGES', what: 'act on somebody else’s card or comment' },
];

// The landing: what this community holds, and what the reader may do here.
//
// The counts are asked of the server, one surface at a time, and a surface that
// cannot be read shows a dash rather than sinking the page: the reader is still
// somewhere, and the rest of the workspace is still true.
function workspaceLanding(ctx) {
  const serverId = ctx.serverId;
  const counts = el('div', { class: 'rowlist' });
  const held = el('div', { class: 'fold fold--tight' });

  const list = card({ label: 'In this community', glyph: 'layers', body: counts, flush: true });
  const detail = card({
    label: 'What you may do here',
    glyph: 'shield',
    body: fold([
      el('p', { class: 'form-note' },
        'What you can change in this workspace comes from your role in this community. '
        + 'The server refuses anything your role does not allow, so this is what the '
        + 'interface offers you rather than a promise about what would work.'),
      held,
    ]),
  });

  const paintGates = () => {
    held.replaceChildren(...GATES.map((gate) => {
      const allowed = gate.permission === 'MANAGE_CHANNELS'
        ? mayManageStructure(serverId)
        : gate.permission === 'MEMORIZE'
          ? mayWriteDocuments(serverId)
          : gate.permission === 'SEND_MESSAGES'
            ? mayPost(serverId)
            : mayModerate(serverId);
      return el('p', { class: 'form-note' },
        el('span', { class: 'mono' }, gate.permission),
        ' — ' + gate.what + ' — ',
        el('span', { class: allowed ? 'text-success' : 'muted' },
          allowed ? 'you hold this' : 'you do not hold this'));
    }));
  };

  const paintCounts = (tally) => {
    counts.replaceChildren(...SURFACES.map((surface) => row({
      lead: el('span', { class: 'role-dot' }, icon(surface.icon, { size: 15 })),
      title: surface.label,
      sub: surface.blurb,
      meta: String(tally.get(surface.id)),
      href: path(surfaceRoute(serverId, surface.id)),
      link: true,
    })));
  };

  return {
    list: {
      node: list,
      onMount: async () => {
        const answers = await Promise.all(SURFACES.map((surface) => (
          countOf(serverId, surface.id).catch(() => null)
        )));
        const tally = new Map();
        SURFACES.forEach((surface, index) => {
          const answer = answers[index];
          tally.set(surface.id, answer === null ? '—' : String(answer));
        });
        paintCounts(tally);
      },
      cleanup() {},
    },
    detail: {
      node: detail,
      onMount: async () => { paintGates(); },
      cleanup() {},
    },
  };
}

// How much of one surface the community holds. The five lists are the only
// honest way to know: the server does not keep a count of its own for a
// surface, and a count the client guessed would be a number nobody can check.
function countOf(serverId, surface) {
  switch (surface) {
    case 'spaces': return Workspace.spaces(serverId).then((rows) => (rows || []).length);
    case 'documents': return Workspace.documents(serverId).then((rows) => (rows || []).length);
    case 'boards': return Workspace.boards(serverId).then((rows) => (rows || []).length);
    case 'events': return Workspace.events(serverId).then((rows) => (rows || []).length);
    case 'polls': return Workspace.polls(serverId).then((rows) => (rows || []).length);
    default: return Promise.resolve(0);
  }
}

// The workspace, as three columns.
export function renderWorkspace(ctx) {
  const serverId = ctx.serverId;
  const landing = ctx.page.id === 'community.workspace';
  const surface = SURFACE_OF_PAGE[ctx.page.id] || 'spaces';

  // The landing is a surface of its own: it says what the community holds
  // beside what the reader may do with it.
  const parts = landing
    ? workspaceLanding(ctx)
    : { list: VIEWS[surface].list(ctx), detail: VIEWS[surface].detail(ctx) };

  const middle = el('div', { class: 'collection-list' }, parts.list.node);
  const right = el('div', { class: 'collection-detail' }, parts.detail.node);

  const node = el('div', { class: 'studio' },
    workspaceRail(serverId, landing ? null : surface),
    el('div', { class: 'studio-stage' },
      el('div', { class: 'collection-layout' }, middle, right)));

  return {
    node,
    onMount: async () => {
      await parts.list.onMount();
      await parts.detail.onMount();
    },
    cleanup() {
      if (parts.list.cleanup) parts.list.cleanup();
      if (parts.detail.cleanup) parts.detail.cleanup();
    },
  };
}

export default { renderWorkspace };
