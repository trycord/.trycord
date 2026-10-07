// The websocket gateway, as far as the auth routes are concerned.
//
// The gateway is constructed after the HTTP app is built and injected back in, because it
// needs the same server to share the port. So two auth routes need something that does not
// exist yet when they are declared: revoking a session must also drop its open sockets,
// and the socket handshake needs a ticket the gateway issues.
//
// Rather than have every route module import routes/auth.js - which imports the routes,
// which is a cycle - the late-bound references live here, in a module that depends on
// nothing. routes/auth.js re-exports the setters, so the public contract is unchanged and
// the dependency runs one way.

// Both are placeholders rather than throws. An auth route that fires before the gateway
// is wired should refuse the request or fail loudly, not crash the process on a call to
// something that was never replaced.
let disconnectUser = () => {};
let ticketIssuer = () => {
  throw new Error('auth: no socket gateway wired');
};

function setGateway(gw) {
  if (gw && typeof gw.disconnectUser === 'function') disconnectUser = gw.disconnectUser;
  if (gw && typeof gw.issueTicket === 'function') ticketIssuer = gw.issueTicket;
}

// Set separately from the gateway because the two arrive independently: the ticket issuer
// is only meaningful once the socket server exists.
function setTicketIssuer(fn) {
  if (typeof fn === 'function') ticketIssuer = fn;
}

// The gateway is not wired until the socket server exists. Checked rather than assumed so
// /ws/ticket can answer "unavailable" instead of throwing.
let ticketReady = false;

function setGateway(gw) {
  if (gw && typeof gw.disconnectUser === 'function') disconnectUser = gw.disconnectUser;
  if (gw && typeof gw.issueTicket === 'function') {
    ticketIssuer = gw.issueTicket;
    ticketReady = true;
  }
}

// Set separately from the gateway because the two arrive independently: the ticket issuer
// is only meaningful once the socket server exists.
function setTicketIssuer(fn) {
  if (typeof fn === 'function') {
    ticketIssuer = fn;
    ticketReady = true;
  }
}

function isWsTicketIssuerReady() {
  return ticketReady;
}

// Deliberately not guarded: a caller has already asked whether the issuer is wired, and
// if it answered yes then something set it and this cannot fail.
function issueWsTicket(claims) {
  return ticketIssuer(claims);
}

module.exports = {
  setGateway,
  setTicketIssuer,
  isWsTicketIssuerReady,
  // Exported under its own name rather than renamed at every call site: the routes call
  // disconnectUser and should keep reading that way.
  disconnectUser,
  issueWsTicket,
};
