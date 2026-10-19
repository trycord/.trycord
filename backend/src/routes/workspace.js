// /api/servers/:serverId — the collaboration workspace.
//
// Spaces, collaborative documents, boards, events and polls, all scoped to one
// community. The router is mounted under the community prefix, so it inherits
// the one access chain every other community route uses: authenticate,
// resolve the community, then require membership.
//
// The permissions each write needs come from the community's own roles
// (services/permissions.js). The mapping, and why:
//
//   MANAGE_CHANNELS  spaces, boards, events - the structure of the community
//   MEMORIZE        writing a document or a comment on one - the permission
//                   that already means "create and edit community knowledge"
//   SEND_MESSAGES   posting a card, an RSVP, a comment, a vote
//   MANAGE_MESSAGES acting on somebody else's content
//
// There is no permission of its own here: a role that grants MEMORIZE grants
// it here too, and a role that does not cannot reach these routes.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError, wrap } = require('../errors');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const events = require('../services/events');
const spaces = require('../services/workspace/spaces');
const documents = require('../services/workspace/documents');
const boards = require('../services/workspace/boards');
const workspaceEvents = require('../services/workspace/events');
const polls = require('../services/workspace/polls');

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer);

// wrap() answers a service refusal with the error envelope. A refusal that
// carries structured details - a conflict, which is useless without the
// current revision - needs those details in the answer as well, so this is
// wrap() with that one difference.
function wrapDetailed(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (e) {
      if (e && e.code && e.details) return fail(res, e.code, e.message, undefined, e.details);
      serviceError(res, e);
    }
  };
}

// Whether this caller manages the community's content: the owner, or somebody
// who holds MANAGE_MESSAGES. It is the same bar the message routes use for
// acting on somebody else's message.
function isContentManager(req) {
  if (!req.access) return false;
  if (req.access.isOwner) return true;
  return req.access.permissions.includes('*') || req.access.permissions.includes('MANAGE_MESSAGES');
}

// The caller's own id and whether they own the community.
function viewer(req) {
  return { id: req.user.id, isOwner: !!(req.access && req.access.isOwner) };
}

// ---- spaces -----------------------------------------------------------

router.get('/spaces', requireMember, wrap(async (req, res) => {
  const v = viewer(req);
  res.json(await spaces.list(req.server.id, v.id, v.isOwner));
}));

router.post('/spaces', requirePerm('MANAGE_CHANNELS'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:space' }),
  wrap(async (req, res) => {
    const v = viewer(req);
    const space = await spaces.create(req.server.id, req.user.id, v.isOwner, req.body || {});
    events.emit(req.server.id, 'workspace_space_created', { spaceId: space.id });
    res.status(201).json(space);
  }));

router.get('/spaces/:spaceId', requireMember, wrap(async (req, res) => {
  const v = viewer(req);
  res.json(await spaces.get(req.server.id, req.params.spaceId, v.id, v.isOwner));
}));

router.patch('/spaces/:spaceId', requirePerm('MANAGE_CHANNELS'), wrap(async (req, res) => {
  const v = viewer(req);
  const space = await spaces.update(req.server.id, req.params.spaceId, req.user.id, v.isOwner, req.body || {});
  events.emit(req.server.id, 'workspace_space_updated', { spaceId: space.id });
  res.json(space);
}));

router.delete('/spaces/:spaceId', requirePerm('MANAGE_CHANNELS'), wrap(async (req, res) => {
  const v = viewer(req);
  const out = await spaces.remove(req.server.id, req.params.spaceId, req.user.id, v.isOwner);
  events.emit(req.server.id, 'workspace_space_deleted', { spaceId: out.id });
  res.json(out);
}));

router.post('/spaces/:spaceId/items', requirePerm('MANAGE_CHANNELS'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:space' }),
  wrap(async (req, res) => {
    const v = viewer(req);
    const item = await spaces.addItem(req.server.id, req.params.spaceId, req.user.id, v.isOwner, req.body || {});
    res.status(201).json(item);
  }));

router.delete('/spaces/:spaceId/items/:itemId', requirePerm('MANAGE_CHANNELS'), wrap(async (req, res) => {
  const v = viewer(req);
  res.json(await spaces.removeItem(req.server.id, req.params.spaceId, req.params.itemId, req.user.id, v.isOwner));
}));

router.post('/spaces/:spaceId/reorder', requirePerm('MANAGE_CHANNELS'), wrap(async (req, res) => {
  const v = viewer(req);
  const items = await spaces.reorderItems(
    req.server.id, req.params.spaceId, req.user.id, v.isOwner, (req.body || {}).orderedIds
  );
  res.json({ items });
}));

// ---- documents --------------------------------------------------------

router.get('/documents', requireMember, wrap(async (req, res) => {
  res.json(await documents.list(req.server.id, {
    limit: req.query.limit,
    offset: req.query.offset,
  }));
}));

// Declared before /documents/:documentId, so "search" is not read as a
// document id.
router.get('/documents/search', requireMember, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return fail(res, 'VALIDATION_ERROR', 'type at least 2 characters to search');
  res.json(await documents.search(req.server.id, q, req.query.limit));
}));

