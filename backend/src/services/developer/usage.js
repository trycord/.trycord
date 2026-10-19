// What a credential has spent.
//
// Three counters per credential, per minute, per route: the requests, the
// ones that succeeded, and the ones that did not, split by whether the caller
// or the server was at fault. That is enough to answer "is this integration
// working" without pretending to be a metrics platform.
//
// The row id is derived from the credential, the route and the minute, so a
// counter is one upsert: two requests in the same minute land on the same
// row however many of them arrive at once.

const crypto = require('crypto');
const db = require('../../db');

const DEFAULT_WINDOW_MINUTES = 60;

function minuteStart(at) {
  const d = at ? new Date(at) : new Date();
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

function rowId(keyId, route, bucket) {
  return crypto.createHash('sha256')
    .update(keyId + '|' + route + '|' + bucket, 'utf8')
    .digest('hex')
    .slice(0, 40);
}

/**
 * Count one request.
 *
 * @param {object} entry
 * @param {string} entry.keyId
 * @param {string} entry.route
 * @param {number} entry.status the HTTP status the request ended with
 */
async function record({ keyId, route, status }) {
  if (!keyId) return;
  const bucket = minuteStart();
  const code = Number(status) || 0;
  const succeeded = code >= 200 && code < 300 ? 1 : 0;
  const clientErrors = code >= 400 && code < 500 ? 1 : 0;
  const serverErrors = code >= 500 ? 1 : 0;
  await db.upsert(
    'developer_key_usage',
    ['id', 'key_id', 'route', 'bucket_start', 'requests', 'succeeded', 'client_errors', 'server_errors'],
    [rowId(keyId, route, bucket), keyId, route, bucket, 1, succeeded, clientErrors, serverErrors],
    ['id'],
    {
      requests: 'requests + 1',
      succeeded: 'succeeded + ' + succeeded,
      client_errors: 'client_errors + ' + clientErrors,
      server_errors: 'server_errors + ' + serverErrors,
    }
  );
}

/**
 * The counters for one credential over a window.
 *
 * @param {string} keyId
 * @param {object} [options]
 * @param {number} [options.minutes]
 * @returns {Promise<object>}
 */
async function summary(keyId, { minutes = DEFAULT_WINDOW_MINUTES } = {}) {
  const window = Math.min(Math.max(parseInt(minutes, 10) || DEFAULT_WINDOW_MINUTES, 1), 1440);
  const since = new Date(Date.now() - window * 60000).toISOString();
  const rows = await db.all(
    'SELECT * FROM developer_key_usage WHERE key_id = ? AND bucket_start >= ? ORDER BY bucket_start DESC',
    [keyId, since]
  );

  const totals = { requests: 0, succeeded: 0, clientErrors: 0, serverErrors: 0 };
  const byRoute = new Map();
  let lastFailure = null;

  for (const row of rows) {
    const requests = Number(row.requests || 0);
    const succeeded = Number(row.succeeded || 0);
    const clientErrors = Number(row.client_errors || 0);
    const serverErrors = Number(row.server_errors || 0);
    totals.requests += requests;
    totals.succeeded += succeeded;
    totals.clientErrors += clientErrors;
    totals.serverErrors += serverErrors;

    const route = byRoute.get(row.route) || { route: row.route, requests: 0, succeeded: 0, clientErrors: 0, serverErrors: 0 };
    route.requests += requests;
    route.succeeded += succeeded;
    route.clientErrors += clientErrors;
    route.serverErrors += serverErrors;
    byRoute.set(row.route, route);

    const errors = clientErrors + serverErrors;
    if (errors > 0 && (!lastFailure || row.bucket_start > lastFailure.at)) {
      lastFailure = { at: row.bucket_start, route: row.route, errors };
    }
  }

  return {
    windowMinutes: window,
    totals,
    byRoute: [...byRoute.values()].sort((a, b) => b.requests - a.requests),
    lastFailure,
  };
}

module.exports = { record, summary, DEFAULT_WINDOW_MINUTES };
