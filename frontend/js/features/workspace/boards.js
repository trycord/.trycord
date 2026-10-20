// The boards, on a desk.
//
// A board belongs to a community and optionally to a space. Its columns are the
// lanes; a card is the unit of work, and it carries a title, a body, an
// assignee, a due date, a priority, a status, labels, links and milestones.
//
// Two rules shape everything here:
//
//   - an update states the version it was written against, and the write only
//     lands when that is still the current version, so two people editing the
//     same card produce one edit and one conflict rather than one edit that
//     silently loses the other
//   - every change to a card is appended to the card's activity, which is a
//     record and is never rewritten
//
// Posting a card needs SEND_MESSAGES; changing somebody else's card needs
// MANAGE_MESSAGES; the structure of the board - its lanes, its milestones and
// the board itself - needs MANAGE_CHANNELS.

import { el, replaceChildren } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { card, row, blank, fault, fold, hold, memo } from '../../ui/page.js';
import { openDialog, toast, errorToast } from '../../ui/overlays.js';
import Api from '../../../packages/api.js';
import { relativeTime } from '../../../packages/format.js';
import { path } from '../../../packages/nav.js';
import { State, channelsOf, refreshServerTree } from '../../../packages/store.js';
import {
  Workspace, CARD_PRIORITIES, CARD_STATUSES, CARD_LINK_KINDS, CARD_LINK_LABELS,
  PRIORITY_LABELS, STATUS_LABELS,
  mayManageStructure, mayPost, mayActOn, paramId,
  boardRoute, cardRoute, documentRoute, eventRoute,
  toZoneInput, instantInZone, readerZone,
} from '../../../packages/workspace.js';

// -- the list ------------------------------------------------------------------

export function boardsList(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'rowlist' });
  const canManage = mayManageStructure(serverId);

  const node = card({
    label: 'Boards',
    glyph: 'grid',
    note: 'lanes, cards and milestones',
    actions: canManage
      ? el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => openBoardEditor(serverId, load),
      }, icon('plus', { size: 14 }), 'New board')
      : null,
    body: host,
    flush: true,
  });

  const load = async () => {
    replaceChildren(host, hold('Reading the boards'));
    try {
      const boards = await Workspace.boards(serverId);
      replaceChildren(host, ...(boards.length
        ? boards.map((board) => row({
          lead: el('span', { class: 'role-dot' }, icon('grid', { size: 15 })),
          title: board.name,
          sub: board.description || 'A board of cards',
          href: path(boardRoute(serverId, board.id)),
          link: true,
        }))
        : [blank({
          glyph: 'grid',
          title: 'No boards yet',
          text: 'A board holds lanes, and a lane holds the work.',
        })]));
    } catch (error) {
      replaceChildren(host, fold([fault(error, load)]));
    }
  };

  return { node, onMount: load, cleanup() {} };
}

// -- one board -------------------------------------------------------------------

export function boardsDetail(ctx) {
  const serverId = ctx.serverId;
  const boardId = paramId(ctx.params, 'board');
  const cardId = paramId(ctx.params, 'card');

  if (cardId && boardId) return cardView(ctx, boardId, cardId);
  if (!boardId) {
    return {
      node: blank({
        glyph: 'grid',
        title: 'No board open',
        text: 'Choose a board on the left to see its lanes.',
      }),
      onMount: async () => {},
      cleanup() {},
    };
  }
  return boardView(ctx, boardId);
}

