// The bot-facing API.
//
// This is the one route in the server authenticated by something other than a
// user session: an application presents its bearer token. Everything after that
// is the ordinary message pipeline - the same channel permission check, the
// same broadcast, the same attachment adoption - so a bot post is a normal
// message that happens to have an application as its author. There is no second
// way to write a message.
const express = require('express');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const db = require('../db');
const { visibleChannel } = require('../util');
const { hasChannelPermission } = require('../services/permissions');
const uploads = require('../services/uploads');
const bots = require('../services/bots');
const events = require('../services/events');
const embeds = require('../services/embeds');
const webhooks = require('../services/webhooks');

const router = express.Router();

// Bearer token in the Authorization header, as "Bearer <token>".
async function requireApp(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = /^Bearer\s+(.+)$/i.exec(header);
    if (!token) return fail(res, 'NOT_FOUND', 'not found');
    const app = await bots.appByToken(token[1]);
    if (!app) return fail(res, 'NOT_FOUND', 'not found');
    // Not req.app: Express puts the application instance there, and anything
    // downstream that reaches for it gets the wrong object.
    req.botApp = app;
    req.serverId = app.server_id;
    next();
  } catch (e) { next(e); }
}

// GET /api/bot/channels/:channelId/messages — the bot's read path.
router.get('/channels/:channelId/messages', requireApp, rateLimit({ windowMs: 60000, max: 60 }),
  async (req, res, next) => {
    try {
      const ch = await visibleChannel(req.params.channelId, req.botApp.owner_user_id, req.serverId);
      if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found');
      const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 100);
      const rows = await db.all(
        'SELECT * FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ' + limit,
        [ch.id]
      );
      res.json(rows.reverse());
    } catch (e) { next(e); }
  });

// POST /api/bot/channels/:channelId/messages — post as the application.
//
// The author is the application's owner rather than a synthetic user: a bot has
// no login, and attributing the message to a real account is what makes it
// attributable and revocable. Deleting the owner removes the bot's ability to
// post, which is the correct behaviour.
router.post('/channels/:channelId/messages', requireApp, rateLimit({ windowMs: 60000, max: 30 }),
  async (req, res, next) => {
    try {
      const ch = await visibleChannel(req.params.channelId, req.botApp.owner_user_id, req.serverId);
      if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found');
      // Permission is evaluated for the owner, so an application cannot post
      // where its owner could not.
      if (!(await hasChannelPermission(req.botApp.owner_user_id, ch.server_id, ch.id, 'SEND_MESSAGES'))) {
        return fail(res, 'PERMISSION_DENIED', 'the application owner cannot post in this channel');
      }
      const content = String((req.body || {}).content || '').trim().slice(0, 2000);
      const ids = uploads.sanitizeIds((req.body || {}).attachmentIds);
      if (!content && !ids.length) {
        return fail(res, 'VALIDATION_ERROR', 'content or an attachment is required');
      }
      const posted = await bots.postAsApp(req.botApp, ch, content);
      if (ids.length) posted.attachments = await uploads.attachToMessage(ids, posted.id, req.botApp.owner_user_id, { channelId: ch.id });
      embeds.queue({ kind: 'channel', messageId: posted.id }, content).then((cards) => {
        if (!cards.length) return;
        events.emitChannel(ch.server_id, ch.id, { type: 'message_embeds', channel_id: ch.id, server_id: ch.server_id, messageId: posted.id, embeds: cards });
      }).catch(() => {});
      webhooks.emit(ch.server_id, 'message.created', {
        serverId: ch.server_id, channelId: ch.id,
        message: { id: posted.id, authorId: req.botApp.owner_user_id, content },
      }).catch(() => {});
      res.status(201).json({
        id: posted.id, channel_id: ch.id, author_id: req.botApp.owner_user_id,
        content, created_at: posted.created_at, seq: posted.seq, attachments: [],
      });
    } catch (e) { next(e); }
  });

// DELETE /api/bot/messages/:messageId — only a message the application posted
// to its own community, and only one carrying its marker.
router.delete('/messages/:messageId', requireApp, rateLimit({ windowMs: 60000, max: 30 }),
  async (req, res, next) => {
    try {
      const row = await db.get('SELECT * FROM messages WHERE id = ?', [req.params.messageId]);
      if (!row || row.channel_id == null) return fail(res, 'NOT_FOUND', 'message not found');
      const ch = await db.get('SELECT * FROM channels WHERE id = ?', [row.channel_id]);
      if (!ch || ch.server_id !== req.serverId) return fail(res, 'NOT_FOUND', 'message not found');
      if (row.author_id !== req.botApp.owner_user_id) {
        return fail(res, 'PERMISSION_DENIED', 'not the application owner\'s message');
      }
      const fileRows = await db.all('SELECT id FROM attachments WHERE message_id = ?', [row.id]);
      await db.run('DELETE FROM messages WHERE id = ?', [row.id]);
      uploads.removeFiles(fileRows.map((r) => r.id));
      events.emit(ch.server_id, ch.id, { type: 'message_deleted', id: row.id, channel_id: ch.id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

module.exports = router;