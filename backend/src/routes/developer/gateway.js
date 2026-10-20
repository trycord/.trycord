// The application gateway, over HTTP.
//
// Two things live here:
//
//   POST /api/v1/applications/:applicationId/gateway-ticket
//       a one-time ticket, issued to the application itself, for the socket
//       handshake. The token never rides in a URL.
//
//   GET /api/v1/applications/:applicationId/gateway
//       what the application is connected to and what it has asked for.
//
// The ticket is the whole of the handshake: a bot that has it may open one
// socket, and the socket is gone the moment the ticket is spent.

'use strict';

const express = require('express');
const rateLimit = require('../../middleware/ratelimit');
const { fail } = require('../../errors');
const gateway = require('../../services/developer/gateway');
const { pathParam, ok, ERRORS } = require('./metadata');

const router = express.Router();

// The application presents its own bearer token.
//
// The routes that manage an application are the community's; these two are
// the application's, because it is the application that opens the socket.
//
// The developer chain already resolves an application token, so the check
// here is the one the HTTP layer does not do: that the application is
// asking about *itself*. An application may not ask for a ticket for another
// application, and an application that has been disabled gets nothing.
function requireApp(req, res, next) {
  const principal = req.principal;
  if (!principal || principal.kind !== 'bot') {
    return fail(res, 'NOT_FOUND', 'not found');
  }
  // The application's id is not the credential's id: an application may have
  // more than one key, and a key may be revoked and replaced.
  const applicationId = principal.botApplicationId || principal.id;
  if (String(req.params.applicationId) !== String(applicationId)) {
    return fail(res, 'PERMISSION_DENIED', 'this application is not yours', 403);
  }
  return next();
}

// POST /api/v1/applications/:applicationId/gateway-ticket
//
// A short-lived, single-use ticket for the socket handshake.
router.post('/applications/:applicationId/gateway-ticket', requireApp,
  rateLimit({ windowMs: 60000, max: 30, key: 'developer:gateway-ticket' }),
  (req, res) => {
    const applicationId = req.principal.botApplicationId || req.principal.id;
    const ticket = gateway.issueTicket(applicationId, req.principal.communityId);
    res.json({
      ticket,
      // How long it is good for, so a bot does not have to guess.
      expiresInMs: gateway.TICKET_TTL_MS,
      // Where to open the socket. The address is the one the instance serves,
      // which a bot on the internet may not be able to reach; the instance's
      // own configuration says what that is.
      url: '/api/v1/gateway',
    });
  });

// GET /api/v1/applications/:applicationId/gateway
//
// What the application is connected to, and what it has asked for. An
// operator reads it to see whether a bot is connected and what it can hear.
router.get('/applications/:applicationId/gateway', requireApp,
  rateLimit({ windowMs: 60000, max: 60, key: 'developer:gateway' }),
  async (req, res) => {
    const state = gateway.state();
    const applicationId = req.principal.botApplicationId || req.principal.id;
    const connection = state.applications.find(
      (entry) => String(entry.applicationId) === String(applicationId),
    );
    res.json({
      application: {
        id: applicationId,
        communityId: req.principal.communityId,
        connected: !!connection,
        sockets: connection ? connection.sockets : 0,
        events: connection ? connection.events : [],
      },
      // How many applications are connected in all. It is the size of the
      // gateway, and an operator watching the instance wants to know it.
      connectedApplications: state.applications.length,
    });
  });

/**
 * Disconnect the applications that are no longer allowed.
 *
 * An administrator who disables an application, or revokes its token, has
 * said that it must stop hearing things. A socket that is already open would
 * otherwise keep hearing them until it noticed - and a bot that has been
 * turned off and is still receiving events is worse than one that was never
 * turned off.
 */
async function disconnectRevoked() {
  return gateway.disconnectRevoked();
}

// The route definitions.
//
// The developer router is built from a list, and the OpenAPI document is
// generated from the same list, so a route that is not in the list is not
// served and a route that is in the list is described. The gateway is in that
// list like everything else.
const definitions = [
  {
    method: 'post',
    path: '/applications/:applicationId/gateway-ticket',
    auth: 'principal',
    // No scope is required. The gateway is part of being an application: the
    // token *is* the application's own credential, and a scope the creator
    // may not have thought to grant would leave a bot that can post and
    // cannot listen. The handler still refuses anything that is not an
    // application, and an application may only ask about itself.
    scopes: [],
    bots: true,
    tags: ['Gateway'],
    summary: 'A ticket for the application gateway',
    description: 'A short-lived, single-use ticket for opening the application '
      + 'gateway. The token never rides in a URL, because a URL ends up in logs.',
    parameters: [pathParam('applicationId', 'The application id.')],
    responses: {
      200: ok('The ticket.', { type: 'object', required: ['ticket'], properties: {
        ticket: { type: 'string' },
        expiresInMs: { type: 'integer' },
        url: { type: 'string' },
      } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: (req, res) => {
      // The application check is here, in the handler, because the chain the
      // developer router builds does not know about it: a session would
      // otherwise be able to ask for a ticket for an application.
      if (!req.principal || req.principal.kind !== 'bot') {
        return fail(res, 'NOT_FOUND', 'not found');
      }
      const applicationId = req.principal.botApplicationId || req.principal.id;
      if (String(req.params.applicationId) !== String(applicationId)) {
        return fail(res, 'PERMISSION_DENIED', 'this application is not yours', 403);
      }
      const ticket = gateway.issueTicket(applicationId, req.principal.communityId);
      res.json({
        ticket,
        expiresInMs: gateway.TICKET_TTL_MS,
        url: '/api/v1/gateway',
      });
    },
  },
  {
    method: 'get',
    path: '/applications/:applicationId/gateway',
    auth: 'principal',
    // As above: being the application is the authority.
    scopes: [],
    bots: true,
    tags: ['Gateway'],
    summary: 'The state of the application gateway',
    description: 'Whether the application is connected, how many sockets it '
      + 'holds and which events it has asked for.',
    parameters: [pathParam('applicationId', 'The application id.')],
    responses: {
      200: ok('The gateway state.', { type: 'object', required: ['application'], properties: {
        application: { type: 'object', additionalProperties: true },
        connectedApplications: { type: 'integer' },
      } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: (req, res) => {
      if (!req.principal || req.principal.kind !== 'bot') {
        return fail(res, 'NOT_FOUND', 'not found');
      }
      const applicationId = req.principal.botApplicationId || req.principal.id;
      if (String(req.params.applicationId) !== String(applicationId)) {
        return fail(res, 'PERMISSION_DENIED', 'this application is not yours', 403);
      }
      const state = gateway.state();
      const connection = state.applications.find(
        (entry) => String(entry.applicationId) === String(applicationId),
      );
      res.json({
        application: {
          id: applicationId,
          communityId: req.principal.communityId,
          connected: !!connection,
          sockets: connection ? connection.sockets : 0,
          events: connection ? connection.events : [],
        },
        connectedApplications: state.applications.length,
      });
    },
  },
];

module.exports = router;
module.exports.definitions = definitions;
