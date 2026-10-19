// The versioned developer API.
//
// Mounted at /api/v1. The router is built from the route definitions, so the
// routes it serves and the routes the OpenAPI document describes are the same
// list, and a route cannot be added to one and forgotten in the other.
//
// The chain every authenticated route goes through:
//
//   authenticate   a session token or a machine credential
//   denyBots       an application may not use a route that is not for applications
//   requireScopes  a machine credential must hold the scopes the route needs
//   keyRateLimit   the credential's own limit
//   recordUsage    what the credential spent
//   community      resolve the community and check the caller's standing in it
//   handler        the work
//
// The order matters: the limit is the credential's, so it can only be applied
// once the credential is known, and the community check needs the caller, so
// it comes after the authentication.

const express = require('express');
const { wrap } = require('../../errors');
const { authenticate, requireScopes, denyBots } = require('../../services/developer/credentials');
const { keyRateLimit } = require('../../services/developer/rateLimit');
const usage = require('../../services/developer/usage');
const { resolveServer, requireMember, requirePerm } = require('../../middleware/serverAccess');
const definitions = require('./definitions');

// Count what a credential spent, once the request has been answered. The
// route is the pattern, not the path: a hundred calls to one route are one
// line in the report.
function recordUsage(req, res, next) {
  res.on('finish', () => {
    const principal = req.principal;
    if (!principal || principal.kind === 'session') return;
    const route = (req.route && req.route.path) || req.path;
    usage.record({ keyId: principal.id, route, status: res.statusCode }).catch((e) => {
      console.warn('[developer] could not record usage: ' + (e && e.message ? e.message : e));
    });
  });
  return next();
}

function handlersFor(definition) {
  const handlers = [];
  if (definition.auth !== 'public') {
    handlers.push(authenticate);
    // The application check comes before the scope check: a bot on a route
    // that is not for applications is told that, whatever scopes it holds.
    if (!definition.bots) handlers.push(denyBots);
    handlers.push(requireScopes(definition.scopes));
    handlers.push(keyRateLimit());
    handlers.push(recordUsage);
  }
  if (definition.community) {
    handlers.push(resolveServer);
    handlers.push(definition.community === 'manage' ? requirePerm('MANAGE_SERVER') : requireMember);
  }
  handlers.push(wrap(definition.handler));
  return handlers;
}

const router = express.Router();

for (const definition of definitions) {
  router[definition.method](definition.path, ...handlersFor(definition));
}

module.exports = router;
