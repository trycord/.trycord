// /api/announcements - instance-wide announcement banners.
//
// These are per-deployment (not global), authored by platform admins, and
// persisted in the database so they survive restarts. Reads are open to any
// signed-in user because the banner is instance-wide chrome, not private
// data; writes go through adminGuard so the client flag can never escalate.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const adminGuard = require('../middleware/adminGuard');
const { fail } = require('../errors');
const { now } = require('../util');

const router = express.Router();

const LEVELS = new Set(['info', 'warning', 'critical']);
const MAX_BODY = 500;

// An announcement is live when it is enabled and has not passed its expiry.
// Expired rows stay in the table (audit) but never reach clients.
function shape(row) {
  return {
    id: row.id,
    body: row.body,
    level: row.level,
    linkLabel: row.link_label || null,
    linkHref: row.link_href || null,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    expiresAt: row.expires_at || null,
  };
}

const LIVE = 'SELECT * FROM announcements WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC';

// GET /api/announcements - live banners for this instance.
router.get('/', auth, async (req, res, next) => {
  try {
    const rows = await db.all(LIVE, [now()]);
    res.json(rows.map(shape));
  } catch (e) { next(e); }
});

// GET /api/announcements/all - every banner including retired/expired (admin).
router.get('/all', adminGuard, async (req, res, next) => {
  try {
    const rows = await db.all('SELECT * FROM announcements ORDER BY created_at DESC');
    res.json(rows.map(shape));
  } catch (e) { next(e); }
});

function readInput(body) {
  const text = String((body && body.body) || '').trim();
  if (!text) return { err: 'announcement text is required' };
  if (text.length > MAX_BODY) return { err: 'announcement is too long' };
  const level = String((body && body.level) || 'info').toLowerCase();
  if (!LEVELS.has(level)) return { err: 'level must be info, warning or critical' };
  const href = String((body && body.linkHref) || '').trim();
  // Only same-origin relative paths: an instance admin must not be able to
  // turn the global banner into an open redirect or a javascript: URL.
  // A bare startsWith('/') check is not enough: '//evil.example' also
  // starts with '/', and browsers read that as a protocol-relative URL.
  if (href && !(href.startsWith('/') && !href.startsWith('//'))) {
    return { err: 'link must be a relative path starting with /' };
  }
  const label = String((body && body.linkLabel) || '').trim();
  return {
    value: {
      body: text,
      level,
      linkHref: href || null,
      linkLabel: href ? (label || 'Open').slice(0, 64) : null,
      expiresAt: (body && body.expiresAt) ? String(body.expiresAt) : null,
    },
  };
}

// POST /api/announcements - create a banner.
router.post('/', adminGuard, async (req, res, next) => {
  try {
    const { err, value } = readInput(req.body);
    if (err) return fail(res, 'VALIDATION_ERROR', err);
    const id = require('crypto').randomUUID();
    const ts = now();
    await db.run(
      'INSERT INTO announcements (id, body, level, link_label, link_href, active, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [id, value.body, value.level, value.linkLabel, value.linkHref, req.user.id, ts, value.expiresAt],
    );
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    res.status(201).json(shape(row));
  } catch (e) { next(e); }
});

// PATCH /api/announcements/:id - edit, retire, or reactivate.
router.patch('/:id', adminGuard, async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    const existing = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!existing) return fail(res, 'NOT_FOUND', 'announcement not found');
    const body = req.body || {};
    const patch = {};

    if ('active' in body) {
      patch.active = body.active ? 1 : 0;
    }
    if ('body' in body || 'level' in body || 'linkHref' in body || 'linkLabel' in body || 'expiresAt' in body) {
      const merged = {
        body: 'body' in body ? body.body : existing.body,
        level: 'level' in body ? body.level : existing.level,
        linkHref: 'linkHref' in body ? body.linkHref : existing.link_href,
        linkLabel: 'linkLabel' in body ? body.linkLabel : existing.link_label,
        expiresAt: 'expiresAt' in body ? body.expiresAt : existing.expires_at,
      };
      const { err, value } = readInput(merged);
      if (err) return fail(res, 'VALIDATION_ERROR', err);
      Object.assign(patch, {
        body: value.body,
        level: value.level,
        link_href: value.linkHref,
        link_label: value.linkLabel,
        expires_at: value.expiresAt,
      });
    }
    if (!Object.keys(patch).length) return fail(res, 'VALIDATION_ERROR', 'nothing to update');

    patch.updated_at = now();
    const cols = Object.keys(patch);
    await db.run(
      'UPDATE announcements SET ' + cols.map((c) => c + ' = ?').join(', ') + ' WHERE id = ?',
      cols.map((c) => patch[c]).concat([id]),
    );
    res.json(shape(await db.get('SELECT * FROM announcements WHERE id = ?', [id])));
  } catch (e) { next(e); }
});

// DELETE /api/announcements/:id - remove entirely.
router.delete('/:id', adminGuard, async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    const existing = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!existing) return fail(res, 'NOT_FOUND', 'announcement not found');
    await db.run('DELETE FROM announcements WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
