// The ticket that opens the voice process's own page.
//
// The voice process answers on the loopback, on a port of its own, and it
// can change the instance's configuration and mint a credential for the
// relay. The loopback is the boundary that keeps it off the network, and
// the person at the machine is the operator - but "the operator" is a
// wider circle than "an administrator of this instance", and the
// configuration it changes is the instance's.
//
// So the page asks for a ticket. The voice console mints one - the route is
// behind the platform-admin gate, so only an administrator gets one - and
// the voice process hands the ticket to the API to check. The API is the
// thing that knows who an administrator is, and it is the thing that
// decides whether a ticket is good.
//
// A ticket is short-lived and good once. It is the same shape as the
// gateway's ticket: a secret that is handed over once and cannot be
// replayed.

'use strict';

const crypto = require('crypto');

// How long a ticket is good for, and how many are remembered.
//
// A ticket is spent in a minute or two - the operator is at the machine
// and clicks a button - and only a few are alive at once, so a page that
// was left open cannot be opened again with an old ticket.
const LIFETIME_MS = 2 * 60 * 1000;
const KEPT = 20;

const tickets = new Map();

// Mint a ticket.
function mint(who) {
  sweep();
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, {
    expiresAt: Date.now() + LIFETIME_MS,
    who: String(who || ''),
  });
  while (tickets.size > KEPT) {
    const oldest = tickets.keys().next().value;
    tickets.delete(oldest);
  }
  return { ticket, expiresIn: Math.floor(LIFETIME_MS / 1000) };
}

// Check a ticket, and spend it.
//
// It is spent whether it was good or not: a ticket that is checked twice
// is either a mistake or an attempt to replay it, and neither should be
// answered.
function spend(ticket) {
  const id = String(ticket || '').trim();
  if (!id) return false;
  const entry = tickets.get(id);
  tickets.delete(id);
  if (!entry) return false;
  return entry.expiresAt > Date.now();
}

// The tickets that have run out.
function sweep() {
  const now = Date.now();
  for (const [id, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(id);
  }
}

module.exports = { mint, spend, LIFETIME_MS };
