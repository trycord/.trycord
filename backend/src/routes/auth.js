// Authentication: who you are, how you prove it, and how you stop proving it.
//
// This file mounts the routes and owns nothing else. Each concern is a module beside it:
//
//   register.js   POST /register
//   login.js      POST /login, POST /2fa/verify - together, because the second is the
//                 second half of the first
//   twofactor.js  the second factor: status, setup, enable, disable, recovery codes
//   password.js   changing a password, and signing out
//   sessions.js   listing and revoking sessions
//   recovery.js   forgot-password, reset-password
//   email.js      verifying an address, resending the link, changing it
//   ticket.js     POST /ws/ticket, for the socket handshake
//
// Two of them are not routes at all and are shared by several:
//   ../../auth/issued.js     the response every successful sign-in returns
//   ../../auth/challenge.js  the MFA challenge token, which is not a session
//
// The websocket gateway is constructed after this router and injected back in, so two
// things are late-bound. They live in src/auth/gateway.js rather than here: a module that
// imported this one to reach them would be a cycle, and the two late-bound references -
// drop a user's sockets, mint a handshake ticket - are the same kind of thing and should
// be the same piece of code.
const express = require('express');

const router = express.Router();

const gateway = require('../auth/gateway');

const register = require('./auth/register');
const login = require('./auth/login');
const twofactor = require('./auth/twofactor');
const password = require('./auth/password');
const sessions = require('./auth/sessions');
const recovery = require('./auth/recovery');
const email = require('./auth/email');
const ticket = require('./auth/ticket');

router.use(register);
router.use(login);
router.use(twofactor);
router.use(password);
router.use(sessions);
router.use(recovery);
router.use(email);
router.use(ticket);

module.exports = router;
module.exports.setGateway = gateway.setGateway;
module.exports.setTicketIssuer = gateway.setTicketIssuer;