router.post('/documents', requirePerm('MEMORIZE'),
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:document' }),
  wrap(async (req, res) => {
    const doc = await documents.create(req.server.id, req.user.id, req.body || {});
    events.emit(req.server.id, 'workspace_document_created', { documentId: doc.id });
    res.status(201).json(doc);
  }));

router.get('/documents/:documentId', requireMember, wrap(async (req, res) => {
  const doc = await documents.get(req.server.id, req.params.documentId);
  if (!doc) return fail(res, 'NOT_FOUND', 'document not found');
  res.json(doc);
}));

router.put('/documents/:documentId', requirePerm('MEMORIZE'),
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:document' }),
  wrapDetailed(async (req, res) => {
    const body = req.body || {};
    const doc = await documents.save(req.server.id, req.params.documentId, req.user.id, {
      title: body.title,
      body: body.body,
      revision: body.revision,
      overwrite: body.overwrite === true,
    });
    events.emit(req.server.id, 'workspace_document_saved', { documentId: doc.id, revision: doc.revision });
    res.json(doc);
  }));

router.get('/documents/:documentId/revisions', requireMember, wrap(async (req, res) => {
  res.json(await documents.revisions(req.server.id, req.params.documentId, req.query.limit));
}));

router.get('/documents/:documentId/revisions/:revision', requireMember, wrap(async (req, res) => {
  res.json(await documents.revision(req.server.id, req.params.documentId, req.params.revision));
}));

router.get('/documents/:documentId/compare', requireMember, wrap(async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (from === undefined || to === undefined) {
    return fail(res, 'VALIDATION_ERROR', 'from and to are required');
  }
  res.json(await documents.compare(req.server.id, req.params.documentId, from, to));
}));

router.post('/documents/:documentId/restore', requirePerm('MEMORIZE'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:document' }),
  wrapDetailed(async (req, res) => {
    const body = req.body || {};
    const doc = await documents.restore(req.server.id, req.params.documentId, req.user.id, body.revision);
    events.emit(req.server.id, 'workspace_document_saved', { documentId: doc.id, revision: doc.revision });
    res.json(doc);
  }));

router.get('/documents/:documentId/comments', requireMember, wrap(async (req, res) => {
  res.json(await documents.comments(req.server.id, req.params.documentId));
}));

router.post('/documents/:documentId/comments', requirePerm('SEND_MESSAGES'),
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:document' }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const comment = await documents.comment(req.server.id, req.params.documentId, req.user.id, {
      body: body.body,
      blockId: body.blockId,
    });
    res.status(201).json(comment);
  }));

// Resolving a comment is the author's, or somebody who manages the
// community's content.
router.post('/documents/:documentId/comments/:commentId/resolve', requireMember, wrap(async (req, res) => {
  const body = req.body || {};
  const resolved = body.resolved !== false;
  const comments = await documents.comments(req.server.id, req.params.documentId);
  const target = comments.find((c) => String(c.id) === String(req.params.commentId));
  if (!target) return fail(res, 'NOT_FOUND', 'comment not found');
  if (String(target.authorId) !== String(req.user.id) && !isContentManager(req)) {
    return fail(res, 'PERMISSION_DENIED', 'only the author or a moderator can resolve this comment');
  }
  res.json(await documents.resolveComment(
    req.server.id, req.params.documentId, req.params.commentId, req.user.id, resolved
  ));
}));

router.get('/documents/:documentId/links', requireMember, wrap(async (req, res) => {
  res.json(await documents.links(req.server.id, req.params.documentId));
}));

router.post('/documents/:documentId/links', requirePerm('MEMORIZE'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:document' }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const link = await documents.addLink(req.server.id, req.params.documentId, req.user.id, {
      kind: body.kind,
      targetId: body.targetId,
      url: body.url,
      label: body.label,
    });
    res.status(201).json(link);
  }));

// ---- boards -----------------------------------------------------------

router.get('/boards', requireMember, wrap(async (req, res) => {
  res.json(await boards.list(req.server.id));
}));

