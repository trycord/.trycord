// Single-use, short-lived tickets for the socket handshake.
//
// Why this exists at all: a client cannot put its bearer token in a WebSocket URL. URLs
// end up in access logs, proxy logs and Referer headers, so a token in one is a token
// that leaks. The client POSTs for a ticket instead, gets 60 seconds of validity, and
// spends it immediately: one HTTP call buys exactly one socket attempt.
//
// "Single use" is the property that makes this worth a module. A ticket that could be
// replayed would turn any log that captured one into a 60-second credential, and the
// window would be long enough to be useful to whoever found it.

const crypto = require('crypto');

const TICKET_TTL_MS = 60 * 1000;
// A busy instance issues a ticket per socket attempt. This is not a security bound - the
// TTL is - it stops the map growing without limit when clients reconnect in a loop.
const SWEEP_AT = 2048;

module.exports = function createTickets() {
  // ticket -> { claims, exp }
  const tickets = new Map();

  function issue(claims) {
    const t = crypto.randomUUID();
    tickets.set(t, { claims, exp: Date.now() + TICKET_TTL_MS });
    if (tickets.size > SWEEP_AT) {
      const nowMs = Date.now();
      for (const [k, v] of tickets) if (nowMs >= v.exp) tickets.delete(k);
    }
    return t;
  }

  // Delete before checking expiry, so a spent ticket is gone whether it was valid or
  // not. Anything else lets an attacker burn a victim's ticket by guessing it.
  function consume(t) {
    const rec = tickets.get(t);
    if (!rec) return null;
    tickets.delete(t);
    if (Date.now() > rec.exp) return null;
    return rec.claims;
  }

  return { issue, consume, ttlMs: TICKET_TTL_MS };
};
