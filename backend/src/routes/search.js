// GET /api/search — message search across communities the requester
// belongs to. Membership-scoped: a row is returned only for channels in
// servers where the requester is a member (same rule as history reads).
//
// A query may carry filters - from:, in:, before:, after:, has:, type:, is: -
// and the filters are applied together with the membership check, never
// before it: a filter narrows what a reader may see and cannot widen it.
//
// The reader's own saved searches and their own recent queries live here too:
// both are per-reader, and both are answered from the owner alone.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const { escapeLike } = require('../util');
const settings = require('../services/settings');
const searchFilters = require('../services/search-filters');
const savedSearches = require('../services/saved-searches');
const searchHistory = require('../services/search-history');
const { now } = require('../util');

const router = express.Router();
router.use(auth);

router.get('/', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    settings.get('search.provider');
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 2) return fail(res, 'VALIDATION_ERROR', 'type at least 2 characters to search');
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10) || 25, 1), 50);
    const serverId = req.query.serverId ? String(req.query.serverId) : null;

    // The filters, parsed before anything is looked up. A filter this build
    // does not know is a search term; a filter it knows with a value it does
    // not accept is refused rather than quietly matching nothing.
    let parsed;
    try {
      parsed = searchFilters.parse(q);
    } catch (e) {
      return fail(res, 'VALIDATION_ERROR', e.message);
    }

    const rows = await runSearch(parsed, { userId: req.user.id, serverId, limit });

    // The reader's own recent searches, recorded after the answer so a
    // refused search is not in the history.
    await searchHistory.record(req.user.id, q);

    // What the server understood by the query. The body stays an array, the
    // shape the client already reads.
    res.set('X-Trycord-Search-Filters', JSON.stringify(searchFilters.describe(parsed.filters)));
    res.json(rows);
  } catch (e) { next(e); }
});

// The search itself.
//
// The in-house index, when it is there. It is permission-scoped in the index
// itself, and the filters are part of the same statement, so a query cannot
// return a message the reader may not see and a filter cannot widen what
// they may see.
async function runSearch(parsed, options) {
  const index = require('../services/search-index');
  if (await index.available()) {
    const rows = await index.findFiltered(parsed, options);
    // Community documents are found by the same terms. They are a different
    // kind of thing, so they carry a kind, and the client decides how to
    // present them. A document is never returned for a reader who is not in
    // the community it belongs to.
    //
    // A filter is about messages - a document has no author, no channel and
    // no attachments - so a filtered search answers with messages only.
    let documents = [];
    if (!parsed.hasFilters) {
      try {
        documents = await index.findDocuments(parsed.terms.join(' '), options);
      } catch { /* an instance without documents still searches messages */ }
    }
    return rows.concat(documents);
  }
  return scanMessages(parsed, options);
}

// The slow path: the same filters, without the index.
//
// SQLite uses an FTS5 virtual index over messages.content (kept in sync via
// triggers); dialects without FTS fall back to a LIKE query. Always
// membership-scoped, and always with the filters.
async function scanMessages(parsed, options) {
  const index = require('../services/search-index');
  const userId = options.userId;
  const serverId = options.serverId;
  const limit = options.limit;
  const terms = parsed.terms.join(' ');

  const columns = `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
          ch.name AS channel_name, ch.server_id AS server_id, s.name AS server_name`;
  const joins = `FROM messages m
        JOIN users u ON u.id = m.author_id
        JOIN channels ch ON ch.id = m.channel_id
        JOIN servers s ON s.id = ch.server_id
        JOIN server_members sm ON sm.server_id = ch.server_id AND sm.user_id = ?`;

  let useFts = false;
  try {
    if (db.dialect === 'sqlite') {
      const present = await db.get("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='messages_fts'");
      useFts = !!(present && present.n);
    }
  } catch { useFts = false; }

  if (useFts && terms) {
    const escaped = String(terms).replace(/"/g, '');
    const ftsQ = '"' + escaped + '"';
    const params = [userId, ftsQ];
    let serverFilter = '';
    if (serverId) {
      serverFilter = 'AND ch.server_id = ?';
      params.push(serverId);
    }
    const clauses = index.filterClauses(parsed, params, { userId });
    try {
      return await db.all(
        `${columns} ${joins}
          JOIN messages_fts f ON f.rowid = m.rowid
          WHERE messages_fts MATCH ? ${serverFilter}
          ${clauses.length ? 'AND ' + clauses.join(' AND ') : ''}
          ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`,
        params
      );
    } catch { /* fall through to the LIKE query */ }
  }

  const params = [userId, '%' + escapeLike(terms) + '%'];
  let serverFilter = '';
  if (serverId) {
    serverFilter = 'AND ch.server_id = ?';
    params.push(serverId);
  }
  const clauses = index.filterClauses(parsed, params, { userId });
  return db.all(
    `${columns} ${joins}
      WHERE m.content LIKE ? ESCAPE '!' ${serverFilter}
      ${clauses.length ? 'AND ' + clauses.join(' AND ') : ''}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`,
    params
  );
}

// --- saved searches --------------------------------------------------------

router.get('/saved', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await savedSearches.list(req.user.id));
  } catch (e) { next(e); }
});

router.post('/saved', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.status(201).json(await savedSearches.create(req.user.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

router.get('/saved/:id', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await savedSearches.get(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

router.patch('/saved/:id', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await savedSearches.update(req.user.id, req.params.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

router.delete('/saved/:id', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await savedSearches.remove(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

// --- search history --------------------------------------------------------

router.get('/history', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await searchHistory.list(req.user.id));
  } catch (e) { next(e); }
});

router.delete('/history', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await searchHistory.clear(req.user.id));
  } catch (e) { next(e); }
});

router.delete('/history/:id', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    res.json(await searchHistory.remove(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

// --- where the reader has got to -------------------------------------------

// The read cursor a channel's unread messages are counted from.
//
// The instance has no other record of what a member has read, so this is
// where "is:unread" is answered from. Writing one is writing the reader's
// own state, so it needs their membership of the channel and nothing else.
router.post('/read-cursor', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const channelId = String((req.body && req.body.channelId) || '').trim();
    if (!channelId) return fail(res, 'VALIDATION_ERROR', 'channelId is required');
    const member = await db.get(
      'SELECT 1 AS n FROM server_members sm JOIN channels ch ON ch.server_id = sm.server_id'
      + ' WHERE ch.id = ? AND sm.user_id = ?',
      [channelId, req.user.id]
    );
    if (!member) return fail(res, 'NOT_FOUND', 'no such channel');

    const readAt = String((req.body && req.body.readAt) || '').trim();
    const at = readAt && Number.isFinite(Date.parse(readAt))
      ? new Date(readAt).toISOString()
      : now();
    await db.upsert(
      'channel_read_cursors',
      ['user_id', 'channel_id', 'last_read_at'],
      [req.user.id, channelId, at],
      ['user_id', 'channel_id'],
      { last_read_at: db.newRef('last_read_at') }
    );
    res.json({ channelId, lastReadAt: at });
  } catch (e) { next(e); }
});

module.exports = router;
