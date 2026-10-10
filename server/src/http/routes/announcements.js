// Instance announcements: the banners an operator publishes for everyone on this
// instance. Instance-scoped, not global - a self-hosted Trycord announces to itself.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate } = require('../../middleware/auth');
const db = require('../../db');
const { now, uuid } = require('../../util');

const LEVELS = ['info', 'warning', 'critical'];

const router = express.Router();
router.use(authenticate);

// Readers see what is live and unexpired. Nothing else, and never the draft side.
router.get('/', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT id, body, level, link_label, link_href, created_at, expires_at
       FROM announcements
      WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC`,
    [now()]
  );
  res.json(rows);
}));

// Everything below is the operator's half: publishing is an instance-level act.
const admin = express.Router();

admin.get('/', wrap(async (req, res) => {
  if (!req.admin) return fail(res, 'PERMISSION_DENIED', 'you cannot see announcements');
  const rows = await db.all('SELECT * FROM announcements ORDER BY created_at DESC');
  res.json(rows);
}));

admin.post('/', limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  if (!req.admin) return fail(res, 'PERMISSION_DENIED', 'you cannot publish announcements');

  const { body, level, linkLabel, linkHref, active, expiresInHours } = req.body || {};
  if (!body || !String(body).trim()) {
    return fail(res, 'VALIDATION_ERROR', 'an announcement needs some text');
  }
  if (LEVELS.indexOf(level) === -1) return fail(res, 'VALIDATION_ERROR', 'unknown level');

  const id = uuid();
  await db.run(
    `INSERT INTO announcements (id, body, level, link_label, link_href, active, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, String(body).slice(0, 4000), level,
      linkLabel ? String(linkLabel).slice(0, 64) : null,
      linkHref ? String(linkHref).slice(0, 512) : null,
      active === false ? 0 : 1,
      req.user.id, now(),
      expiresInHours ? new Date(Date.now() + Number(expiresInHours) * 3600000).toISOString() : null]
  );
  res.status(201).json({ id });
}));

admin.patch('/:id', wrap(async (req, res) => {
  if (!req.admin) return fail(res, 'PERMISSION_DENIED', 'you cannot edit announcements');

  const existing = await db.get('SELECT id FROM announcements WHERE id = ?', [req.params.id]);
  if (!existing) return fail(res, 'NOT_FOUND', 'announcement not found');

  const allowed = ['body', 'level', 'link_label', 'link_href', 'active'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in (req.body || {}))) continue;
    sets.push(`${key} = ?`);
    const value = req.body[key];
    params.push(typeof value === 'boolean' ? (value ? 1 : 0)
      : value === null ? null : String(value).slice(0, 4000));
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    params.push(now(), req.params.id);
    await db.run(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  res.json({ ok: true });
}));

admin.delete('/:id', wrap(async (req, res) => {
  if (!req.admin) return fail(res, 'PERMISSION_DENIED', 'you cannot remove announcements');
  await db.run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

router.use('/admin', admin);

module.exports = router;
