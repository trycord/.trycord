const express = require('express');

const router = express.Router();

const auth = require('../../middleware/auth');
const { fail, serviceError } = require('../../errors');
const rateLimit = require('../../middleware/ratelimit');
const gateway = require('../../auth/gateway');

// POST /ws/ticket.
//
// Hands out the single-use ticket the socket handshake spends. The issuer is the
// gateway's, which does not exist yet when this router is constructed, so it is
// filled in from outside - see src/auth/gateway.js, which both this route and the
// session revokers share so the late-bound reference exists in one place.

// Request a short-lived, single-use ticket for the WebSocket handshake.
// Bearer JWTs never belong in a URL (logs, proxies, referrers), so the
// client exchanges its token for a ticket over HTTPS and connects with it.
function ticketIssuer(claims) {
  return gateway.issueWsTicket(claims);
}

function isWired() {
  return gateway.isWsTicketIssuerReady();
}

router.post('/ws/ticket', auth, rateLimit({ windowMs: 60000, max: 60 }), (req, res) => {
  if (!isWired()) return fail(res, 'NOT_FOUND', 'websocket gateway unavailable');
  res.json({
    ticket: ticketIssuer({
      id: req.user.id,
      username: req.user.username,
      jti: req.user.jti || null,
      iat: req.user.iat,
    }),
  });
});

module.exports = router;