// The board: its lanes, and the cards in them.
function boardView(ctx, boardId) {
  const serverId = ctx.serverId;
  const canManage = mayManageStructure(serverId);
  const canPost = mayPost(serverId);

  let board = null;
  const lanes = el('div', { class: 'cardgrid' });
  const head = el('div', { class: 'fold fold--tight' });

  const node = fold([
    card({
      label: 'The board',
      glyph: 'grid',
      actions: canManage
        ? el('span', { class: 'rowtools' },
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => openColumnEditor(serverId, boardId, load),
          }, icon('plus', { size: 14 }), 'Lane'),
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => openMilestoneEditor(serverId, boardId, load),
          }, icon('plus', { size: 14 }), 'Milestone'))
        : null,
      body: fold([head, lanes], { tight: true }),
    }),
  ], { wide: true });

  const paintHead = () => {
    replaceChildren(head, 
      el('h2', { class: 'pagehead-title' }, board.name),
      el('p', { class: 'form-note' }, board.description
        || 'The lanes of this board and the cards in them.'),
      el('p', { class: 'form-note' },
        (board.cards || []).length + ' card' + ((board.cards || []).length === 1 ? '' : 's')
        + ' · ' + (board.columns || []).length + ' lane' + ((board.columns || []).length === 1 ? '' : 's')
        + ' · ' + (board.milestones || []).length + ' milestone'
        + ((board.milestones || []).length === 1 ? '' : 's')),
    );
  };

  const paintLanes = () => {
    const columns = board.columns || [];
    if (!columns.length) {
      replaceChildren(lanes, blank({
        glyph: 'list',
        title: 'This board has no lanes',
        text: canManage ? 'Add a lane and cards can be filed in it.' : 'Nobody has made a lane yet.',
      }));
      return;
    }
    replaceChildren(lanes, ...columns.map((column) => laneColumn(serverId, board, column, canPost, load)));
  };

  const load = async () => {
    replaceChildren(lanes, hold('Reading the board'));
    try {
      board = await Workspace.board(serverId, boardId);
      paintHead();
      paintLanes();
    } catch (error) {
      replaceChildren(lanes, fold([fault(error, load)]));
    }
  };

  return {
    node,
    onMount: load,
    cleanup() {},
  };
}

// One lane, and the cards filed in it.
function laneColumn(serverId, board, column, canPost, load) {
  const cards = (board.cards || []).filter((entry) => String(entry.columnId) === String(column.id));
  const body = el('div', { class: 'rowlist' });
  if (cards.length) {
    replaceChildren(body, ...cards.map((entry) => row({
      lead: el('span', { class: 'role-dot' }, icon(priorityIcon(entry.priority), { size: 15 })),
      title: entry.title,
      sub: [PRIORITY_LABELS[entry.priority] || entry.priority, entry.status && STATUS_LABELS[entry.status]]
        .filter(Boolean).join(' · '),
      meta: entry.dueAt ? relativeTime(entry.dueAt) : null,
      href: path(cardRoute(serverId, board.id, entry.id)),
      link: true,
    })));
  } else {
    replaceChildren(body, el('p', { class: 'form-note' }, 'Nothing filed here yet.'));
  }

  return card({
    label: column.name,
    glyph: 'list',
    note: cards.length + ' card' + (cards.length === 1 ? '' : 's'),
    body: fold([body, canPost
      ? el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => openCardEditor(serverId, board, column, null, load),
      }, icon('plus', { size: 14 }), 'Add a card')
      : null], { tight: true }),
  });
}

// The glyph a card is drawn with, by its priority.
function priorityIcon(priority) {
  if (priority === 'urgent') return 'alert';
  if (priority === 'high') return 'arrow-up';
  if (priority === 'low') return 'arrow-down';
  return 'circle-dot';
}

// -- one card ----------------------------------------------------------------------

