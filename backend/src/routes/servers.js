// /api/servers — thin controllers over the membership/server services.
// Access chain: auth -> resolveServer -> requireMember / requirePerm / requireOwner.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { resolveServer, requireMember, requireOwner, requirePerm, requireAnyPerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const servers = require('../services/servers');
const memberships = require('../services/memberships');
const events = require('../services/events');
const permissions = require('../services/permissions');
const uploads = require('../services/uploads');
const { singleImage } = require('../middleware/upload');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res, next) => {
  try {
    const list = await servers.mine(req.user.id);
    // The federation flag is not part of the community list the service
    // builds, so it is read here and attached to the answer: a community that
    // has withdrawn from federation is one the client has to be able to say
    // so rather than to guess at.
    const flags = await federationFlags(list.map((row) => row.id));
    for (const row of list) row.federated = flags.get(String(row.id)) !== false;
    res.json(list);
  } catch (e) { next(e); }
});

// Server creation is write-heavy (server + membership + roles + category +
// channel in one transaction); cap it so a burst cannot hammer the DB.
router.post('/', auth.requireVerified, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const { name, description, joinCode, isPublic, isDiscoverable } = req.body || {};
    res.json(await servers.create({ name, description, joinCode, isPublic, isDiscoverable }, req.user));
  } catch (e) { serviceError(res, e); }
});

// Safe pre-join preview for code holders (subset only — no members, messages,
// or settings). Rate limited because a join code is 32 bits, so an
// unthrottled endpoint is a working oracle for guessing one.
router.get('/by-code/:code', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const srv = await db.get(
      `SELECT s.id, s.name, s.description, s.is_public, s.is_discoverable, s.created_at,
        (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
      FROM servers s WHERE s.join_code = ?`,
      [String(req.params.code).toLowerCase().trim()]
    );
    if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
    res.json(srv);
  } catch (e) { next(e); }
});

