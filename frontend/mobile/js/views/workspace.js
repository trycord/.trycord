// The collaboration workspace, on a phone.
//
// The desk is three columns: the doors, the list, and the thing itself. A
// phone has room for one of those at a time, so it shows one screen and says
// where the others are. The surfaces are reached from a strip at the top of a
// list; the open thing is a screen of its own, and the phone's back gesture
// returns to the list it came from.
//
// The addresses are the platform's, not the phone's: the same /server/:id/... 
// route answers on the desk and on the phone, and the two draw it differently.
//
// Writing a document on a phone is a plain list of blocks rather than the
// desk's full editor: the same blocks, the same shapes and the same server,
// with fewer controls to reach for one-handed. The seven the phone offers are
// the ones somebody writes with.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { Workspace, SURFACES, surfaceRoute, spaceRoute, documentRoute, boardRoute, cardRoute, eventRoute, pollRoute } from '../../../packages/workspace.js';
import { State, channelsOf, refreshServerTree } from '../../../packages/store.js';
import { path, navigate } from '../../../packages/nav.js';
import { empty, loading, failure, iconButton } from '../components.js';
import { screen, section, heading, actions, field, textInput, textArea, select, notice, primaryButton, ghostButton } from './util.js';
import { sheet, menu, confirm, toast } from '../ui.js';
import { relativeTime } from '../../../packages/format.js';
import {
  RSVP_STATUSES, RSVP_LABELS, ATTENDANCE_VISIBILITY_LABELS,
  PRIORITY_LABELS, STATUS_LABELS, POLL_SCORING_LABELS,
  mayManageStructure, mayWriteDocuments, mayPost, mayActOn, paramId,
  formatInstant, readerZone, attendanceCounts, attendanceRows, bordaPoints,
  instantInZone,
} from '../../../packages/workspace.js';

// The strip that moves between the surfaces. It is the phone's answer to the
// desk's rail: the same five surfaces, in the same order.
function surfaceStrip(serverId, active) {
  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Workspace surfaces' });
  for (const surface of SURFACES) {
    strip.appendChild(el('a', {
      class: 'm-seg__item' + (surface.id === active ? ' is-active' : ''),
      href: path(surfaceRoute(serverId, surface.id)),
      role: 'tab',
      'aria-selected': surface.id === active ? 'true' : 'false',
    }, surface.label));
  }
  return strip;
}

// -- the landing ------------------------------------------------------------------

