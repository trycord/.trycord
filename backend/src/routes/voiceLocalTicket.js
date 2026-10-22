// Checking a ticket for the voice process's own page. Not behind the admin
// gate: the ticket is the proof, and the voice process has no session.

'use strict';

const express = require('express');
const { wrap } = require('../errors');
const rateLimit = require('../middleware/ratelimit');
const localTicket = require('../services/voice/local-ticket');

const router = express.Router();

// Check a ticket, and spend it.
router.post('/verify', rateLimit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const body = req.body || {};
  const good = localTicket.spend(body.ticket);
  res.status(good ? 200 : 403).json({ ok: good });
}));

module.exports = router;