function cardView(ctx, boardId, cardId) {
  const serverId = ctx.serverId;
  const me = State.user && State.user.id;

  let board = null;
  let theCard = null;
  const names = new Map();

  const actions = el('span', { class: 'rowtools' });
  const head = el('div', { class: 'fold fold--tight' });
  const facts = el('div', { class: 'statstrip' });
  const links = el('div', { class: 'rowlist' });
  const milestones = el('div', { class: 'rowlist' });
  const activity = el('div', { class: 'rowlist' });
  const conflict = el('div', { class: 'fold fold--tight' });

  const node = fold([
    conflict,
    card({
      label: 'The card',
      glyph: 'file',
      actions,
      body: fold([head, facts], { tight: true }),
    }),
    card({ label: 'Links', glyph: 'link', body: links, flush: true }),
    card({ label: 'Milestones', glyph: 'flag', body: milestones, flush: true }),
    card({ label: 'Activity', glyph: 'activity', body: activity, flush: true }),
  ], { wide: true });

  // A write that was written against an older version is refused, and the
  // answer says which version the card is at now.
  const showConflict = (error) => {
    const current = (error && error.details && error.details.currentVersion) || null;
    replaceChildren(conflict, memo({
      tone: 'warning',
      title: 'This card changed while you were editing it',
      text: current
        ? 'The server holds version ' + current + '. Your change has not been saved.'
        : 'Your change has not been saved.',
      actions: el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => load(),
      }, 'Read it again'),
    }));
  };

  // The actions the reader may use on this card. The server allows the author
  // to act on their own card and a moderator on anybody's; the client asks the
  // same question, so it never offers a write that would be refused.
  const paintActions = () => {
    const mine = mayActOn(serverId, theCard.createdBy, me);
    const tools = [
      el('a', {
        class: 'btn btn--ghost btn--sm', href: path(boardRoute(serverId, boardId)),
      }, icon('arrow-left', { size: 14 }), 'Back to the board'),
    ];
    if (mine) {
      tools.push(el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => openCardEditor(serverId, board, null, theCard, load, showConflict),
      }, icon('edit', { size: 14 }), 'Edit'));
    }
    replaceChildren(actions, ...tools);
  };

  const paintHead = () => {
    replaceChildren(head, 
      el('h2', { class: 'pagehead-title' }, theCard.title),
      el('p', { class: 'form-note' }, 'Version ' + theCard.version + ' · ' + relativeTime(theCard.updatedAt)),
      theCard.body ? el('p', { class: 'form-note' }, theCard.body) : null,
    );
  };

  const paintFacts = () => {
    const cells = [
      { value: PRIORITY_LABELS[theCard.priority] || theCard.priority, label: 'priority' },
      { value: STATUS_LABELS[theCard.status] || theCard.status, label: 'status' },
      { value: theCard.assigneeId ? (names.get(String(theCard.assigneeId)) || theCard.assigneeId) : '—', label: 'assignee' },
      { value: theCard.dueAt ? relativeTime(theCard.dueAt) : '—', label: 'due' },
    ];
    replaceChildren(facts, el('div', { class: 'statstrip' },
      ...cells.map((cell) => el('div', { class: 'stat' },
        el('span', { class: 'stat-value' }, cell.value),
        el('span', { class: 'stat-label' }, cell.label)))));
  };

  const paintLinks = () => {
    const rows = theCard.links || [];
    replaceChildren(links, ...(rows.length
      ? rows.map((entry) => row({
        lead: el('span', { class: 'role-dot' }, icon('link', { size: 15 })),
        title: CARD_LINK_LABELS[entry.kind] || entry.kind,
        sub: entry.targetId,
        href: hrefForLink(serverId, entry),
        link: hrefForLink(serverId, entry) ? true : null,
      }))
      : [blank({
        glyph: 'link',
        title: 'Nothing linked',
        text: 'A card can point at a channel, a document, an event or a message.',
      })]));
    if (mayActOn(serverId, theCard.createdBy, me)) {
      links.appendChild(el('div', { class: 'actionline' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => openLinkEditor(serverId, boardId, theCard, load),
        }, icon('plus', { size: 14 }), 'Link from this card'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => openMilestonePicker(serverId, boardId, theCard, load),
        }, icon('flag', { size: 14 }), 'File under a milestone'),
        moveControl(serverId, board, theCard, load, showConflict)));
    }
  };

  const paintMilestones = () => {
    const rows = theCard.milestones || [];
    replaceChildren(milestones, ...(rows.length
      ? rows.map((entry) => row({
        lead: el('span', { class: 'role-dot' }, icon('flag', { size: 15 })),
        title: entry.name,
        sub: entry.description || 'A milestone of this board',
        meta: entry.dueAt ? relativeTime(entry.dueAt) : null,
      }))
      : [el('p', { class: 'form-note' }, 'This card is not filed under a milestone.')]));
  };

  const paintActivity = () => {
    const rows = theCard.activity || [];
    replaceChildren(activity, ...(rows.length
      ? rows.map((entry) => row({
        title: activityLine(entry),
        sub: relativeTime(entry.createdAt),
        meta: entry.actorId,
      }))
      : [el('p', { class: 'form-note' }, 'Nothing has happened to this card yet.')]));
  };

  const load = async () => {
    replaceChildren(head, hold('Opening the card'));
    try {
      const answers = await Promise.all([
        Workspace.board(serverId, boardId),
        Workspace.card(serverId, boardId, cardId),
        Api.serverMembers(serverId, { limit: 200 }),
      ]);
      board = answers[0];
      theCard = answers[1];
      names.clear();
      for (const member of (answers[2] && answers[2].items) || []) {
        names.set(String(member.id), member.display_name || member.displayName || member.username);
      }
      replaceChildren(conflict);
      paintActions();
      paintHead();
      paintFacts();
      paintLinks();
      paintMilestones();
      paintActivity();
    } catch (error) {
      replaceChildren(head, fold([fault(error, load)]));
    }
  };

  return {
    node,
    onMount: load,
    cleanup() {},
  };
}