export function renderWorkspace(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Reading the workspace'));
    try {
      const answers = await Promise.all([
        Workspace.spaces(serverId), Workspace.documents(serverId), Workspace.boards(serverId),
        Workspace.events(serverId), Workspace.polls(serverId),
      ]);
      const counts = new Map(SURFACES.map((surface, index) => [
        surface.id,
        (answers[index] || []).length,
      ]));
      const rows = el('div', { class: 'm-list' });
      for (const surface of SURFACES) {
        rows.appendChild(el('a', {
          class: 'm-row',
          href: path(surfaceRoute(serverId, surface.id)),
        },
        el('span', { class: 'm-row__lead' }, icon(surface.icon, { size: 20 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, surface.label),
          el('span', { class: 'm-row__sub' }, surface.blurb)),
        el('span', { class: 'm-row__meta' }, String(counts.get(surface.id)))));
      }
      host.replaceChildren(
        el('div', { class: 'm-hero m-hero--quiet' },
          el('div', { class: 'm-hero__eyebrow' }, 'Workspace'),
          el('div', { class: 'm-hero__title' }, 'What this community holds'),
          el('div', { class: 'm-hero__sub' }, 'Spaces, documents, boards, events and polls.')),
        section('The surfaces', rows));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Workspace' },
    node,
    onMount: load,
  };
}

// -- the spaces -----------------------------------------------------------------------

export function renderSpaces(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Reading the spaces'));
    try {
      const spaces = await Workspace.spaces(serverId);
      const rows = el('div', { class: 'm-list' });
      if (!spaces.length) {
        rows.appendChild(empty({
          icon: 'layers',
          title: 'No spaces yet',
          text: 'A space gathers references and narrows what its members may see.',
        }));
      }
      for (const space of spaces) {
        rows.appendChild(el('a', {
          class: 'm-row',
          href: path(spaceRoute(serverId, space.id)),
        },
        el('span', { class: 'm-row__lead' }, icon('layers', { size: 20 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, space.name),
          el('span', { class: 'm-row__sub' },
            (space.items || []).length + ' references'
            + (space.isPrivate ? ' · private' : ''))),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
      host.replaceChildren(
        surfaceStrip(serverId, 'spaces'),
        section('Spaces', rows, {
          action: mayManageStructure(serverId)
            ? iconButton('plus', 'New space', () => openSpaceEditor(serverId, load))
            : null,
        }));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Spaces' },
    node,
    onMount: load,
  };
}

export function renderSpace(ctx) {
  const serverId = ctx.serverId;
  const spaceId = paramId(ctx.params, 'space');
  const canManage = mayManageStructure(serverId);
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Opening the space'));
    try {
      const space = await Workspace.space(serverId, spaceId);
      const rows = el('div', { class: 'm-list' });
      for (const item of space.items || []) {
        const href = hrefForItem(serverId, item);
        const line = el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon(iconForItem(item), { size: 20 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, item.title || item.kind),
            el('span', { class: 'm-row__sub' }, item.kind)));
        if (href) {
          const link = el('a', { class: 'm-row', href: path(href) },
            el('span', { class: 'm-row__lead' }, icon(iconForItem(item), { size: 20 })),
            el('span', { class: 'm-row__body' },
              el('span', { class: 'm-row__title' }, item.title || item.kind),
              el('span', { class: 'm-row__sub' }, item.kind)),
            el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 })));
          rows.appendChild(link);
          continue;
        }
        rows.appendChild(line);
      }
      if (!rows.children.length) {
        rows.appendChild(empty({
          icon: 'list',
          title: 'Nothing referenced yet',
          text: 'Add a channel, a document or a board to point at.',
        }));
      }
      host.replaceChildren(
        heading(space.name, space.description || null),
        section('References', rows, {
          action: canManage
            ? iconButton('plus', 'Add a reference', () => openReferencePicker(serverId, spaceId, load))
            : null,
        }));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Space' },
    node,
    onMount: load,
  };
}

// -- the documents -----------------------------------------------------------------------

export function renderDocuments(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Reading the documents'));
    try {
      const documents = await Workspace.documents(serverId);
      const rows = el('div', { class: 'm-list' });
      if (!documents.length) {
        rows.appendChild(empty({
          icon: 'file',
          title: 'No documents yet',
          text: 'A document is a page the community writes together.',
        }));
      }
      for (const document of documents) {
        rows.appendChild(el('a', {
          class: 'm-row',
          href: path(documentRoute(serverId, document.id)),
        },
        el('span', { class: 'm-row__lead' }, icon('file', { size: 20 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, document.title),
          el('span', { class: 'm-row__sub' },
            'revision ' + document.revision + ' · ' + relativeTime(document.updatedAt))),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
      host.replaceChildren(
        surfaceStrip(serverId, 'documents'),
        section('Documents', rows, {
          action: mayWriteDocuments(serverId)
            ? iconButton('plus', 'New document', () => openNewDocument(serverId))
            : null,
        }));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Documents' },
    node,
    onMount: load,
  };
}

export function renderDocument(ctx) {
  const serverId = ctx.serverId;
  const documentId = paramId(ctx.params, 'document');
  const canWrite = mayWriteDocuments(serverId);
  const canComment = mayPost(serverId);

  let doc = null;
  let blocks = [];

  const host = el('div', { class: 'm-stack' });
  const node = screen(host);
  let editing = false;

  const paintRead = () => {
    const body = el('div', { class: 'm-stack' });
    for (const block of doc.body || []) body.appendChild(blockNode(block));
    if (!(doc.body || []).length) {
      body.appendChild(empty({
        icon: 'file',
        title: 'An empty document',
        text: canWrite ? 'Edit it to write the first block.' : 'Nobody has written it yet.',
      }));
    }
    return body;
  };

  // The blocks the phone writes. Seven of them: the ones somebody writes with
  // on a phone. A block the phone does not write is left exactly as it is, so
  // a document written on a desk and opened on a phone keeps the blocks the
  // desk wrote.
  const WRITTEN_ON_PHONE = ['paragraph', 'heading', 'list', 'quote', 'note', 'link', 'rule'];

  const paintEditor = () => {
    const body = el('div', { class: 'm-stack' });
    blocks.forEach((block, index) => {
      const written = WRITTEN_ON_PHONE.indexOf(block.type) !== -1;
      const tools = el('span', { class: 'm-row__trailing' },
        iconButton('trash', 'Remove this block', () => {
          blocks = blocks.filter((_, one) => one !== index);
          paint();
        }));
      const head = el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, blockTypeLabel(block.type)),
          written ? null : el('span', { class: 'm-row__sub' },
            'This block is not changed on the phone.')),
        tools);
      if (!written) {
        body.appendChild(el('div', { class: 'm-stack' },
          head,
          el('p', { class: 'm-section__note' }, blockText(block))));
        return;
      }
      if (block.type === 'list') {
        const items = el('textarea', {
          class: 'm-input m-input--area', rows: '3', 'aria-label': 'The items of the list',
        });
        items.value = (block.items || []).join('\n');
        items.addEventListener('input', () => {
          blocks[index] = Object.assign({}, blocks[index], {
            items: items.value.split('\n').map((item) => item.trim()),
          });
        });
        body.appendChild(el('div', { class: 'm-stack' }, head, items));
        return;
      }
      if (block.type === 'link') {
        const label = el('input', {
          class: 'm-input', type: 'text', 'aria-label': 'The text of the link',
        });
        label.value = block.text || '';
        label.addEventListener('input', () => {
          blocks[index] = Object.assign({}, blocks[index], { text: label.value });
        });
        const target = el('input', {
          class: 'm-input', type: 'text', 'aria-label': 'Where the link points',
          placeholder: 'https://example.org/handbook',
        });
        target.value = block.href || '';
        target.addEventListener('input', () => {
          blocks[index] = Object.assign({}, blocks[index], { href: target.value });
        });
        body.appendChild(el('div', { class: 'm-stack' }, head, label, target));
        return;
      }
      const field_ = el('textarea', {
        class: 'm-input m-input--area',
        rows: block.type === 'paragraph' ? '4' : '2',
        'aria-label': 'Block ' + (index + 1),
      });
      field_.value = block.text || '';
      field_.addEventListener('input', () => {
        blocks[index] = Object.assign({}, blocks[index], { text: field_.value });
      });
      body.appendChild(el('div', { class: 'm-stack' }, head, field_));
    });
    body.appendChild(actions([
      ghostButton('Add a block', () => openBlockMenu()),
    ]));
    return body;
  };

  const paint = () => {
    const head = el('div', { class: 'm-hero m-hero--quiet' },
      el('div', { class: 'm-hero__eyebrow' }, 'Revision ' + doc.revision),
      el('div', { class: 'm-hero__title' }, doc.title),
      el('div', { class: 'm-hero__sub' }, relativeTime(doc.updatedAt)));
    const tools = [];
    if (canWrite) {
      tools.push(el('button', {
        class: 'm-btn m-btn--primary m-btn--sm', type: 'button',
        onClick: () => (editing ? save() : startEditing()),
      }, editing ? 'Save' : 'Edit'));
    }
    host.replaceChildren(...[
      head,
      editing ? paintEditor() : paintRead(),
      tools.length ? actions(tools) : null,
      commentsSection(),
      linksSection(),
    ].filter(Boolean));
  };

  // -- the comments ---------------------------------------------------------------

  const commentsSection = () => {
    const holder = el('div', { class: 'm-list' });
    const sectionNode = section('Comments', holder);
    loadComments(holder);
    return sectionNode;
  };

  const loadComments = async (holder) => {
    try {
      const rows = await Workspace.documentComments(serverId, documentId);
      clear(holder);
      if (!rows.length) {
        holder.appendChild(el('p', { class: 'm-section__note' }, 'No comments yet.'));
      }
      for (const entry of rows) {
        holder.appendChild(el('div', { class: 'm-row m-row--member' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, entry.body),
            el('span', { class: 'm-row__sub' },
              relativeTime(entry.createdAt) + (entry.resolvedAt ? ' · resolved' : ''))),
          el('span', { class: 'm-row__trailing' },
            mayActOn(serverId, entry.authorId, State.user && State.user.id)
              ? iconButton('check', entry.resolvedAt ? 'Reopen this comment' : 'Resolve this comment', () => resolve(entry, holder))
              : null)));
      }
      if (canComment) {
        const field_ = el('textarea', {
          class: 'm-input m-input--area', rows: '2', 'aria-label': 'Your comment',
          placeholder: 'What is missing, or what is wrong?',
        });
        holder.appendChild(el('div', { class: 'm-stack' },
          field_,
          actions([primaryButton('Comment', () => comment(field_, holder))])));
      }
    } catch (error) {
      clear(holder);
      holder.appendChild(el('p', { class: 'm-form-error' }, (error && error.message) || 'The comments could not be read.'));
    }
  };

  const comment = async (field_, holder) => {
    const text = field_.value.trim();
    if (!text) return;
    try {
      await Workspace.addDocumentComment(serverId, documentId, { body: text });
      field_.value = '';
      toast('Comment added');
      await loadComments(holder);
    } catch (error) {
      toast((error && error.message) || 'The comment could not be added.', { type: 'error' });
    }
  };

  const resolve = async (entry, holder) => {
    try {
      await Workspace.resolveDocumentComment(serverId, documentId, entry.id, !entry.resolvedAt);
      await loadComments(holder);
    } catch (error) {
      toast((error && error.message) || 'The comment could not be resolved.', { type: 'error' });
    }
  };

  // -- the links -------------------------------------------------------------------

  const linksSection = () => {
    const holder = el('div', { class: 'm-list' });
    loadLinks(holder);
    return section('Links', holder);
  };

  const loadLinks = async (holder) => {
    try {
      const rows = await Workspace.documentLinks(serverId, documentId);
      clear(holder);
      if (!rows.length) {
        holder.appendChild(el('p', { class: 'm-section__note' }, 'No links yet.'));
      }
      for (const entry of rows) {
        const href = entry.kind === 'url' ? entry.url : documentRoute(serverId, entry.targetId);
        holder.appendChild(el('a', {
          class: 'm-row',
          href: path(href),
        },
        el('span', { class: 'm-row__lead' }, icon('link', { size: 20 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, entry.label || entry.url),
          el('span', { class: 'm-row__sub' }, entry.kind === 'url' ? entry.url : 'A document'))));
      }
    } catch (error) {
      clear(holder);
      holder.appendChild(el('p', { class: 'm-form-error' }, (error && error.message) || 'The links could not be read.'));
    }
  };

  // -- the editing -------------------------------------------------------------------

  const startEditing = () => {
    blocks = (doc.body || []).map((block) => Object.assign({}, block));
    editing = true;
    paint();
  };

  const save = async () => {
    try {
      const saved = await Workspace.saveDocument(serverId, documentId, {
        title: doc.title,
        body: blocks,
        revision: doc.revision,
      });
      doc = saved;
      editing = false;
      toast('Saved as revision ' + saved.revision);
      paint();
    } catch (error) {
      if (error && error.code === 'CONFLICT' && error.details) {
        // The document moved on while this one was being written. The work is
        // not thrown away and it is not written over the server's version.
        host.replaceChildren(
          notice({
            tone: 'warning',
            title: 'This document changed while you were writing it',
            text: 'The server holds revision ' + error.details.currentRevision
              + '. Your work has not been saved.',
            actions: actions([
              primaryButton('Read it again', () => load()),
              ghostButton('Keep my draft', () => { editing = true; paint(); }),
            ]),
          }));
        return;
      }
      toast((error && error.message) || 'The document could not be saved.', { type: 'error' });
    }
  };

  const openBlockMenu = () => {
    menu({
      title: 'Add a block',
      items: [
        { label: 'Paragraph', icon: 'file', onSelect: () => { blocks.push({ type: 'paragraph', text: '' }); paint(); } },
        { label: 'Heading', icon: 'edit', onSelect: () => { blocks.push({ type: 'heading', level: 2, text: '' }); paint(); } },
        { label: 'List', icon: 'list', onSelect: () => { blocks.push({ type: 'list', ordered: false, items: [''] }); paint(); } },
        { label: 'Quotation', icon: 'chat', onSelect: () => { blocks.push({ type: 'quote', text: '' }); paint(); } },
        { label: 'Note', icon: 'alert', onSelect: () => { blocks.push({ type: 'note', kind: 'info', text: '' }); paint(); } },
        { label: 'Link', icon: 'link', onSelect: () => { blocks.push({ type: 'link', text: '', href: '' }); paint(); } },
        { label: 'Rule', icon: 'slash', onSelect: () => { blocks.push({ type: 'rule' }); paint(); } },
      ],
    });
  };

  const load = async () => {
    host.replaceChildren(loading('Opening the document'));
    try {
      doc = await Workspace.document(serverId, documentId);
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Document' },
    node,
    onMount: load,
  };
}

// -- the boards -------------------------------------------------------------------------

export function renderBoards(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Reading the boards'));
    try {
      const boards = await Workspace.boards(serverId);
      const rows = el('div', { class: 'm-list' });
      if (!boards.length) {
        rows.appendChild(empty({
          icon: 'grid',
          title: 'No boards yet',
          text: 'A board holds lanes, and a lane holds the work.',
        }));
      }
      for (const board of boards) {
        rows.appendChild(el('a', {
          class: 'm-row',
          href: path(boardRoute(serverId, board.id)),
        },
        el('span', { class: 'm-row__lead' }, icon('grid', { size: 20 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, board.name),
          el('span', { class: 'm-row__sub' }, board.description || 'A board of cards')),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
      host.replaceChildren(
        surfaceStrip(serverId, 'boards'),
        section('Boards', rows));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Boards' },
    node,
    onMount: load,
  };
}

export function renderBoard(ctx) {
  const serverId = ctx.serverId;
  const boardId = paramId(ctx.params, 'board');
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Reading the board'));
    try {
      const board = await Workspace.board(serverId, boardId);
      const body = el('div', { class: 'm-stack' });
      for (const column of board.columns || []) {
        const cards = (board.cards || []).filter((entry) => String(entry.columnId) === String(column.id));
        const rows = el('div', { class: 'm-list' });
        if (!cards.length) {
          rows.appendChild(el('p', { class: 'm-section__note' }, 'Nothing filed here yet.'));
        }
        for (const card of cards) {
          rows.appendChild(el('a', {
            class: 'm-row',
            href: path(cardRoute(serverId, board.id, card.id)),
          },
          el('span', { class: 'm-row__lead' }, icon('file', { size: 20 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, card.title),
            el('span', { class: 'm-row__sub' },
              (PRIORITY_LABELS[card.priority] || card.priority)
              + (card.dueAt ? ' · due ' + relativeTime(card.dueAt) : ''))),
          el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
        }
        body.appendChild(section(column.name, rows, {
          note: cards.length + ' card' + (cards.length === 1 ? '' : 's'),
        }));
      }
      host.replaceChildren(
        heading(board.name, board.description || null),
        body);
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Board' },
    node,
    onMount: load,
  };
}

export function renderCard(ctx) {
  const serverId = ctx.serverId;
  const boardId = paramId(ctx.params, 'board');
  const cardId = paramId(ctx.params, 'card');
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Opening the card'));
    try {
      const card = await Workspace.card(serverId, boardId, cardId);
      const facts_ = el('div', { class: 'm-strip' },
        statCell(PRIORITY_LABELS[card.priority] || card.priority, 'priority'),
        statCell(STATUS_LABELS[card.status] || card.status, 'status'),
        statCell(card.dueAt ? relativeTime(card.dueAt) : '—', 'due'));
      const activity = el('div', { class: 'm-list' });
      for (const entry of card.activity || []) {
        activity.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, activityLine(entry)),
            el('span', { class: 'm-row__sub' }, relativeTime(entry.createdAt)))));
      }
      if (!(card.activity || []).length) {
        activity.appendChild(el('p', { class: 'm-section__note' }, 'Nothing has happened to this card yet.'));
      }
      host.replaceChildren(
        heading(card.title, 'Version ' + card.version + ' · ' + relativeTime(card.updatedAt)),
        card.body ? el('p', { class: 'm-lede' }, card.body) : null,
        facts_,
        section('Activity', activity));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Card' },
    node,
    onMount: load,
  };
}

// -- the events ---------------------------------------------------------------------------

export function renderEvents(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Reading the events'));
    try {
      const events = await Workspace.events(serverId);
      const rows = el('div', { class: 'm-list' });
      if (!events.length) {
        rows.appendChild(empty({
          icon: 'calendar',
          title: 'No events yet',
          text: 'An event is something the community does at a time.',
        }));
      }
      for (const event of events) {
        rows.appendChild(el('a', {
          class: 'm-row',
          href: path(eventRoute(serverId, event.id)),
        },
        el('span', { class: 'm-row__lead' }, icon('calendar', { size: 20 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, event.title),
          el('span', { class: 'm-row__sub' },
            (event.startsAtLocal || '') + (event.timezone ? ' · ' + event.timezone : ''))),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
      host.replaceChildren(
        surfaceStrip(serverId, 'events'),
        section('Events', rows, {
          action: mayManageStructure(serverId)
            ? iconButton('plus', 'New event', () => openEventEditor(serverId))
            : null,
        }));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Events' },
    node,
    onMount: load,
  };
}

export function renderEvent(ctx) {
  const serverId = ctx.serverId;
  const eventId = paramId(ctx.params, 'event');
  const canPost = mayPost(serverId);
  const me = State.user && State.user.id;

  let event = null;
  let attendance = null;
  let mine = null;

  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const paint = () => {
    const tally = attendanceCounts(attendance);
    const strip = el('div', { class: 'm-strip' },
      statCell(String(tally.going), 'going'),
      statCell(String(tally.maybe), 'maybe'),
      statCell(String(tally.declined), 'not going'));
    const people = el('div', { class: 'm-list' });
    const rows = attendanceRows(attendance);
    if (!rows.length) {
      people.appendChild(el('p', { class: 'm-section__note' },
        attendance && attendance.attendanceVisibility === 'organisers'
          ? 'The names are not shown for this event. The counts above are what everybody sees.'
          : 'Nobody has answered yet.'));
    }
    for (const entry of rows) {
      people.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, entry.displayName || entry.username || 'A member'),
          el('span', { class: 'm-row__sub' }, RSVP_LABELS[entry.status] || entry.status))));
    }
    const answers = canPost
      ? actions(RSVP_STATUSES.map((status) => el('button', {
        class: 'm-btn m-btn--sm ' + (mine && mine.status === status ? 'm-btn--primary' : 'm-btn--ghost'),
        type: 'button',
        onClick: () => answer(status),
      }, RSVP_LABELS[status])))
      : null;

    // A null child would be drawn as the word "null", so the parts that are not
    // there are left out rather than passed along.
    host.replaceChildren(...[
      heading(event.title, (event.startsAtLocal || '') + (event.timezone ? ' · ' + event.timezone : '')),
      event.description ? el('p', { class: 'm-lede' }, event.description) : null,
      el('p', { class: 'm-section__note' },
        'Where you are, it is ' + formatInstant(event.startsAt, readerZone()) + '.'),
      answers,
      section('Attendance', people, { note: strip }),
    ].filter(Boolean));
  };

  // An answer replaces the previous one rather than adding to it: the server
  // keeps one answer per member per event.
  const answer = async (status) => {
    try {
      const sent = await Workspace.rsvpEvent(serverId, eventId, status);
      mine = sent;
      toast('You are ' + RSVP_LABELS[status].toLowerCase());
      await loadAttendance();
    } catch (error) {
      toast((error && error.message) || 'The answer could not be sent.', { type: 'error' });
    }
  };

  const loadAttendance = async () => {
    try {
      attendance = await Workspace.eventAttendance(serverId, eventId);
      const rows = attendanceRows(attendance);
      const own = rows.find((entry) => String(entry.userId) === String(me));
      if (own) mine = own;
      paint();
    } catch (error) {
      toast((error && error.message) || 'The attendance could not be read.', { type: 'error' });
    }
  };

  const load = async () => {
    host.replaceChildren(loading('Opening the event'));
    try {
      event = await Workspace.event(serverId, eventId);
      paint();
      await loadAttendance();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Event' },
    node,
    onMount: load,
  };
}

// -- the polls ----------------------------------------------------------------------------

export function renderPolls(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const load = async () => {
    host.replaceChildren(loading('Reading the polls'));
    try {
      const polls = await Workspace.polls(serverId);
      const rows = el('div', { class: 'm-list' });
      if (!polls.length) {
        rows.appendChild(empty({
          icon: 'chart',
          title: 'No polls yet',
          text: 'A poll is a question the community answers.',
        }));
      }
      for (const poll of polls) {
        rows.appendChild(el('a', {
          class: 'm-row',
          href: path(pollRoute(serverId, poll.id)),
        },
        el('span', { class: 'm-row__lead' }, icon('chart', { size: 20 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, poll.question),
          el('span', { class: 'm-row__sub' },
            (poll.status === 'closed' ? 'closed' : 'open')
            + (poll.isAnonymous ? ' · anonymous' : ''))),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
      host.replaceChildren(
        surfaceStrip(serverId, 'polls'),
        section('Polls', rows, {
          action: mayPost(serverId)
            ? iconButton('plus', 'New poll', () => openPollEditor(serverId))
            : null,
        }));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Polls' },
    node,
    onMount: load,
  };
}

export function renderPoll(ctx) {
  const serverId = ctx.serverId;
  const pollId = paramId(ctx.params, 'poll');
  const canPost = mayPost(serverId);
  const me = State.user && State.user.id;

  let poll = null;
  let results = null;
  let resultsError = null;
  let ballot = [];

  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  const paint = () => {
    const choices = el('div', { class: 'm-list' });
    const options = poll.options || [];
    if (canPost && poll.status !== 'closed') {
      for (const option of options) {
        const input = el('input', {
          type: poll.allowsMultiple ? 'checkbox' : 'radio',
          name: 'poll-option',
          'aria-label': option.label,
          checked: ballot.indexOf(option.id) !== -1,
        });
        input.addEventListener('change', () => {
          if (poll.allowsMultiple) {
            const chosen = new Set(ballot);
            if (input.checked) chosen.add(option.id);
            else chosen.delete(option.id);
            ballot = options.filter((entry) => chosen.has(entry.id)).map((entry) => entry.id);
            return;
          }
          ballot = [option.id];
        });
        choices.appendChild(el('label', { class: 'm-row m-row--check' },
          el('span', { class: 'm-row__lead' }, input),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, option.label))));
      }
    } else {
      for (const option of options) {
        choices.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, option.label))));
      }
    }

    const result = el('div', { class: 'm-list' });
    if (resultsError) {
      result.appendChild(notice({ tone: 'info', title: 'The results are not visible yet', text: resultsError }));
    } else if (results && results.results) {
      const tally = results.results;
      for (const option of tally.options || []) {
        result.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, option.label),
            el('span', { class: 'm-row__sub' },
              poll.scoring === 'ranked'
                ? option.score + ' points · position ' + option.rank
                : option.votes + ' vote' + (option.votes === 1 ? '' : 's')))));
      }
      result.appendChild(el('p', { class: 'm-section__note' },
        poll.scoring === 'ranked'
          ? 'A ranked poll scores a ballot by position: the first choice is worth '
            + bordaPoints(1, (tally.options || []).length || 1) + ' points.'
          : String(tally.ballots || 0) + ' ballot' + (tally.ballots === 1 ? '' : 's') + ' counted.'));
    }

    const voters = el('div', { class: 'm-list' });
    if (poll.isAnonymous) {
      voters.appendChild(el('p', { class: 'm-section__note' },
        'This poll is anonymous. It names nobody, before it closes or after.'));
    } else {
      const rows = results && results.results ? (results.results.voters || []) : [];
      if (!rows.length) {
        voters.appendChild(el('p', { class: 'm-section__note' },
          resultsError ? 'The voters are not visible until the poll closes.' : 'Nobody has voted yet.'));
      }
      for (const entry of rows) {
        voters.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, entry.displayName || entry.username || 'A member'),
            el('span', { class: 'm-row__sub' },
              (entry.choices || []).map((choice) => optionLabel(tally, choice)).join(' · ')))));
      }
    }

    const tools = [];
    if (canPost && poll.status !== 'closed') {
      tools.push(primaryButton('Vote', () => vote()));
    }
    if (poll.status !== 'closed' && mayActOn(serverId, poll.createdBy, me)) {
      tools.push(ghostButton('Close the poll', () => close()));
    }

    host.replaceChildren(...[
      heading(poll.question, (POLL_SCORING_LABELS[poll.scoring] || poll.scoring)
        + (poll.isAnonymous ? ' · anonymous' : '')),
      section('The options', choices),
      tools.length ? actions(tools) : null,
      section('The result', result),
      section('Who voted', voters),
    ].filter(Boolean));
  };

  const optionLabel = (tally, id) => {
    const found = ((tally && tally.options) || []).find((option) => String(option.id) === String(id));
    return found ? found.label : 'an option';
  };

  // The whole ballot goes to the server, which replaces the previous one: a
  // vote is never counted twice.
  const vote = async () => {
    if (!ballot.length) {
      toast('Choose an option first', { type: 'error' });
      return;
    }
    try {
      await Workspace.votePoll(serverId, pollId, ballot);
      toast('Your vote is counted');
      await loadResults();
    } catch (error) {
      toast((error && error.message) || 'The vote could not be counted.', { type: 'error' });
    }
  };

  const close = async () => {
    const yes = await confirm({
      title: 'Close the poll?',
      text: 'The result is recorded and the poll stops taking votes.',
      confirmLabel: 'Close',
    });
    if (!yes) return;
    try {
      await Workspace.closePoll(serverId, pollId);
      toast('The poll is closed');
      await load();
    } catch (error) {
      toast((error && error.message) || 'The poll could not be closed.', { type: 'error' });
    }
  };

  const loadResults = async () => {
    try {
      results = await Workspace.pollResults(serverId, pollId);
      resultsError = null;
    } catch (error) {
      results = null;
      resultsError = error && error.code === 'PERMISSION_DENIED'
        ? 'The results of a poll are visible to the people who set it up and to those '
          + 'who manage this community until the poll closes. Everybody sees them after it does.'
        : ((error && error.message) || 'The result could not be read.');
    }
    paint();
  };

  const load = async () => {
    host.replaceChildren(loading('Opening the poll'));
    try {
      poll = await Workspace.poll(serverId, pollId);
      ballot = [];
      paint();
      await loadResults();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  };

  return {
    head: { lead: 'back', title: 'Poll' },
    node,
    onMount: load,
  };
}

