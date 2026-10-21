// The application gateway.
//
// An application that can post and cannot hear anything is a mail-merge, not a
// bot. The gateway is what an application holds open to receive the events
// of its community: it connects, it says which events it wants, and it is
// handed the envelope the same envelope the webhooks are handed.
//
// It is a socket of its own, not a channel on the user socket, because a
// bot has no session. A user socket is opened with a one-time ticket issued
// to a signed-in account; an application socket is opened with a one-time
// ticket issued to the application, with the application's own token.
//
// The rules that keep it honest:
//
//   - a ticket is short-lived and single-use, so a token in a URL - which
//     leaks through logs and referrers - is never needed;
//   - an application hears only the events of the community it belongs to,
//     and only the ones it asked for;
//   - an application that is disabled or has had its token revoked is
//     disconnected, and cannot reconnect;
//   - the envelope it is handed is the same one, built by the same code, so a
//     bot and a webhook see the same event.

'use strict';

const crypto = require('crypto');
const db = require('../../db');
const { EVENTS: SUPPORTED_EVENTS } = require('../webhooks');

// How long a ticket is good for, and how many sockets one application may
// hold open.
const TICKET_TTL_MS = 60 * 1000;
const MAX_SOCKETS_PER_APPLICATION = 4;
const MAX_QUEUED = 200;

// The tickets, and the open sockets.
//
// The sockets are here and not in the process's socket list, so that the
// events service can reach them without the two importing each other.
const tickets = new Map();
const sockets = new Map(); // applicationId -> Set of sockets

function issueTicket(applicationId, communityId) {
  const ticket = crypto.randomUUID();
  tickets.set(ticket, {
    applicationId: String(applicationId),
    communityId: String(communityId),
    exp: Date.now() + TICKET_TTL_MS,
  });
  if (tickets.size > 2048) {
    const now = Date.now();
    for (const [key, record] of tickets) if (now >= record.exp) tickets.delete(key);
  }
  return ticket;
}

function consumeTicket(ticket) {
  const record = tickets.get(ticket);
  if (!record) return null;
  // Deleted before the expiry is checked, so a spent ticket is gone whether
  // it was valid or not: anything else lets one caller burn another's ticket
  // by guessing it.
  tickets.delete(ticket);
  if (Date.now() > record.exp) return null;
  return record;
}

/**
 * The application a ticket belongs to, and whether it may still connect.
 *
 * The application is read again here, and not taken from the ticket: a ticket
 * that was issued before the application was disabled or before its token was
 * revoked must not open a socket afterwards.
 */
async function applicationFor(ticket) {
  const record = consumeTicket(ticket);
  if (!record) return null;
  const row = await db.get(
    'SELECT id, server_id, name, status, bot_user_id FROM bot_applications WHERE id = ?',
    [record.applicationId],
  );
  if (!row) return null;
  if (String(row.status || 'active') !== 'active') return null;
  if (!row.bot_user_id || !(await db.get(
    'SELECT 1 AS ok FROM server_members WHERE server_id = ? AND user_id = ?',
    [row.server_id, row.bot_user_id]
  ))) return null;
  return { applicationId: row.id, communityId: row.server_id, name: row.name };
}

/**
 * Register an open socket.
 *
 * The newest socket for an application wins when the limit is reached, so a
 * bot that reconnects in a loop cannot push itself out of its own events.
 */
function register(application, socket) {
  const id = application.applicationId;
  if (!sockets.has(id)) sockets.set(id, new Set());
  const set = sockets.get(id);

  // The set holds the *connections*, not the sockets. A connection carries
  // the subscription - the events it asked for - and the socket; the set held
  // the sockets at first, and every reader of it was therefore reading a
  // socket's properties and finding none: the subscription was invisible, and
  // an application that had asked for an event heard nothing.
  const connection = {
    applicationId: id,
    communityId: application.communityId,
    events: new Set(),
    socket,
  };
  set.add(connection);
  while (set.size > MAX_SOCKETS_PER_APPLICATION) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    try { oldest.socket.close(1000, 'replaced by a newer connection'); } catch { /* already closed */ }
  }
  return connection;
}

function unregister(connection) {
  const set = sockets.get(connection.applicationId);
  if (!set) return;
  set.delete(connection);
  if (!set.size) sockets.delete(connection.applicationId);
}

/**
 * The events one application has asked for.
 *
 * An application with no list of its own hears nothing. That is deliberate:
 * an application that is handed every event of a community is an application
 * that can read everything, and the list is how an operator says what it is
 * allowed to hear.
 */
function subscribe(connection, events) {
  const requested = Array.isArray(events) ? events : [];
  connection.events = new Set(requested
    .map((type) => String(type || '').trim())
    .filter((type) => SUPPORTED_EVENTS.includes(type)));
  return Array.from(connection.events);
}

/**
 * The events an application has asked for, in the order it asked for them.
 */
function subscriptionsOf(applicationId) {
  const set = sockets.get(applicationId);
  if (!set || !set.size) return [];
  const events = new Set();
  for (const connection of set) {
    if (!connection.events) continue;
    for (const type of connection.events) events.add(type);
  }
  return Array.from(events);
}

/**
 * Hand an envelope to the applications that asked for it.
 *
 * The same envelope the webhooks are handed, from the same dispatch, so a
 * bot and a webhook cannot see different events.
 *
 * @param {object} envelope the event envelope
 * @param {string} communityId the community the event happened in
 * @param {string} type the event type
 */
function deliver(envelope, communityId, type) {
  let delivered = 0;
  for (const set of sockets.values()) {
    for (const connection of set) {
      if (connection.communityId !== String(communityId)) continue;
      if (!connection.events || !connection.events.has(String(type))) continue;
      try {
        connection.socket.send(JSON.stringify(envelope));
        delivered += 1;
      } catch {
        // A socket that cannot be written to is closed, not retried: the
        // event is already gone for that connection and the application will
        // reconnect.
      }
    }
  }
  return delivered;
}

/**
 * Disconnect the applications that are no longer allowed.
 *
 * An administrator who disables an application, or revokes its token, has
 * said that it must stop hearing things. A socket that is already open would
 * otherwise keep hearing them until it noticed.
 */
async function disconnectRevoked() {
  const rows = await db.all("SELECT id FROM bot_applications WHERE status <> 'active'");
  const revoked = new Set(rows.map((row) => String(row.id)));
  let closed = 0;
  for (const [applicationId, set] of sockets) {
    if (!revoked.has(applicationId)) continue;
    for (const connection of set) {
      try { connection.socket.close(1008, 'this application is no longer active'); } catch { /* already closed */ }
      closed += 1;
    }
    sockets.delete(applicationId);
  }
  return closed;
}

// How many applications are connected, and how many sockets they hold.
function state() {
  const applications = [];
  for (const [applicationId, set] of sockets) {
    applications.push({
      applicationId,
      sockets: set.size,
      events: subscriptionsOf(applicationId),
    });
  }
  return { applications, tickets: tickets.size };
}

module.exports = {
  issueTicket,
  consumeTicket,
  applicationFor,
  register,
  unregister,
  subscribe,
  subscriptionsOf,
  deliver,
  disconnectRevoked,
  state,
  TICKET_TTL_MS,
};
