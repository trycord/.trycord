// An instance with the E2EE API on it.
//
// server.js is not this workstream's file to edit, and the router belongs
// in it. So this helper makes the mount the way the mount will be made:
// the router is put at /api/e2ee, in front of the API's catch-all 404,
// which is where a router mounted in server.js sits.
//
// Everything else is the instance's own - the database, the signing
// secret, the middleware chain, the rate limiter. When the router is
// mounted in server.js as well, this mount simply comes second and never
// sees a request.

'use strict';

const { startInstance } = require('../helpers/instance');

/**
 * Start an instance and mount the E2EE router on it.
 *
 * @returns {Promise<object>} the instance, with the router mounted
 */
async function startE2eeInstance(options = {}) {
  const instance = await startInstance(options);
  // Required after the instance starts: starting it clears the module
  // registry, and the services hold singletons that have to be the ones
  // bound to this run's database.
  const router = require('../../src/routes/e2ee');
  instance.app.use('/api/e2ee', router);

  // Express answers in the order things were added, and the API's
  // catch-all 404 was added during boot, just before the error handler.
  // The router has to be in front of that 404, so the layer moves: the
  // error handler is the only layer that takes four arguments, and the
  // 404 is the one in front of it.
  const stack = instance.app.router.stack;
  const layer = stack.pop();
  const errorHandler = stack.findIndex((entry) => entry.handle && entry.handle.length === 4);
  const catchAll = errorHandler > 0 ? errorHandler - 1 : -1;
  if (catchAll >= 0) stack.splice(catchAll, 0, layer);

  return instance;
}

module.exports = { startE2eeInstance };
