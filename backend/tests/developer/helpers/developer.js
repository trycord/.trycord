// Reaching the versioned API from a test.
//
// The server mounts the API 404 handler in front of everything else under
// /api, so a router mounted after the server has booted would never be
// reached: the 404 answers first. The mount is therefore placed where the
// server places it - in front of that handler - by moving the layer the
// public API has just created.
//
// The server may already mount the versioned router, in which case nothing is
// moved and the instance is used exactly as it is.

'use strict';

const VERSIONED_PATH = '/api/v1';
const PROBE_PATH = '/api/v1/__developer_probe__';

/**
 * Make sure the versioned API answers on this instance.
 *
 * @param {object} instance an instance from startInstance()
 * @returns {Promise<string>} the base URL of the versioned API
 */
async function ensureVersionedApi(instance) {
  const probe = await fetch(instance.baseUrl + VERSIONED_PATH + '/openapi.json');
  if (probe.status === 200) return instance.baseUrl + VERSIONED_PATH;
  mountVersionedRouter(instance);
  return instance.baseUrl + VERSIONED_PATH;
}

/**
 * Mount the versioned router on a running instance.
 *
 * @param {object} instance
 */
function mountVersionedRouter(instance) {
  const router = require('../../../src/routes/developer');
  instance.app.use(VERSIONED_PATH, router);

  // The layer app.use() just created is the last one in the stack; it is
  // moved in front of the API 404 handler, which is where the server mounts
  // it.
  const stack = instance.app.router.stack;
  const layer = stack.pop();
  stack.splice(apiNotFoundIndex(stack), 0, layer);
}

// The index of the API 404 handler: the last layer before the error handler
// that matches a path under /api.
function apiNotFoundIndex(stack) {
  let errorIndex = stack.findIndex((layer) => layer.handle && layer.handle.length === 4);
  if (errorIndex === -1) errorIndex = stack.length;
  for (let i = errorIndex - 1; i >= 0; i--) {
    if (matches(stack[i], PROBE_PATH)) return i;
  }
  return errorIndex;
}

function matches(layer, path) {
  if (!layer.matchers) return false;
  return layer.matchers.some((matcher) => {
    try {
      return !!matcher(path);
    } catch {
      return false;
    }
  });
}

module.exports = { ensureVersionedApi, mountVersionedRouter, VERSIONED_PATH };