// -- the shared pieces -----------------------------------------------------------------------

// A block, read. The same blocks the desk shows, drawn in the phone's own way.
function blockNode(block) {
  switch (block.type) {
    case 'heading':
      return el('div', { class: 'm-heading' },
        el('h2', { class: 'm-heading__title' }, block.text));
    case 'lead':
      return el('p', { class: 'm-lede' }, block.text);
    case 'paragraph':
      return el('p', {}, block.text);
    case 'list':
      return el('ul', { class: 'm-list' },
        ...(block.items || []).map((item) => el('li', { class: 'm-row__title' }, item)));
    case 'note':
      return notice({ tone: 'info', text: block.text });
    case 'link':
      return el('p', {}, el('a', { class: 'm-link', href: block.href }, block.text || block.href));
    case 'rule':
      return el('hr', {});
    case 'quote':
      return el('div', { class: 'm-state' },
        el('div', { class: 'm-state__text' }, block.text),
        block.attribution ? el('div', { class: 'm-state__title' }, block.attribution) : null);
    case 'code':
      return el('pre', { class: 'm-code' }, block.text);
    case 'image':
      return el('img', { class: 'm-media-img', src: block.src, alt: block.alt || '' });
    default:
      return el('p', { class: 'm-form-error' }, 'Unknown block type: ' + (block.type || '(missing)'));
  }
}