router.post('/boards', requirePerm('MANAGE_CHANNELS'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:board' }),
  wrap(async (req, res) => {
    const board = await boards.create(req.server.id, req.user.id, req.body || {});
    events.emit(req.server.id, 'workspace_board_created', { boardId: board.id });
    res.status(201).json(board);
  }));

router.get('/boards/:boardId', requireMember, wrap(async (req, res) => {
  res.json(await boards.get(req.server.id, req.params.boardId));
}));

router.post('/boards/:boardId/columns', requirePerm('MANAGE_CHANNELS'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:board' }),
  wrap(async (req, res) => {
    const column = await boards.createColumn(req.server.id, req.params.boardId, req.user.id, req.body || {});
    res.status(201).json(column);
  }));

router.post('/boards/:boardId/milestones', requirePerm('MANAGE_CHANNELS'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:board' }),
  wrap(async (req, res) => {
    const milestone = await boards.createMilestone(req.server.id, req.params.boardId, req.user.id, req.body || {});
    res.status(201).json(milestone);
  }));

router.get('/boards/:boardId/cards/:cardId', requireMember, wrap(async (req, res) => {
  res.json(await boards.card(req.server.id, req.params.boardId, req.params.cardId));
}));

router.get('/boards/:boardId/cards/:cardId/activity', requireMember, wrap(async (req, res) => {
  res.json(await boards.activity(req.server.id, req.params.boardId, req.params.cardId));
}));

router.post('/boards/:boardId/cards', requirePerm('SEND_MESSAGES'),
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:board' }),
  wrap(async (req, res) => {
    const card = await boards.createCard(req.server.id, req.params.boardId, req.user.id, req.body || {});
    events.emit(req.server.id, 'workspace_card_created', { boardId: card.boardId, cardId: card.id });
    res.status(201).json(card);
  }));

// A card made from a message. The path is a literal so that it cannot be
// read as a card id.
router.post('/boards/:boardId/cards/from-message', requirePerm('SEND_MESSAGES'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:board' }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const card = await boards.fromMessage(req.server.id, req.params.boardId, req.user.id, {
      messageId: body.messageId,
      columnId: body.columnId,
      title: body.title,
      body: body.body,
    });
    events.emit(req.server.id, 'workspace_card_created', { boardId: card.boardId, cardId: card.id });
    res.status(201).json(card);
  }));

// Editing a card: the author, or somebody who manages the community's
// content. The version in the body is the precondition, so two people
// editing the same card produce one edit and one conflict.
router.patch('/boards/:boardId/cards/:cardId', requireMember,
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:board' }),
  wrapDetailed(async (req, res) => {
    const body = req.body || {};
    const current = await boards.card(req.server.id, req.params.boardId, req.params.cardId);
    if (String(current.createdBy) !== String(req.user.id) && !isContentManager(req)) {
      return fail(res, 'PERMISSION_DENIED', 'only the author or a moderator can edit this card');
    }
    const card = await boards.updateCard(req.server.id, req.params.boardId, req.params.cardId, req.user.id, {
      title: body.title,
      body: body.body,
      assigneeId: body.assigneeId,
      dueAt: body.dueAt,
      dueTimezone: body.dueTimezone,
      priority: body.priority,
      status: body.status,
      labels: body.labels,
      version: body.version,
    });
    events.emit(req.server.id, 'workspace_card_updated', { boardId: card.boardId, cardId: card.id, version: card.version });
    res.json(card);
  }));

router.post('/boards/:boardId/cards/:cardId/move', requireMember,
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:board' }),
  wrapDetailed(async (req, res) => {
    const body = req.body || {};
    const current = await boards.card(req.server.id, req.params.boardId, req.params.cardId);
    if (String(current.createdBy) !== String(req.user.id) && !isContentManager(req)) {
      return fail(res, 'PERMISSION_DENIED', 'only the author or a moderator can move this card');
    }
    const card = await boards.moveCard(req.server.id, req.params.boardId, req.params.cardId, req.user.id, {
      columnId: body.columnId,
      position: body.position,
      version: body.version,
    });
    events.emit(req.server.id, 'workspace_card_moved', { boardId: card.boardId, cardId: card.id, version: card.version });
    res.json(card);
  }));

router.post('/boards/:boardId/cards/:cardId/links', requireMember,
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:board' }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const current = await boards.card(req.server.id, req.params.boardId, req.params.cardId);
    if (String(current.createdBy) !== String(req.user.id) && !isContentManager(req)) {
      return fail(res, 'PERMISSION_DENIED', 'only the author or a moderator can link from this card');
    }
    const card = await boards.addLink(req.server.id, req.params.boardId, req.params.cardId, req.user.id, {
      kind: body.kind,
      targetId: body.targetId,
    });
    res.status(201).json(card);
  }));

