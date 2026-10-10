// /api/admin/* — the platform console. Every route sits behind the admin gate, and every
// mutation writes an audit row and an enforcement record.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { requirePlatformAdmin } = require('../../middleware/adminGuard');
const admin = require('../../services/admin');
const reports = require('../../services/reports');

const router = express.Router();
router.use(requirePlatformAdmin);

// Overview: instance health, what is waiting, and what happened recently.
router.get('/overview', wrap(async (req, res) => {
  res.json(await admin.overview());
}));

// People
router.get('/users', wrap(async (req, res) => {
  res.json(await admin.users(req.query));
}));

router.get('/users/:id/actions', wrap(async (req, res) => {
  res.json(await admin.userActions(req.params.id));
}));

router.post('/users/:id/enforce', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  const { action, reason, minutes } = req.body || {};
  if (!action) return fail(res, 'VALIDATION_ERROR', 'an action is required');
  res.json(await admin.enforce(req.params.id, req.user.id, { action, reason, minutes }));
}));

router.post('/users/:id/lift', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.json(await admin.lift(req.params.id, req.user.id, req.body || {}));
}));

router.post('/users/:id/bot', limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  res.json(await admin.setBot(req.params.id, req.user.id, req.body || {}));
}));

// Communities
router.get('/servers', wrap(async (req, res) => {
  res.json(await admin.communities(req.query));
}));

router.post('/servers/:id/suspend', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.json(await admin.suspendCommunity(req.params.id, req.user.id, req.body || {}));
}));

router.post('/servers/:id/lift', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.json(await admin.liftCommunity(req.params.id, req.user.id, req.body || {}));
}));

router.post('/servers/:id/remove', limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  res.json(await admin.removeCommunity(req.params.id, req.user.id, req.body || {}));
}));

// Trust and safety
router.get('/reports', wrap(async (req, res) => {
  res.json(await reports.list(req.query));
}));

router.patch('/reports/:id', limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  res.json(await admin.updateReport(req.params.id, req.user.id, req.body || {}));
}));

router.post('/reports/:id/assign', limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  res.json(await reports.assign(req.params.id, req.user.id));
}));

router.post('/reports/:id/resolve', limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  res.json(await reports.resolve(req.params.id, req.user.id, req.body || {}));
}));

router.get('/appeals', wrap(async (req, res) => {
  res.json(await reports.listAppeals(req.query));
}));

router.post('/appeals/:id/decide', limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  res.json(await reports.decideAppeal(req.params.id, req.user.id, req.body || {}));
}));

// GDPR
router.get('/gdpr/requests', wrap(async (req, res) => {
  res.json(await admin.deletionRequests(req.query));
}));

router.post('/gdpr/requests/:id/review', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.json(await admin.reviewDeletion(req.params.id, req.user.id, req.body || {}));
}));

router.post('/gdpr/requests/:id/process', limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  res.json(await admin.processDeletion(req.params.id, req.user.id));
}));

// Audit
router.get('/audit', wrap(async (req, res) => {
  res.json(await admin.auditLog(req.query));
}));

// Announcements
router.get('/announcements', wrap(async (req, res) => {
  res.json(await admin.announcements());
}));

router.post('/announcements', limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  res.json(await admin.createAnnouncement(req.user.id, req.body || {}));
}));

router.patch('/announcements/:id', wrap(async (req, res) => {
  res.json(await admin.updateAnnouncement(req.params.id, req.body || {}));
}));

router.delete('/announcements/:id', wrap(async (req, res) => {
  res.json(await admin.removeAnnouncement(req.params.id));
}));

module.exports = router;
