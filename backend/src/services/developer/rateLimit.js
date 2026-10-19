// Per-credential rate limiting.
//
// The same shape as middleware/ratelimit.js - a windowed in-memory bucket per
// caller, a Retry-After header and the RATE_LIMITED envelope - but the limit
// belongs to the credential rather than to the route, so it is read from the
// credential and not from a constant.
//
// In-memory, like the rest of the limiter, because the bucket belongs to one
// credential and one process. A deployment that runs more than one API process
// keeps one bucket per process, which is the same limitation the existing
// limiter has and the same way to fix it: put the buckets in a shared store.
const { fail } = require('../../errors');

const WINDOW_MS = 60000;
const buckets = new Map();

function bucketFor(principal) {
  return 'developer|' + principal.id;
}

/**
 * The middleware. A session is not limited here: the per-route limits already
 * cover an authenticated person, and a session has no limit of its own to
 * honour.
 */
function keyRateLimit() {
  return (req, res, next) => {
    const principal = req.principal;
    if (!principal || principal.kind === 'session' || !principal.rateLimit) return next();

    const nowMs = Date.now();
    const bucket = bucketFor(principal);
    let entry = buckets.get(bucket);
    if (!entry || nowMs - entry.start >= WINDOW_MS) {
      entry = { start: nowMs, count: 0 };
      buckets.set(bucket, entry);
    }
    entry.count += 1;

    // Opportunistic cleanup, so the map cannot grow without bound.
    if (buckets.size > 5000 && Math.random() < 0.01) {
      for (const [key, value] of buckets) {
        if (nowMs - value.start >= WINDOW_MS) buckets.delete(key);
      }
    }

    if (entry.count > principal.rateLimit) {
      const retryAfter = Math.ceil((entry.start + WINDOW_MS - nowMs) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      return fail(res, 'RATE_LIMITED', 'slow down. Try again shortly');
    }
    return next();
  };
}

/**
 * The state of one bucket, for the diagnostics endpoint.
 *
 * @param {object} principal
 * @returns {{limit: number, used: number, resetsInSeconds: number}}
 */
function stateOf(principal) {
  const entry = buckets.get(bucketFor(principal));
  const nowMs = Date.now();
  if (!entry) return { limit: principal.rateLimit, used: 0, resetsInSeconds: 0 };
  if (nowMs - entry.start >= WINDOW_MS) {
    return { limit: principal.rateLimit, used: 0, resetsInSeconds: 0 };
  }
  return {
    limit: principal.rateLimit,
    used: entry.count,
    resetsInSeconds: Math.ceil((entry.start + WINDOW_MS - nowMs) / 1000),
  };
}

module.exports = { keyRateLimit, stateOf, WINDOW_MS };