// The name a block is known by on the phone.
function blockTypeLabel(type) {
  if (type === 'heading') return 'Heading';
  if (type === 'lead') return 'Description';
  if (type === 'paragraph') return 'Paragraph';
  if (type === 'list') return 'List';
  if (type === 'note') return 'Note';
  if (type === 'link') return 'Link';
  if (type === 'quote') return 'Quotation';
  if (type === 'code') return 'Code';
  if (type === 'image') return 'Image';
  if (type === 'table') return 'Table';
  return 'Rule';
}

// The text of a block, as a line somebody can read.
function blockText(block) {
  if (!block) return '';
  if (Array.isArray(block.items)) return block.items.join(' · ');
  if (typeof block.text === 'string') return block.text;
  if (typeof block.alt === 'string') return block.alt;
  if (typeof block.href === 'string') return block.href;
  return '';
}

// A number with a label under it.
function statCell(value, label) {
  return el('div', { class: 'm-stat' },
    el('div', { class: 'm-stat__value' }, value),
    el('div', { class: 'm-stat__label' }, label));
}

// What a change to a card says it changed.
function activityLine(entry) {
  const field = entry.field || 'the card';
  if (entry.field === 'created' || entry.field === 'created from message') {
    return 'Created: ' + (entry.to || '');
  }
  if (entry.from === null || entry.from === undefined || entry.from === '') {
    return 'Changed ' + field + ' to ' + (entry.to === null || entry.to === undefined ? 'nothing' : entry.to);
  }
  if (entry.to === null || entry.to === undefined || entry.to === '') {
    return 'Cleared ' + field;
  }
  return 'Changed ' + field + ' from ' + entry.from + ' to ' + entry.to;
}