// The lane a card is filed in, and the control that moves it.
//
// A move is a change like any other, so it states the version the card is at.
function moveControl(serverId, board, card, load, onConflict) {
  const lane = el('select', { class: 'select', 'aria-label': 'The lane to move the card into' },
    ...(board.columns || []).map((entry) => el('option', {
      value: entry.id,
      selected: String(entry.id) === String(card.columnId),
    }, entry.name)));
  const button = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    onClick: async () => {
      if (!lane.value || String(lane.value) === String(card.columnId)) return;
      button.disabled = true;
      try {
        await Workspace.moveCard(serverId, board.id, card.id, {
          columnId: lane.value,
          version: card.version,
        });
        toast('The card is filed in ' + (lane.selectedOptions[0] ? lane.selectedOptions[0].text : 'another lane'));
        await load();
      } catch (error) {
        if (error && error.code === 'CONFLICT' && error.details) { onConflict(error); return; }
        errorToast(error);
      } finally {
        button.disabled = false;
      }
    },
  }, 'Move');
  return el('span', { class: 'rowtools' }, lane, button);
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

// Where a link from a card points.
function hrefForLink(serverId, entry) {
  if (!entry || !entry.targetId) return null;
  if (entry.kind === 'channel') return path('/server/' + serverId + '/channel/' + entry.targetId);
  if (entry.kind === 'document') return path(documentRoute(serverId, entry.targetId));
  if (entry.kind === 'event') return path(eventRoute(serverId, entry.targetId));
  return null;
}

// -- the editors ----------------------------------------------------------------------

// A board, made.
function openBoardEditor(serverId, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: '64', 'aria-label': 'The name of the board' });
  const description = el('textarea', {
    class: 'input', rows: '2', maxlength: '1000', 'aria-label': 'What the board is for',
  });
  const error = el('p', { class: 'form-error', hidden: true });
  const dialog = openDialog({
    title: 'New board',
    sub: 'A board starts with three lanes: to do, in progress and done.',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!name.value.trim()) { error.hidden = false; error.textContent = 'Give the board a name.'; return; }
        try {
          await Workspace.createBoard(serverId, {
            name: name.value.trim(),
            description: description.value.trim(),
          });
          toast('The board is made');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The board could not be made.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Description'), description),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Create')),
  });
  name.focus();
}

// A lane, made.
function openColumnEditor(serverId, boardId, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: '64', 'aria-label': 'The name of the lane' });
  const error = el('p', { class: 'form-error', hidden: true });
  const dialog = openDialog({
    title: 'New lane',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!name.value.trim()) { error.hidden = false; error.textContent = 'Give the lane a name.'; return; }
        try {
          await Workspace.createBoardColumn(serverId, boardId, { name: name.value.trim() });
          toast('The lane is made');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The lane could not be made.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Create')),
  });
  name.focus();
}

