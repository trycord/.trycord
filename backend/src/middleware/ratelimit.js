// Tiny in-memory rate limiter for abuse-prone endpoints (DM sends, friend
// requests, user search). Single-process only: each server instance tracks
// its own callers, which is all a self-hosted Trycord needs. For multi-node
// deployments replace with a shared store; the middleware signature stays.
//
// Usage: app.use('/api/dms', rateLimit({ windowMs: 60_000, max: 60 }));
//
// The bucket is keyed by the router the request landed on (`req.baseUrl`), so every
// rate-limited route in one router shares a budget. A route that needs its own budget
// - because its cost is not the router's cost - passes `key`, which replaces the
// router name in the key and leaves every other route on that router untouched.
const { fail } = require('../errors');

const buckets = new Map();

// RATE_LIMIT_MAX raises every per-endpoint ceiling to one value, and the
// configuration centre's limits.rateMax writes through to the same setting.
//
// Unset in normal operation, so each endpoint keeps its own tuned limit. It
// exists for the E2E suites, which share a single process-wide bucket per client
// address and cannot otherwise run as a suite, and for private-network
// deployments where several people share one egress address.
//
// The settings store is asked first because it owns the precedence, so a value
// saved in the dashboard wins over the default but still loses to an explicit
// RATE_LIMIT_MAX in the environment.
function maxFor(max) {
  const features = require('../features');
  const fromSettings = features.current.rateLimitMax;
  if (fromSettings > 0) return fromSettings;
  const override = parseInt(process.env.RATE_LIMIT_MAX || '', 10);
  return Number.isFinite(override) && override > 0 ? override : max;
}

function keyFor(req, bucket) {
  const user = (req.user && req.user.id) || 'anon';
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  return `${bucket || req.baseUrl || ''}|${user}|${ip}`;
}

// A bucket named by the request rather than by the route.
//
// Some routes are cheap for one caller and expensive for another: a peer
// prekey bundle is a public key the caller is entitled to, but every fetch
// consumes a one-time prekey, so a caller that fetches in a loop empties a
// device's pool and forces it onto the reusable fallback. Keying the bucket by
// the thing being fetched is what stops that, and the per-caller identity
// stays in the key so one reader cannot spend another's pool either.
function keyByFor(req, keyBy, fallback) {
  if (typeof keyBy !== 'function') return fallback;
  let named = null;
  try {
    named = String(keyBy(req) || '').trim();
  } catch {
    named = null;
  }
  if (!named) return fallback;
  return `${fallback}|${named}`;
}

function rateLimit({ windowMs = 60000, max = 60, key, keyBy } = {}) {
  const limit = maxFor(max);
  return (req, res, next) => {
    const nowMs = Date.now();
    const bucket = keyByFor(req, keyBy, keyFor(req, key));
    let entry = buckets.get(bucket);
    if (!entry || nowMs - entry.start >= windowMs) {
      entry = { start: nowMs, count: 0 };
      buckets.set(bucket, entry);
    }
    entry.count += 1;
    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size > 5000 && Math.random() < 0.01) {
      for (const [k, v] of buckets) {
        if (nowMs - v.start >= windowMs) buckets.delete(k);
      }
    }
    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.start + windowMs - nowMs) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      return fail(res, 'RATE_LIMITED', 'slow down. Try again shortly');
    }
    next();
  };
}

module.exports = rateLimit;