// The glyph a reference is drawn with.
function iconForItem(item) {
  if (item.kind === 'channel') return 'hash';
  if (item.kind === 'document') return 'file';
  if (item.kind === 'board') return 'grid';
  return 'link';
}

// Where a reference points.
function hrefForItem(serverId, item) {
  if (item.kind === 'channel' && item.targetId) {
    return '/server/' + serverId + '/channel/' + item.targetId;
  }
  if (item.kind === 'document' && item.targetId) return documentRoute(serverId, item.targetId);
  if (item.kind === 'board' && item.targetId) return boardRoute(serverId, item.targetId);
  return null;
}

// -- the editors -------------------------------------------------------------------------------

// A space, made.
function openSpaceEditor(serverId, onDone) {
  const name = textInput({ label: 'The name of the space', placeholder: 'Engineering' });
  const description = textArea({
    label: 'What the space is for', rows: '2', placeholder: 'What the members of this space share',
  });
  const error = el('p', { class: 'm-form-error', hidden: true });
  const layer = sheet({
    title: 'New space',
    body: el('div', { class: 'm-stack' },
      field({ label: 'Name', control: name }),
      field({ label: 'Description', control: description }),
      error),
    footer: actions([
      primaryButton('Create', async () => {
        error.hidden = true;
        if (!name.value.trim()) {
          error.hidden = false;
          error.textContent = 'Give the space a name.';
          return;
        }
        try {
          await Workspace.createSpace(serverId, {
            name: name.value.trim(),
            description: description.value.trim(),
          });
          toast('The space is made');
          layer.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The space could not be made.';
        }
      }, { block: true }),
    ]),
  });
}

