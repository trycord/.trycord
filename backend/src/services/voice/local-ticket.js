// The ticket that opens the voice process's own page. The console mints one
// for an administrator, and the voice process asks the API whether it is
// good. A ticket is good once and lasts a couple of minutes.

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
