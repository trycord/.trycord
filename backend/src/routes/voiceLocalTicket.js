// The ticket that opens the voice process's own page.
//
// The voice process answers on the loopback, on a port of its own, and it
// can change the instance's configuration and mint a credential for the
// relay. The ticket is what says that the person holding it is an
// administrator of this instance: the console that mints it is behind the
// platform-admin gate, and this route is what the voice process asks when
// it is handed one.
//
// It is not behind the admin gate itself. The ticket *is* the proof, and
// the gate would need the very thing the ticket is asking about - the
// voice process has no session, because it is a process on the machine
// rather than a browser in it.
//
// The ticket is good once and for a couple of minutes, and this route is
// rate limited: a ticket is a secret, and a secret that can be guessed
// slowly is a secret that will be.

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
