// Authentication that does not require a token.
//
// Some answers are worth having before anybody signs in: the locale the
// interface should be in, the instance's name, the pages it publishes. Those
// routes read the requester's identity when one is offered and do not demand
// it.
//
// The check itself is the ordinary one - the same token verification, the
// same session and revocation check - so a token that would be refused on a
// protected route is refused here too. What changes is only what happens
// when there is no token at all: the request continues as anonymous.
//
// The session checks are not copied. The ordinary authentication middleware
// is run with a stand-in for the response: if it accepts, the request
// continues with the user attached; if it refuses, the refusal is turned
// into "anonymous" and the request continues without one.

const auth = require('./auth');

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.trim()) return next();

  let refused = false;
  // A stand-in for the response. The authentication middleware only ever
  // writes to it by refusing, so nothing reaches the client from here.
  const stand = Object.create(res);
  stand.status = () => stand;
  stand.json = () => {
    refused = true;
    next();
    return stand;
  };

  auth(req, stand, () => {
    if (!refused) next();
  });
}

module.exports = optionalAuth;