// Legacy permanent-code join (kept for back-compat; invites are the real system).
router.post('/join/:code', auth.requireVerified, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const out = await memberships.joinByCode(req.params.code, req.user);
    if (out && out.serverId) events.emit(out.serverId, 'member_joined', { userId: String(req.user.id) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

router.get('/:id', resolveServer, requireMember, async (req, res, next) => {
  try {
    // req.access already holds this request's computed permission set.
    const detail = await servers.detail(req.server.id, req.user.id, req.access && req.access.permissions);
    const flags = await federationFlags([req.server.id]);
    res.json(Object.assign(detail || {}, { federated: flags.get(String(req.server.id)) !== false }));
  } catch (e) { next(e); }
});

// The federation flag of the given communities.
//
// One query for the whole list: it is one column, and the answer is needed
// for every community the client is holding. A community that is missing from
// the answer is federated, because that is what a community is unless it has
// said otherwise.
async function federationFlags(serverIds) {
  const ids = (serverIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await db.all(
    'SELECT id, federated FROM servers WHERE id IN (' + ids.map(() => '?').join(',') + ')',
    ids
  );
  const out = new Map();
  for (const row of rows) out.set(String(row.id), !!row.federated);
  return out;
}

router.patch('/:id', resolveServer, auth.requireVerified, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const { name, description, isPublic, isDiscoverable, federated } = req.body || {};
    if (federated !== undefined && typeof federated !== 'boolean') {
      return fail(res, 'VALIDATION_ERROR', 'federated must be a boolean');
    }
    // The identity fields are the service's to write, because the name also
    // decides the community's address. The federation flag is a column of
    // its own and is written here, so that turning federation off does not
    // have to touch anything else about the community.
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (isPublic !== undefined) patch.isPublic = isPublic;
    if (isDiscoverable !== undefined) patch.isDiscoverable = isDiscoverable;
    if (Object.keys(patch).length) await servers.update(req.server.id, patch);
    if (federated !== undefined) {
      await db.run('UPDATE servers SET federated = ? WHERE id = ?', [federated ? 1 : 0, req.server.id]);
    }
    if (!Object.keys(patch).length && federated === undefined) {
      return fail(res, 'VALIDATION_ERROR', 'Nothing to update');
    }
    const detail = await servers.detail(req.server.id, req.user.id, req.access && req.access.permissions);
    const flags = await federationFlags([req.server.id]);
    events.emit(req.server.id, 'server_updated', { server: { id: detail.id, name: detail.name } });
    res.json(Object.assign(detail, { federated: flags.get(String(req.server.id)) !== false }));
  } catch (e) { serviceError(res, e); }
});

// The community's settings, as they stand.
//
// The PATCH route below writes these, so a member who can manage the
// community has to be able to read them back. A member who cannot manage it
// may read them too: the guidelines and the welcome text are what the
// community shows its own members, and a member who cannot see them cannot
// follow them.
router.get('/:id/settings', resolveServer, requireMember, async (req, res, next) => {
  try {
    res.json(await servers.settings(req.server.id));
  } catch (e) { next(e); }
});

// Community settings: welcome content, guidelines, notification defaults,
// interaction settings. All server-side enforced with MANAGE_SERVER permission.
router.patch('/:id/settings', resolveServer, auth.requireVerified, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const { welcome_content, welcome_enabled, guidelines, notification_defaults, interaction_settings } = req.body || {};
    const sets = [];
    const vals = [];
    if (welcome_content !== undefined) {
      if (typeof welcome_content !== 'string') throw { code: 'VALIDATION_ERROR', message: 'welcome_content must be a string' };
      sets.push('welcome_content = ?');
      vals.push(String(welcome_content).slice(0, 5000));
    }
    if (welcome_enabled !== undefined) {
      if (typeof welcome_enabled !== 'boolean') throw { code: 'VALIDATION_ERROR', message: 'welcome_enabled must be a boolean' };
      sets.push('welcome_enabled = ?');
      vals.push(welcome_enabled ? 1 : 0);
    }
    if (guidelines !== undefined) {
      if (typeof guidelines !== 'string') throw { code: 'VALIDATION_ERROR', message: 'guidelines must be a string' };
      sets.push('guidelines = ?');
      vals.push(String(guidelines).slice(0, 5000));
    }
    if (notification_defaults !== undefined) {
      if (typeof notification_defaults !== 'string') throw { code: 'VALIDATION_ERROR', message: 'notification_defaults must be a string' };
      sets.push('notification_defaults = ?');
      vals.push(notification_defaults);
    }
    if (interaction_settings !== undefined) {
      if (typeof interaction_settings !== 'string') throw { code: 'VALIDATION_ERROR', message: 'interaction_settings must be a string' };
      sets.push('interaction_settings = ?');
      vals.push(interaction_settings);
    }
    if (!sets.length) throw { code: 'VALIDATION_ERROR', message: 'Nothing to update' };
    vals.push(req.server.id);
    await db.run(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, vals);
    const detail = await servers.detail(req.server.id, req.user.id, req.access && req.access.permissions);
    events.emit(req.server.id, 'community_settings_updated', { server: detail.id });
    res.json(detail);
  } catch (e) { serviceError(res, e); }
});

router.delete('/:id', resolveServer, auth.requireVerified, requireOwner, async (req, res, next) => {
  try {
    res.json(await servers.remove(req.server.id));
  } catch (e) { next(e); }
});

// Community identity media. Uploading replaces whatever was there and frees
// the old file, exactly like a profile image - a community has one icon and one
// banner, not a history of them.
const SERVER_MEDIA_KINDS = ['icon', 'banner'];

// NOT async: this is a factory that returns the handler. Declaring it async
// would make it return a Promise, and Express would reject the route with
// "argument handler must be a function".
function serverMediaRoute(kind) {
  return async (req, res, next) => {
    try {
      if (!req.file || !req.file.buffer) {
        return fail(res, 'VALIDATION_ERROR', 'send the image as a multipart field named "file"');
      }
      const out = await uploads.storeServerMedia({
        serverId: req.server.id, kind,
        buffer: req.file.buffer,
        originalName: req.file.originalname || '',
      });
      if (out.error) return fail(res, out.error, out.message);
      const column = kind === 'icon' ? 'icon_url' : 'banner_url';
      const prev = await db.get(`SELECT ${column} AS v FROM servers WHERE id = ?`, [req.server.id]);
      await db.run(`UPDATE servers SET ${column} = ? WHERE id = ?`, [out.url, req.server.id]);
      if (prev && prev.v && prev.v !== out.url) await uploads.removeServerFile(prev.v).catch(() => {});
      res.status(201).json({ kind, url: out.url, mime: out.mime, size: out.size });
    } catch (e) { serviceError(res, e); }
  };
}