// The reference picker: what the reader may see, and a link of their own.
function openReferencePicker(serverId, spaceId, onDone) {
  const kind = select({
    label: 'What kind of reference',
    choices: [
      { value: 'channel', label: 'Channel' },
      { value: 'document', label: 'Document' },
      { value: 'board', label: 'Board' },
      { value: 'resource', label: 'Link' },
    ],
  });
  const target = select({ label: 'The thing to reference', choices: [] });
  const url = textInput({ label: 'The address of the link', placeholder: 'https://example.org/handbook' });
  const choices = { channel: [], document: [], board: [] };
  const error = el('p', { class: 'm-form-error', hidden: true });

  const paintTarget = () => {
    url.hidden = kind.value !== 'resource';
    target.hidden = kind.value === 'resource';
    if (kind.value === 'resource') return;
    target.replaceChildren();
    const list = choices[kind.value] || [];
    if (!list.length) {
      target.appendChild(el('option', { value: '' }, 'Nothing to reference yet'));
      return;
    }
    for (const entry of list) target.appendChild(el('option', { value: entry.id }, entry.label));
  };
  kind.addEventListener('change', paintTarget);
  paintTarget();

  const layer = sheet({
    title: 'Add a reference',
    body: el('div', { class: 'm-stack' },
      field({ label: 'Kind', control: kind }),
      field({ label: 'Reference', control: target }),
      field({ label: 'Address', control: url }),
      error),
    footer: actions([
      primaryButton('Add', async () => {
        error.hidden = true;
        const body = { kind: kind.value };
        if (kind.value === 'resource') {
          if (!url.value.trim()) {
            error.hidden = false;
            error.textContent = 'Give the link an address.';
            return;
          }
          body.url = url.value.trim();
        } else {
          if (!target.value) {
            error.hidden = false;
            error.textContent = 'Choose what to reference.';
            return;
          }
          body.targetId = target.value;
        }
        try {
          await Workspace.addSpaceItem(serverId, spaceId, body);
          toast('Added to the space');
          layer.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The reference could not be added.';
        }
      }, { block: true }),
    ]),
  });

  (async () => {
    try {
      await refreshServerTree(serverId);
      const [documents, boards] = await Promise.all([
        Workspace.documents(serverId), Workspace.boards(serverId),
      ]);
      choices.channel = channelsOf(serverId).map((channel) => ({
        id: channel.id, label: '#' + (channel.name || 'channel'),
      }));
      choices.document = (documents || []).map((document) => ({ id: document.id, label: document.title }));
      choices.board = (boards || []).map((board) => ({ id: board.id, label: board.name }));
      paintTarget();
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'What may be referenced could not be read.';
    }
  })();
}

