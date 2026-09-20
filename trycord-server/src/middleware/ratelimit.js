// Tiny in-memory rate limiter for abuse-prone endpoints (DM sends, friend
// requests, user search). Single-process only: each server instance tracks
// its own callers, which is all a self-hosted Trycord needs. For multi-node
// deployments replace with a shared store; the middleware signature stays.
//
// Usage: app.use('/api/dms', rateLimit({ windowMs: 60_000, max: 60 }));
const { fail } = require('../errors');

const buckets = new Map();

function keyFor(req) {
  const user = (req.user && req.user.id) || 'anon';
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  return `${req.baseUrl || ''}|${user}|${ip}`;
}

function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  return (req, res, next) => {
    const nowMs = Date.now();
    const key = keyFor(req);
    let entry = buckets.get(key);
    if (!entry || nowMs - entry.start >= windowMs) {
      entry = { start: nowMs, count: 0 };
      buckets.set(key, entry);
    }
    entry.count += 1;
    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size > 5000 && Math.random() < 0.01) {
      for (const [k, v] of buckets) {
        if (nowMs - v.start >= windowMs) buckets.delete(k);
      }
    }
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.start + windowMs - nowMs) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      return fail(res, 'RATE_LIMITED', 'slow down — try again shortly');
    }
    next();
  };
}

module.exports = rateLimit;