function serverMediaDelete(kind) {
  return async (req, res, next) => {
    try {
      const column = kind === 'icon' ? 'icon_url' : 'banner_url';
      const prev = await db.get(`SELECT ${column} AS v FROM servers WHERE id = ?`, [req.server.id]);
      await db.run(`UPDATE servers SET ${column} = NULL WHERE id = ?`, [req.server.id]);
      if (prev && prev.v) await uploads.removeServerFile(prev.v).catch(() => {});
      res.json({ ok: true, kind });
    } catch (e) { serviceError(res, e); }
  };
}

// Mounted at /api/servers (no :serverId) because a community icon is public
// identity shown in browse, where the viewer is not a member and cannot resolve
// the community first. Any authenticated user may load one; the id must carry
// the sv- prefix enforced by storeServerMedia, so this cannot serve a message
// attachment.
router.get('/media/:id', auth, async (req, res, next) => {
  try {
    const row = await uploads.serverMedia(req.params.id);
    if (!row) return fail(res, 'NOT_FOUND', 'image not found');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = uploads.openServerMedia(row);
    stream.on('error', () => { if (!res.headersSent) fail(res, 'NOT_FOUND', 'image not found'); });
    stream.pipe(res);
  } catch (e) { next(e); }
});

// ---- community identity media (per-community routes) ----------------------
// MANAGE_SERVER, matching every other settings mutation, and declared BEFORE
// the '/:id' handlers so these paths are not captured as an id.
for (const kind of SERVER_MEDIA_KINDS) {
  router.post('/:id/' + kind, resolveServer, requirePerm('MANAGE_SERVER'), singleImage, serverMediaRoute(kind));
  router.delete('/:id/' + kind, resolveServer, requirePerm('MANAGE_SERVER'), serverMediaDelete(kind));
}

// ---- the words a community refuses -----------------------------------------
// MANAGE_SERVER, and declared before the '/:id' handlers so these paths are
// not captured as an id.
router.get('/:id/blocked-terms', resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const rules = require('../services/communityRules');
    res.json({ terms: await rules.blockedTerms(req.server.id) });
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/blocked-terms', resolveServer, requirePerm('MANAGE_SERVER'),
  rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
    try {
      const term = String(((req.body || {}).term) || '').trim().toLowerCase();
      if (!term) return fail(res, 'VALIDATION_ERROR', 'a word is needed');
      if (term.length > 128) return fail(res, 'VALIDATION_ERROR', 'that word is too long');
      const { uuid, now } = require('../util');
      await db.run(
        'INSERT INTO blocked_terms (id, server_id, term, created_at) VALUES (?, ?, ?, ?)',
        [uuid(), req.server.id, term, now()]
      ).catch((e) => {
        // The same word twice is not an error: it is the same word.
        if (!/UNIQUE|unique|ER_DUP_ENTRY|SQLITE_CONSTRAINT_UNIQUE/i.test(String(e && e.message))) throw e;
      });
      const rules = require('../services/communityRules');
      res.status(201).json({ ok: true, terms: await rules.blockedTerms(req.server.id) });
    } catch (e) { serviceError(res, e); }
  });

router.delete('/:id/blocked-terms/:term', resolveServer, requirePerm('MANAGE_SERVER'),
  rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
    try {
      const term = String(req.params.term || '').trim().toLowerCase();
      await db.run('DELETE FROM blocked_terms WHERE server_id = ? AND term = ?', [req.server.id, term]);
      const rules = require('../services/communityRules');
      res.json({ ok: true, terms: await rules.blockedTerms(req.server.id) });
    } catch (e) { serviceError(res, e); }
  });