// A document, made.
function openNewDocument(serverId) {
  const title = textInput({ label: 'The title of the document', placeholder: 'How this community works' });
  const error = el('p', { class: 'm-form-error', hidden: true });
  const layer = sheet({
    title: 'New document',
    body: el('div', { class: 'm-stack' },
      field({ label: 'Title', control: title }),
      error),
    footer: actions([
      primaryButton('Create', async () => {
        error.hidden = true;
        if (!title.value.trim()) {
          error.hidden = false;
          error.textContent = 'Give the document a title.';
          return;
        }
        try {
          const created = await Workspace.createDocument(serverId, { title: title.value.trim(), body: [] });
          toast('The document is made');
          layer.close();
          navigate(documentRoute(serverId, created.id));
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The document could not be made.';
        }
      }, { block: true }),
    ]),
  });
}

// An event, made.
function openEventEditor(serverId) {
  const title = textInput({ label: 'The title of the event' });
  const description = textArea({ label: 'What happens at the event', rows: '2' });
  const starts = el('input', { class: 'm-input', type: 'datetime-local', 'aria-label': 'When the event starts' });
  const ends = el('input', { class: 'm-input', type: 'datetime-local', 'aria-label': 'When the event ends' });
  const zone = textInput({ label: 'The timezone the times are written in' });
  zone.value = readerZone();
  const visibility = select({
    label: 'Who may see who is coming',
    choices: Object.keys(ATTENDANCE_VISIBILITY_LABELS).map((value) => ({
      value, label: ATTENDANCE_VISIBILITY_LABELS[value],
    })),
  });
  const error = el('p', { class: 'm-form-error', hidden: true });

  const layer = sheet({
    title: 'New event',
    body: el('div', { class: 'm-stack' },
      field({ label: 'Title', control: title }),
      field({ label: 'Description', control: description }),
      field({ label: 'Starts', control: starts }),
      field({ label: 'Ends', control: ends }),
      field({ label: 'Timezone', control: zone }),
      field({ label: 'Attendance', control: visibility }),
      error),
    footer: actions([
      primaryButton('Create', async () => {
        error.hidden = true;
        if (!title.value.trim() || !starts.value || !ends.value) {
          error.hidden = false;
          error.textContent = 'An event needs a title, a start and an end.';
          return;
        }
        try {
          await Workspace.createEvent(serverId, {
            title: title.value.trim(),
            description: description.value,
            timezone: zone.value.trim() || readerZone(),
            startsAt: instantInZone(starts.value, zone.value.trim() || readerZone()),
            endsAt: instantInZone(ends.value, zone.value.trim() || readerZone()),
            attendanceVisibility: visibility.value,
          });
          toast('The event is made');
          layer.close();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The event could not be made.';
        }
      }, { block: true }),
    ]),
  });
}

