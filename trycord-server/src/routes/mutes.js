// /api/mutes — per-user channel notification mutes. A muted channel
// still shows everything; it only suppresses mention notifications for
// that user (checked at mention time) and dims in the client.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { fail } = require('../errors');
const { now, visibleChannel } = require('../util');

const router = express.Router();
router.use(auth);

// GET /api/mutes — muted channel ids for the caller.
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.all('SELECT channel_id FROM muted_channels WHERE user_id = ?', [req.user.id]);
    res.json(rows.map((r) => r.channel_id));
  } catch (e) { next(e); }
});

// POST /api/mutes { channelId } — mute (must see the channel).
router.post('/', async (req, res, next) => {
  try {
    const channelId = String((req.body || {}).channelId || '');
    const ch = await visibleChannel(channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    try {
      await db.run('INSERT INTO muted_channels (user_id, channel_id, muted_at) VALUES (?, ?, ?)', [req.user.id, ch.id, now()]);
    } catch (e) {
      const s = String((e && e.message) || e);
      if (!/UNIQUE|unique|duplicate|PRIMARY/i.test(s)) throw e;
    }
    res.json({ ok: true, channelId: ch.id, muted: true });
  } catch (e) { next(e); }
});

// DELETE /api/mutes/:channelId — unmute.
router.delete('/:channelId', async (req, res, next) => {
  try {
    await db.run('DELETE FROM muted_channels WHERE user_id = ? AND channel_id = ?', [req.user.id, req.params.channelId]);
    res.json({ ok: true, channelId: req.params.channelId, muted: false });
  } catch (e) { next(e); }
});

module.exports = router;