router.post('/boards/:boardId/cards/:cardId/milestones', requireMember,
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:board' }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const current = await boards.card(req.server.id, req.params.boardId, req.params.cardId);
    if (String(current.createdBy) !== String(req.user.id) && !isContentManager(req)) {
      return fail(res, 'PERMISSION_DENIED', 'only the author or a moderator can change this card');
    }
    const card = await boards.attachMilestone(
      req.server.id, req.params.boardId, req.params.cardId, req.user.id, body.milestoneId
    );
    res.status(201).json(card);
  }));

// ---- events -----------------------------------------------------------

router.get('/events', requireMember, wrap(async (req, res) => {
  res.json(await workspaceEvents.list(req.server.id));
}));

router.post('/events', requirePerm('MANAGE_CHANNELS'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:event' }),
  wrap(async (req, res) => {
    const event = await workspaceEvents.create(req.server.id, req.user.id, req.body || {});
    events.emit(req.server.id, 'workspace_event_created', { eventId: event.id });
    res.status(201).json(event);
  }));

router.get('/events/:eventId', requireMember, wrap(async (req, res) => {
  res.json(await workspaceEvents.get(req.server.id, req.params.eventId));
}));

router.patch('/events/:eventId', requirePerm('MANAGE_CHANNELS'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:event' }),
  wrap(async (req, res) => {
    const event = await workspaceEvents.update(req.server.id, req.params.eventId, req.user.id, req.body || {});
    events.emit(req.server.id, 'workspace_event_updated', { eventId: event.id });
    res.json(event);
  }));

router.post('/events/:eventId/rsvp', requirePerm('SEND_MESSAGES'),
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:event' }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const rsvp = await workspaceEvents.rsvp(req.server.id, req.params.eventId, req.user.id, body.status);
    res.json(rsvp);
  }));

// The attendance list. A member of the community may see it unless the
// event asks for organiser-only attendance, in which case the counts are
// public and the names are not.
router.get('/events/:eventId/attendance', requireMember, wrap(async (req, res) => {
  const event = await workspaceEvents.get(req.server.id, req.params.eventId);
  const isOrganiser = isContentManager(req) || String(event.createdBy) === String(req.user.id);
  res.json(await workspaceEvents.attendance(req.server.id, req.params.eventId, isOrganiser));
}));

// ---- polls ------------------------------------------------------------

router.get('/polls', requireMember, wrap(async (req, res) => {
  res.json(await polls.list(req.server.id));
}));

router.post('/polls', requirePerm('SEND_MESSAGES'),
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:poll' }),
  wrap(async (req, res) => {
    const poll = await polls.create(req.server.id, req.user.id, req.body || {});
    events.emit(req.server.id, 'workspace_poll_created', { pollId: poll.id });
    res.status(201).json(poll);
  }));

router.get('/polls/:pollId', requireMember, wrap(async (req, res) => {
  res.json(await polls.get(req.server.id, req.params.pollId));
}));

router.post('/polls/:pollId/vote', requirePerm('SEND_MESSAGES'),
  rateLimit({ windowMs: 60000, max: 120, key: 'workspace:poll' }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const poll = await polls.vote(req.server.id, req.params.pollId, req.user.id, { choices: body.choices });
    res.json(poll);
  }));

// The results. Before the poll closes only the person who set it up and the
// people who manage the community's content may see the tally; after it
// closes everybody in the community may. An anonymous poll never names its
// voters, before the close or after it.
router.get('/polls/:pollId/results', requireMember, wrap(async (req, res) => {
  const poll = await polls.get(req.server.id, req.params.pollId);
  const isCreator = String(poll.createdBy) === String(req.user.id);
  const canSeeIntermediate = isCreator || isContentManager(req);
  res.json(await polls.results(req.server.id, req.params.pollId, {
    canSeeIntermediate,
    recount: req.query.recount === '1' || req.query.recount === 'true',
  }));
}));

router.post('/polls/:pollId/close', requireMember,
  rateLimit({ windowMs: 60000, max: 60, key: 'workspace:poll' }),
  wrap(async (req, res) => {
    const poll = await polls.get(req.server.id, req.params.pollId);
    if (String(poll.createdBy) !== String(req.user.id) && !isContentManager(req)) {
      return fail(res, 'PERMISSION_DENIED', 'only the author or a moderator can close this poll');
    }
    const out = await polls.close(req.server.id, req.params.pollId, req.user.id);
    events.emit(req.server.id, 'workspace_poll_closed', { pollId: poll.id });
    res.json(out);
  }));

module.exports = router;