// A poll, made.
// A poll, made or edited.
//
// The poll being edited is the third argument; without one this is a new poll.
// The phone's editor takes two options, the desk's takes as many as the
// reader adds: the two are different shapes of the same thing, and the server
// is the one that says how many are needed.
function openPollEditor(serverId, onChanged, poll) {
  const editing = poll || null;
  const question = textInput({ label: 'The question' });
  const first = textInput({ label: 'Option 1' });
  const second = textInput({ label: 'Option 2' });
  const scoring = select({
    label: 'How the answers are counted',
    choices: POLL_SCORINGS.map((value) => ({ value, label: POLL_SCORING_LABELS[value] })),
  });
  const error = el('p', { class: 'm-form-error', hidden: true });

  if (editing) {
    question.value = editing.question || '';
    first.value = (editing.options && editing.options[0] && editing.options[0].label) || '';
    second.value = (editing.options && editing.options[1] && editing.options[1].label) || '';
    scoring.value = editing.scoring || 'plurality';
  }

  const layer = sheet({
    title: editing ? 'Edit the poll' : 'New poll',
    body: el('div', { class: 'm-stack' },
      field({ label: 'Question', control: question }),
      field({ label: 'Option 1', control: first }),
      field({ label: 'Option 2', control: second }),
      field({ label: 'Scoring', control: scoring }),
      error),
    footer: actions([
      primaryButton(editing ? 'Save' : 'Create', async () => {
        error.hidden = true;
        const options = [first.value.trim(), second.value.trim()].filter(Boolean);
        if (!question.value.trim() || options.length < 2) {
          error.hidden = false;
          error.textContent = 'A poll needs a question and at least two options.';
          return;
        }
        try {
          const body = { question: question.value.trim(), options, scoring: scoring.value };
          if (editing) {
            await Workspace.updatePoll(serverId, editing.id, body);
            toast('The poll is saved');
          } else {
            await Workspace.createPoll(serverId, body);
            toast('The poll is made');
          }
          layer.close();
          if (onChanged) await onChanged();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message)
            || (editing ? 'The poll could not be saved.' : 'The poll could not be made.');
        }
      }, { block: true }),
    ]),
  });
}

export default {
  renderWorkspace, renderSpaces, renderSpace,
  renderDocuments, renderDocument,
  renderBoards, renderBoard, renderCard,
  renderEvents, renderEvent,
  renderPolls, renderPoll,
};