// A milestone, made.
function openMilestoneEditor(serverId, boardId, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: '128', 'aria-label': 'The name of the milestone' });
  const description = el('textarea', {
    class: 'input', rows: '2', maxlength: '1000', 'aria-label': 'What the milestone is for',
  });
  const due = el('input', { class: 'input', type: 'datetime-local', 'aria-label': 'When the milestone is due' });
  const zone = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The timezone the due date is written in',
  });
  zone.value = readerZone();
  const error = el('p', { class: 'form-error', hidden: true });
  const dialog = openDialog({
    title: 'New milestone',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!name.value.trim()) { error.hidden = false; error.textContent = 'Give the milestone a name.'; return; }
        const body = {
          name: name.value.trim(),
          description: description.value.trim(),
        };
        if (due.value) {
          body.dueAt = instantInZone(due.value, zone.value.trim() || readerZone());
          body.dueTimezone = zone.value.trim() || readerZone();
        }
        try {
          await Workspace.createBoardMilestone(serverId, boardId, body);
          toast('The milestone is made');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The milestone could not be made.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Description'), description),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Due'), due),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Timezone'), zone),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Create')),
  });
  name.focus();
}

// A card, made or changed.
//
// The version the card carries is the precondition of the write, so two people
// editing the same card produce one edit and one conflict.
function openCardEditor(serverId, board, column, card, onDone, onConflict) {
  const title = el('input', { class: 'input', type: 'text', maxlength: '255', 'aria-label': 'The title of the card' });
  title.value = card ? card.title : '';
  const body = el('textarea', { class: 'input', rows: '4', maxlength: '10000', 'aria-label': 'What the card is about' });
  body.value = card ? card.body : '';
  const priority = el('select', { class: 'select', 'aria-label': 'The priority of the card' },
    ...CARD_PRIORITIES.map((value) => el('option', {
      value, selected: card ? card.priority === value : value === 'normal',
    }, PRIORITY_LABELS[value])));
  const status = el('select', { class: 'select', 'aria-label': 'The status of the card' },
    ...CARD_STATUSES.map((value) => el('option', {
      value, selected: card ? card.status === value : value === 'open',
    }, STATUS_LABELS[value])));
  const assignee = el('select', { class: 'select', 'aria-label': 'Who the card is for' });
  const due = el('input', { class: 'input', type: 'datetime-local', 'aria-label': 'When the card is due' });
  const zone = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The timezone the due date is written in',
  });
  const labels = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The labels of the card, separated by commas',
  });
  labels.value = card ? (card.labels || []).join(', ') : '';
  const lane = el('select', { class: 'select', 'aria-label': 'The lane the card is filed in' },
    ...(board.columns || []).map((entry) => el('option', {
      value: entry.id,
      selected: column ? String(entry.id) === String(column.id) : false,
    }, entry.name)));
  const error = el('p', { class: 'form-error', hidden: true });

  zone.value = card ? (card.dueTimezone || readerZone()) : readerZone();
  due.value = card && card.dueAt ? toZoneInput(card.dueAt, card.dueTimezone) : '';

  const dialog = openDialog({
    title: card ? 'Edit the card' : 'New card',
    sub: card ? 'The card carries version ' + card.version + '.' : null,
    wide: true,
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!title.value.trim()) { error.hidden = false; error.textContent = 'Give the card a title.'; return; }
        const fields = {
          title: title.value.trim(),
          body: body.value,
          priority: priority.value,
          status: status.value,
          assigneeId: assignee.value || null,
          labels: labels.value.split(',').map((entry) => entry.trim()).filter(Boolean),
        };
        if (due.value) {
          fields.dueAt = instantInZone(due.value, zone.value.trim() || readerZone());
          fields.dueTimezone = zone.value.trim() || readerZone();
        } else {
          fields.dueAt = null;
        }
        try {
          if (card) {
            fields.version = card.version;
            await Workspace.updateCard(serverId, board.id, card.id, fields);
            toast('The card is saved');
          } else {
            fields.columnId = lane.value || (column && column.id) || null;
            await Workspace.createCard(serverId, board.id, fields);
            toast('The card is filed');
          }
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          if (err && err.code === 'CONFLICT' && err.details) {
            dialog.close();
            if (onConflict) onConflict(err);
            else errorToast(err);
            return;
          }
          error.hidden = false;
          error.textContent = (err && err.message) || 'The card could not be saved.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Title'), title),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Body'), body),
    el('div', { class: 'pageblock-row' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Priority'), priority),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Status'), status)),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Assignee'), assignee),
    el('div', { class: 'pageblock-row' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Due'), due),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Timezone'), zone)),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Labels'), labels),
    card ? null : el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Lane'), lane),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, card ? 'Save' : 'Create')),
  });

  // The assignee is somebody the community can reach, so the picker is the
  // community's own roster.
  (async () => {
    try {
      const page = await Api.serverMembers(serverId, { limit: 200 });
      const items = (page && page.items) || [];
      assignee.appendChild(el('option', { value: '' }, 'Nobody'));
      for (const member of items) {
        const name_ = member.display_name || member.displayName || member.username;
        assignee.appendChild(el('option', {
          value: member.id,
          selected: card ? String(card.assigneeId) === String(member.id) : false,
        }, name_));
      }
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'The roster could not be read.';
    }
  })();

  title.focus();
}

