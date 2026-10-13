'use strict';

// The state machine and scheduler.
//
// A monitor is a set of targets, each with a short history of recent results and a
// derived state. The state comes from real samples only: no estimated uptime, no
// invented data. Thresholds are configurable so a flapping service and a slow one
// are described differently instead of both being called "down".

const { runCheck } = require('./checks');
const { resolveTargetUrl } = require('./config');

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function createMonitor(config, deps) {
  const check = (deps && deps.runCheck) || runCheck;
  const now = (deps && deps.now) || (() => Date.now());

  const targets = config.targets.map((t) => Object.assign({}, t, {
    history: [],
    state: 'unknown',
    since: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastCheck: null,
    lastError: null,
  }));

  let startedAt = null;
  let timer = null;
  let ticking = null;
  let overall = 'unknown';
  let overallSince = null;

  function applyResult(target, result) {
    const at = now();
    target.lastCheck = {
      at,
      ok: !!result.ok,
      ms: result.ms,
      status: result.status == null ? null : result.status,
      detail: result.ok ? null : (result.detail || result.error || 'check failed'),
    };
    target.history.push({ at, ok: !!result.ok, ms: result.ms });
    if (target.history.length > config.history) {
      target.history.splice(0, target.history.length - config.history);
    }

    if (result.ok) {
      target.consecutiveSuccesses += 1;
      target.consecutiveFailures = 0;
    } else {
      target.consecutiveFailures += 1;
      target.consecutiveSuccesses = 0;
    }

    const slowMs = target.slowMs || config.slowMs;
    let next;
    if (target.consecutiveFailures >= config.failureThreshold) {
      next = 'down';
    } else if (!result.ok) {
      // One failure below the threshold is a warning, not an outage: it is the
      // state that a single dropped packet or a restart produces.
      next = 'degraded';
    } else if (result.ms > slowMs) {
      next = 'degraded';
    } else {
      next = 'up';
    }

    if (next !== target.state) {
      target.state = next;
      target.since = now();
    }
    target.lastError = result.ok ? null : (target.lastCheck.detail || 'check failed');
  }

  async function checkTarget(target) {
    let result;
    try {
      result = await check(target, { timeoutMs: config.timeoutMs, baseUrl: config.baseUrl });
    } catch (err) {
      result = { ok: false, ms: 0, error: err.message };
    }
    if (!result || typeof result !== 'object') result = { ok: false, ms: 0 };
    if (typeof result.ms !== 'number') result.ms = 0;
    if (typeof result.ok !== 'boolean') result.ok = false;
    applyResult(target, result);
    return result;
  }

  function computeOverall() {
    const states = targets.map((t) => t.state);
    if (!states.length) return 'unknown';
    if (states.every((s) => s === 'unknown')) return 'unknown';
    if (states.indexOf('down') !== -1) return 'down';
    if (states.indexOf('degraded') !== -1) return 'degraded';
    // A target that has never reported is a gap in visibility, not a green light.
    if (states.indexOf('unknown') !== -1) return 'degraded';
    return 'up';
  }

  // Returns the in-flight sweep when one is already running, so a caller that
  // awaits a tick always awaits a completed pass rather than a no-op.
  function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        const enabled = targets.filter((t) => t.enabled !== false);
        await Promise.all(enabled.map((t) => checkTarget(t)));
        const next = computeOverall();
        if (next !== overall) {
          overall = next;
          overallSince = now();
        }
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  }

  function start() {
    if (timer) return;
    startedAt = now();
    overallSince = startedAt;
    tick();
    timer = setInterval(() => { tick(); }, config.intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function windowOf(target) {
    const h = target.history;
    const okCount = h.reduce((n, r) => n + (r.ok ? 1 : 0), 0);
    return {
      samples: h.length,
      passed: okCount,
      from: iso(h.length ? h[0].at : null),
      to: iso(h.length ? h[h.length - 1].at : null),
      availability: h.length ? okCount / h.length : null,
    };
  }

  function report() {
    return {
      title: config.title,
      instance: config.instance,
      baseUrl: config.baseUrl,
      generatedAt: iso(now()),
      startedAt: iso(startedAt),
      intervalMs: config.intervalMs,
      overall,
      overallSince: iso(overallSince),
      components: targets.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        type: t.type,
        url: t.type === 'tcp' ? (t.host + ':' + t.port) : resolveTargetUrl(t, config.baseUrl),
        enabled: t.enabled !== false,
        state: t.state,
        since: iso(t.since),
        latencyMs: t.lastCheck ? t.lastCheck.ms : null,
        consecutiveFailures: t.consecutiveFailures,
        lastCheck: t.lastCheck ? {
          at: iso(t.lastCheck.at),
          ok: t.lastCheck.ok,
          ms: t.lastCheck.ms,
          status: t.lastCheck.status,
          detail: t.lastCheck.detail,
        } : null,
        lastError: t.lastError,
        window: windowOf(t),
      })),
    };
  }

  return {
    targets,
    start,
    stop,
    tick,
    computeOverall,
    report,
    getOverall: () => overall,
    startedAt: () => startedAt,
  };
}

module.exports = { createMonitor };