// ---- what a member can actually do here ------------------------------------
// The moderation family: somebody who may remove a member, ban one, or run
// the community may look at what anybody in it can do.
router.get('/:id/members/:userId/permissions', resolveServer, requireAnyPerm(
  ['KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_SERVER']), async (req, res, next) => {
  try {
    const target = String(req.params.userId || '');
    const { isMember } = require('../util');
    if (!(await isMember(target, req.server.id))) {
      return fail(res, 'NOT_A_MEMBER', 'that person is not in this community');
    }
    const preview = require('../services/community/effectivePermissions');
    res.json(await preview.preview(req.server, target));
  } catch (e) { serviceError(res, e); }
});

router.get('/:id/members', resolveServer, requireMember, async (req, res, next) => {
  try {
    // Paged. This previously returned the entire roster for any member of
    // the community with no LIMIT anywhere, and the paired role query read
    // every role assignment in the community regardless. Both are now bounded
    // and the role lookup is scoped to the page returned.
    //
    // The response is an envelope - { items, total, hasMore, limit, offset } -
    // so a client can render "showing N of TOTAL" and offer a further page
    // without downloading the whole roster to count it. The default page is
    // generous because the desktop client still derives some role membership
    // from what it holds, but it is a page, not the whole roster.
    const hasPaging = req.query.limit !== undefined || req.query.offset !== undefined || req.query.q !== undefined;
    res.json(await memberships.list(req.server.id, {
      limit: hasPaging ? (req.query.limit === undefined ? 50 : req.query.limit) : 200,
      offset: req.query.offset,
      search: req.query.q,
    }));
  } catch (e) { next(e); }
});

router.post('/:id/leave', resolveServer, async (req, res, next) => {
  try {
    res.json(await memberships.leave(req.server.id, req.user.id));
  } catch (e) { serviceError(res, e); }
});

// Ownership transfer. requireOwner is the authorisation gate, and the service
// re-checks it inside the transaction rather than trusting middleware.
router.post('/:id/transfer', resolveServer, auth.requireVerified, requireOwner, async (req, res, next) => {
  try {
    const { userId } = req.body || {};
    res.json(await servers.transferOwnership(req.server.id, req.user.id, userId));
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/kick', resolveServer, auth.requireVerified, requirePerm('KICK_MEMBERS'), async (req, res, next) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.kick(req.server.id, req.user.id, userId));
  } catch (e) { serviceError(res, e); }
});

// Ban: persistent per-server ban (member removed now, rejoin blocked until
// lifted/expired). Hierarchy is enforced in the service; BAN_MEMBERS gates.
router.post('/:id/ban', resolveServer, auth.requireVerified, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    const { userId, reason, minutes } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.ban(req.server.id, req.user.id, userId, { reason, minutes }));
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/unban', resolveServer, auth.requireVerified, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    const { userId, reason } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.unban(req.server.id, req.user.id, userId, reason));
  } catch (e) { serviceError(res, e); }
});

router.get('/:id/bans', resolveServer, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    res.json(await memberships.listBans(req.server.id));
  } catch (e) { next(e); }
});

// Timeout: member stays but cannot post until it lapses. minutes null/0
// clears. Enforced on every message send, server-side.
router.post('/:id/timeout', resolveServer, auth.requireVerified, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    const { userId, minutes } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.timeout(req.server.id, req.user.id, userId, minutes));
  } catch (e) { serviceError(res, e); }
});

// Set/clear a member nickname. Anyone may set their own; staff (KICK_MEMBERS)
// may set any member's. resolver + memberships gate membership itself.
router.patch('/:id/members/:userId/nickname', resolveServer, auth.requireVerified, requireMember, async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    const mine = String(targetId) === String(req.user.id);
    if (!mine) {
      const perms = await permissions.effectivePermissions(req.user.id, req.server.id);
      if (!perms.has('*') && !perms.has('KICK_MEMBERS')) {
        return fail(res, 'PERMISSION_DENIED', 'you can only change your own nickname here');
      }
    }
    const out = await memberships.setNickname(req.server.id, targetId, (req.body || {}).nickname);
    events.emit(req.server.id, 'member_updated', { userId: String(targetId) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// GET /api/servers/:id/export - community portability manifest (admin only)
router.get('/:id/export', resolveServer, auth.requireVerified, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const exporter = require('../services/export');
    const payload = await exporter.exportCommunity(req.server.id, req.user.id);
    res.status(200).set('Cache-Control', 'no-store').json(payload);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