// A link from a card to something else in the community.
//
// The client offers the things the reader may see: the channels of the
// community, the documents the server lists for them and the events they may
// open. A message is named by its id, because a message is not a thing the
// server lists.
function openLinkEditor(serverId, boardId, card, onDone) {
  const kind = el('select', { class: 'select', 'aria-label': 'What kind of thing to link to' },
    ...CARD_LINK_KINDS.map((value) => el('option', { value }, CARD_LINK_LABELS[value])));
  const target = el('select', { class: 'select', 'aria-label': 'The thing to link to' });
  const message = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The id of the message to link to',
  });
  const error = el('p', { class: 'form-error', hidden: true });

  const choices = { channel: [], document: [], event: [] };

  const paintTarget = () => {
    const isMessage = kind.value === 'message' || kind.value === 'discussion';
    message.hidden = !isMessage;
    target.hidden = isMessage;
    if (isMessage) return;
    replaceChildren(target);
    const list = choices[kind.value] || [];
    if (!list.length) {
      target.appendChild(el('option', { value: '' }, 'Nothing to link to yet'));
      return;
    }
    for (const entry of list) target.appendChild(el('option', { value: entry.id }, entry.label));
  };
  kind.addEventListener('change', paintTarget);
  paintTarget();

  const dialog = openDialog({
    title: 'Link from this card',
    sub: 'The target has to be something in this community.',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        const isMessage = kind.value === 'message' || kind.value === 'discussion';
        const value = isMessage ? message.value.trim() : target.value;
        if (!value) { error.hidden = false; error.textContent = 'Say what to link to.'; return; }
        try {
          await Workspace.addCardLink(serverId, boardId, card.id, {
            kind: kind.value,
            targetId: value,
          });
          toast('Linked');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The link could not be made.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Kind'), kind),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Target'), target),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Message'), message),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Link')),
  });

  (async () => {
    try {
      await refreshServerTree(serverId);
      const [documents, events] = await Promise.all([
        Workspace.documents(serverId),
        Workspace.events(serverId),
      ]);
      choices.channel = channelsOf(serverId).map((channel) => ({
        id: channel.id, label: '#' + (channel.name || 'channel'),
      }));
      choices.document = (documents || []).map((document) => ({
        id: document.id, label: document.title,
      }));
      choices.event = (events || []).map((event) => ({
        id: event.id, label: event.title,
      }));
      paintTarget();
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'What may be linked could not be read.';
    }
  })();
}

// A card filed under a milestone.
function openMilestonePicker(serverId, boardId, card, onDone) {
  const milestone = el('select', { class: 'select', 'aria-label': 'The milestone to file the card under' });
  const error = el('p', { class: 'form-error', hidden: true });
  const dialog = openDialog({
    title: 'File under a milestone',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!milestone.value) { error.hidden = false; error.textContent = 'Choose a milestone.'; return; }
        try {
          await Workspace.attachCardMilestone(serverId, boardId, card.id, milestone.value);
          toast('Filed under the milestone');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The card could not be filed.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Milestone'), milestone),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'File')),
  });

  (async () => {
    try {
      const board = await Workspace.board(serverId, boardId);
      for (const entry of board.milestones || []) {
        milestone.appendChild(el('option', { value: entry.id }, entry.name));
      }
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'The milestones could not be read.';
    }
  })();
}

export default { boardsList, boardsDetail };
