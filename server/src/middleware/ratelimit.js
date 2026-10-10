// Rate limiting for abuse-prone endpoints.
//
// In-memory and single-process, which is all a self-hosted Trycord needs. For a
// multi-node deployment this is the one piece that would need a shared store; the
// middleware signature is designed so swapping it does not touch a route.

const { fail } = require('../http/errors');

const buckets = new Map();

// Raises every per-endpoint ceiling to one value. Unset in normal operation. It exists
// for the end-to-end suites, which share a single process-wide bucket per client address
// and cannot otherwise run as a suite.
const override = (() => {
  const n = parseInt(process.env.RATE_LIMIT_MAX || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

function limit({ windowMs = 60000, max = 60 } = {}) {
  const ceiling = override || max;
  return (req, res, next) => {
    const at = Date.now();
    const who = req.user ? req.user.id : (req.ip || 'anon');
    const key = `${req.baseUrl || ''}|${who}`;

    let entry = buckets.get(key);
    if (!entry || at - entry.start >= windowMs) {
      entry = { start: at, count: 0 };
      buckets.set(key, entry);
    }
    entry.count += 1;

    // Opportunistic cleanup, so the map cannot grow without bound.
    if (buckets.size > 5000 && Math.random() < 0.01) {
      for (const [k, v] of buckets) if (at - v.start >= windowMs) buckets.delete(k);
    }

    if (entry.count > ceiling) {
      const retryAfter = Math.ceil((entry.start + windowMs - at) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      return fail(res, 'RATE_LIMITED', 'slow down — try again shortly');
    }
    next();
  };
}

module.exports = limit;
